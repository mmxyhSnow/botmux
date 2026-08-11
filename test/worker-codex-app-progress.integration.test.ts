import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

/**
 * 文件职责：覆盖 Codex App commentary 从 runner 签名协议穿过 worker 到 daemon IPC 的真实链路。
 * 来源：生产故障中 worker 拒绝 progress marker，导致控制连接断开和 runner 启动失败。
 */
const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();

/** 关闭测试 worker，保证控制 socket 和子进程不会泄漏到后续用例。 */
async function stopWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolvePromise => {
    const forceTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    child.once('exit', () => {
      clearTimeout(forceTimer);
      resolvePromise();
    });
    if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker);
    else child.kill('SIGTERM');
  });
}

/** 等待真实 worker 产出目标 IPC，提前退出时携带日志暴露协议错误。 */
function waitFor(
  child: ChildProcess,
  logs: string[],
  predicate: () => boolean,
  timeoutMs = 12_000,
): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const poll = setInterval(() => {
      if (!predicate()) return;
      cleanup();
      resolvePromise();
    }, 20);
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`worker progress timeout\n${logs.join('')}`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      rejectPromise(new Error(`worker exited early (${code ?? signal})\n${logs.join('')}`));
    };
    const cleanup = () => {
      clearInterval(poll);
      clearTimeout(timer);
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

afterEach(async () => {
  await Promise.all([...children].map(stopWorker));
  children.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe('Codex App worker progress delivery', () => {
  it('forwards signed commentary progress and keeps the runner alive through the final', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-codex-progress-'));
    tempDirs.add(root);
    const fakeCodex = join(root, 'fake-codex');
    copyFileSync(resolve('test/fixtures/fake-codex-app-server.mjs'), fakeCodex);
    chmodSync(fakeCodex, 0o755);

    const sessionId = `codex-progress-${process.pid}-${Date.now()}`;
    const logs: string[] = [];
    const messages: WorkerToDaemon[] = [];
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        NODE_ENV: 'test',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=tsx'].filter(Boolean).join(' '),
        BOTMUX_TEST_CODEX_APP_RUNNER_PATH: resolve('src/codex-app-runner.ts'),
        SESSION_DATA_DIR: root,
        BOTMUX_SESSION_ID: sessionId,
        LARK_APP_ID: 'app_worker_progress',
        LARK_APP_SECRET: 'secret',
        FAKE_CODEX_VERSION: '0.146.0',
        FAKE_CODEX_BEHAVIOR: 'commentary-progress',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.on('message', raw => messages.push(raw as WorkerToDaemon));

    const turnId = 'om_worker_progress_1';
    child.send({
      type: 'init',
      sessionId,
      chatId: 'oc_worker_progress',
      rootMessageId: 'om_worker_progress_root',
      workingDir: resolve('.'),
      cliId: 'codex-app',
      cliPathOverride: fakeCodex,
      backendType: 'pty',
      prompt: '<user_message>progress turn</user_message>',
      promptCodexAppInput: { text: 'progress turn', clientUserMessageId: turnId },
      larkAppId: 'app_worker_progress',
      larkAppSecret: 'secret',
      turnId,
    } satisfies DaemonToWorker);

    await waitFor(child, logs, () => (
      messages.filter(message => message.type === 'progress_output').length === 2
      && messages.some(message => message.type === 'final_output')
    ));

    expect(messages.filter(
      (message): message is Extract<WorkerToDaemon, { type: 'progress_output' }> => (
        message.type === 'progress_output'
      ),
    )).toEqual([
      { type: 'progress_output', content: '已锁定根因。', turnId },
      {
        type: 'progress_output',
        content: '<!--botmux-progress:{"title":"修复进度","stage":"定位","current":"补回投递"}-->',
        turnId,
      },
    ]);
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'final_output',
      content: 'fake answer 1',
      turnId,
    }));
  }, 15_000);
});
