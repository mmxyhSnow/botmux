/**
 * Codex App 原生选择到 Botmux ask 的集成测试。
 *
 * 通过真实 runner 子进程和本地 HTTP daemon 替身验证协议边界，不伪造 runner 内部方法。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeRunnerInput } from '../src/adapters/cli/runner-input.js';

const RUNNER_PATH = resolve('src/codex-app-runner.ts');
const FAKE_SERVER_FIXTURE = resolve('test/fixtures/fake-codex-app-server.mjs');
const CONTROL_PREFIX = '::botmux-codex-app:';
const FINAL_MARKER = /\x1b\]777;botmux:final:([A-Za-z0-9+/=]+)\x07/;
const liveChildren = new Set<ChildProcessWithoutNullStreams>();

interface Harness {
  child: ChildProcessWithoutNullStreams;
  readonly stdout: string;
  readonly stderr: string;
}

function startRunner(
  fakeCodex: string,
  cwd: string,
  logPath: string,
  extraEnv: NodeJS.ProcessEnv,
): Harness {
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, [
    '--import', 'tsx', RUNNER_PATH,
    '--session-id', 'session-integration',
    '--codex-bin', fakeCodex,
    '--cwd', cwd,
  ], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      FAKE_CODEX_LOG: logPath,
      FAKE_CODEX_VERSION: '0.146.0',
      FAKE_CODEX_BEHAVIOR: 'request-user-input',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  liveChildren.add(child);
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  child.once('exit', () => liveChildren.delete(child));
  return {
    child,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

function waitForOutput(
  harness: Harness,
  predicate: (output: string) => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  if (predicate(harness.stdout)) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`runner output timed out\n${harness.stdout}\n${harness.stderr}`));
    }, timeoutMs);
    const onData = () => {
      if (!predicate(harness.stdout)) return;
      cleanup();
      resolvePromise();
    };
    const onExit = () => {
      cleanup();
      rejectPromise(new Error(`runner exited before expected output\n${harness.stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      harness.child.stdout.off('data', onData);
      harness.child.off('exit', onExit);
    };
    harness.child.stdout.on('data', onData);
    harness.child.once('exit', onExit);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolvePromise => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
    child.kill('SIGTERM');
  });
}

function readRequests(logPath: string): Array<Record<string, any>> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function decodeFinal(output: string): Record<string, any> {
  const match = output.match(FINAL_MARKER);
  if (!match) throw new Error('final marker missing');
  return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
}

function runnerEnv(port: number, dir: string): NodeJS.ProcessEnv {
  return {
    BOTMUX_DAEMON_IPC_PORT: String(port),
    BOTMUX_CHAT_ID: 'oc_chat',
    BOTMUX_CHAT_TYPE: 'group',
    BOTMUX_LARK_APP_ID: 'cli_app',
    BOTMUX_ROOT_MESSAGE_ID: 'om_root',
    SESSION_DATA_DIR: dir,
  };
}

afterEach(async () => {
  await Promise.all([...liveChildren].map(stopChild));
});

describe('Codex App request_user_input bridge', () => {
  it('失败时打断当前 turn，不用空答案继续', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-user-input-failure-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const daemon = createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('card dispatch failed');
    });
    await new Promise<void>(resolvePromise => daemon.listen(0, '127.0.0.1', resolvePromise));
    const address = daemon.address();
    if (!address || typeof address === 'string') throw new Error('fake daemon 未绑定端口');
    const harness = startRunner(fakeCodex, dir, logPath, runnerEnv(address.port, dir));

    try {
      await waitForOutput(harness, output => output.includes('Codex App connected.'));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('请确认', undefined, 'om_failure')}\r`);
      await waitForOutput(harness, output => output.includes('request_user_input failed'));
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      const requests = readRequests(logPath);
      expect(requests).toContainEqual({
        jsonrpc: '2.0',
        id: expect.any(Number),
        method: 'turn/interrupt',
        params: { threadId: 'thread-fake', turnId: 'turn-fake-1' },
      });
      expect(requests.find(request => request.id === 9100 && request.result)).toBeUndefined();
    } finally {
      await stopChild(harness.child);
      await new Promise<void>(resolvePromise => daemon.close(() => resolvePromise()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('点击答案回填同一 turn，并把 ask 锁到本轮提问对象', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-user-input-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    const argsLogPath = join(dir, 'args.json');
    const fakeHome = join(dir, 'home');
    mkdirSync(join(fakeHome, '.botmux'), { recursive: true });
    writeFileSync(join(fakeHome, '.botmux', '.dashboard-secret'), 'test-dashboard-secret');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const askBodies: Array<Record<string, any>> = [];
    const askAuthHeaders: Array<string | undefined> = [];
    const requestPaths: string[] = [];
    const daemon = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        requestPaths.push(req.url ?? '');
        askBodies.push(JSON.parse(body));
        askAuthHeaders.push(
          typeof req.headers['x-botmux-cli-auth'] === 'string'
            ? req.headers['x-botmux-cli-auth']
            : undefined,
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.url === '/api/ask-flows/complete'
          ? { ok: true, completed: true }
          : {
              kind: 'answered',
              answers: [['执行']],
              by: 'ou_requester',
              comment: null,
              timedOut: false,
            }));
      });
    });
    await new Promise<void>(resolvePromise => daemon.listen(0, '127.0.0.1', resolvePromise));
    const address = daemon.address();
    if (!address || typeof address === 'string') throw new Error('fake daemon 未绑定端口');
    const harness = startRunner(fakeCodex, dir, logPath, {
      ...runnerEnv(address.port, dir),
      FAKE_CODEX_ARGS_LOG: argsLogPath,
      HOME: fakeHome,
    });

    try {
      await waitForOutput(harness, output => output.includes('Codex App connected.'));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('请执行', undefined, 'om_choice')}\r`);
      await waitForOutput(harness, output => FINAL_MARKER.test(output));
      expect(JSON.parse(readFileSync(argsLogPath, 'utf8'))).toEqual([
        'app-server', '--enable', 'default_mode_request_user_input', '--listen', 'stdio://',
      ]);
      const startRequest = readRequests(logPath).find(request => request.method === 'thread/start');
      expect(startRequest?.params?.developerInstructions).toContain('shared-understanding summary');
      expect(startRequest?.params?.developerInstructions).toContain('<!--botmux-progress:');
      expect(startRequest?.params?.developerInstructions).toContain('new evidence, a stage change, or a real blocker');
      expect(startRequest?.params?.developerInstructions).toContain('validation evidence, delivery, remaining risks, and the terminal `external` job statuses');
      expect(askBodies[0]).toMatchObject({
        sessionId: 'session-integration',
        flowId: 'turn-fake-1',
        timeoutMs: 270_000,
        lockToTurnCaller: true,
        questions: [{
          prompt: '是否按当前方案执行？',
          multiSelect: false,
          options: [{ key: '执行', label: '执行' }, { key: '取消', label: '取消' }],
        }],
      });
      expect(askAuthHeaders[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(decodeFinal(harness.stdout)).toMatchObject({
        appTurnId: 'turn-fake-1',
        replyTurnId: 'om_choice',
        content: 'selected=执行',
      });
      expect(readRequests(logPath).find(request => request.id === 9100)?.result).toEqual({
        answers: { choice: { answers: ['执行'] } },
      });
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      expect(requestPaths).toContain('/api/ask-flows/complete');
      expect(askBodies.find((_body, index) => requestPaths[index] === '/api/ask-flows/complete'))
        .toMatchObject({ sessionId: 'session-integration', flowId: 'turn-fake-1' });
    } finally {
      await stopChild(harness.child);
      await new Promise<void>(resolvePromise => daemon.close(() => resolvePromise()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('撤销动作回灌为重新提出上一问的系统指令', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-user-input-undo-'));
    const fakeCodex = join(dir, 'fake-codex');
    const logPath = join(dir, 'requests.jsonl');
    copyFileSync(FAKE_SERVER_FIXTURE, fakeCodex);
    chmodSync(fakeCodex, 0o755);
    const daemon = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          kind: 'answered',
          answers: [[]],
          by: 'ou_requester',
          comment: null,
          action: 'undo',
          timedOut: false,
        }));
      });
    });
    await new Promise<void>(resolvePromise => daemon.listen(0, '127.0.0.1', resolvePromise));
    const address = daemon.address();
    if (!address || typeof address === 'string') throw new Error('fake daemon 未绑定端口');
    const harness = startRunner(fakeCodex, dir, logPath, runnerEnv(address.port, dir));

    try {
      await waitForOutput(harness, output => output.includes('Codex App connected.'));
      harness.child.stdin.write(`${CONTROL_PREFIX}${encodeRunnerInput('继续访谈', undefined, 'om_undo')}\r`);
      await waitForOutput(harness, output => FINAL_MARKER.test(output));
      const response = readRequests(logPath).find(request => request.id === 9100)?.result;
      expect(response).toEqual({
        answers: {
          choice: {
            answers: ['[系统] 用户撤销了上一问，请重新提出上一题并按新答案重算后续分支。'],
          },
        },
      });
      const start = readRequests(logPath).find(request => request.method === 'thread/start');
      expect(start?.params?.developerInstructions).toContain('undid the previous answer');
      expect(decodeFinal(harness.stdout).content).toContain('用户撤销了上一问');
    } finally {
      await stopChild(harness.child);
      await new Promise<void>(resolvePromise => daemon.close(() => resolvePromise()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
