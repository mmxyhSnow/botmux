/** 自定义候选版本冻结执行器：在账本指定的 custom/dev checkout 运行既有发布门禁。 */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import type { CustomReleaseEventRecord } from '../services/custom-release-event.js';
import { StaleCustomReleaseHeadError, type CustomReleaseFreezeResult } from './custom-release-notifier.js';

const RESULT_PREFIX = 'BOTMUX_CUSTOM_RELEASE_RESULT=';
const MAX_TAIL = 64 * 1024;

interface CommandResult {
  code: number;
  output: string;
}

export interface CustomReleaseFreezeDeps {
  run: (command: string, args: string[], cwd: string) => Promise<CommandResult>;
  exists: (path: string) => boolean;
  realpath: (path: string) => string;
}

function appendTail(current: string, chunk: Buffer | string): string {
  const next = current + String(chunk);
  return next.length <= MAX_TAIL ? next : next.slice(-MAX_TAIL);
}

/** 无 shell 执行并只保留日志尾部，避免全量测试输出撑爆 daemon 内存。 */
function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', chunk => { output = appendTail(output, chunk); });
    child.stderr?.on('data', chunk => { output = appendTail(output, chunk); });
    child.once('error', reject);
    child.once('close', code => resolve({ code: code ?? 1, output }));
  });
}

async function remoteIntegrationHead(
  repoRoot: string,
  run: CustomReleaseFreezeDeps['run'],
): Promise<string> {
  const result = await run('git', ['ls-remote', 'origin', 'refs/heads/custom/dev'], repoRoot);
  if (result.code !== 0) throw new Error(`无法回读远端 custom/dev：${result.output.trim().slice(-1000)}`);
  const head = result.output.trim().split(/\s+/)[0] ?? '';
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('远端 custom/dev HEAD 格式无效');
  return head;
}

function parsePrepareResult(output: string): Record<string, unknown> {
  const line = output.split(/\r?\n/).reverse().find(item => item.startsWith(RESULT_PREFIX));
  if (!line) throw new Error(`冻结命令没有结构化终态：${output.trim().slice(-1000)}`);
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length)) as Record<string, unknown>;
  } catch {
    throw new Error('冻结命令返回的结构化终态无效');
  }
}

/**
 * 冻结前、脚本内部测试后都会核对 expected HEAD；任何新合入都只让旧卡过期。
 * 本执行器不推进 custom/prod、不部署，也不重启 daemon。
 */
export async function runCustomReleaseFreeze(
  record: CustomReleaseEventRecord,
  deps: CustomReleaseFreezeDeps = { run: runCommand, exists: existsSync, realpath: realpathSync },
): Promise<CustomReleaseFreezeResult> {
  const repoRoot = record.event.repoRoot;
  if (!deps.exists(repoRoot) || deps.realpath(repoRoot) !== repoRoot) {
    throw new Error('发版事件记录的 custom/dev checkout 不存在或不是规范路径');
  }
  const expectedHead = record.event.integration.head;
  if (await remoteIntegrationHead(repoRoot, deps.run) !== expectedHead) {
    throw new StaleCustomReleaseHeadError('远端 custom/dev 已有新合入，请使用最新私聊卡');
  }
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = await deps.run(pnpm, [
    'release:prepare',
    '--',
    '--expected-head', expectedHead,
    '--expected-version', record.event.release.pendingVersion,
  ], repoRoot);
  if (result.code !== 0) {
    if (await remoteIntegrationHead(repoRoot, deps.run) !== expectedHead) {
      throw new StaleCustomReleaseHeadError('冻结验证期间 custom/dev 已变化，未创建候选标签');
    }
    throw new Error(`冻结门禁失败：${result.output.trim().slice(-2000)}`);
  }
  const payload = parsePrepareResult(result.output);
  const expectedTag = `release/v${record.event.release.pendingVersion}`;
  if (
    payload.ok !== true
    || payload.action !== 'prepare'
    || payload.integrationHead !== expectedHead
    || payload.candidateTag !== expectedTag
  ) throw new Error('冻结结果与卡片绑定的版本或 HEAD 不一致');
  return { candidateTag: expectedTag };
}
