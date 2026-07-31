/** 自定义候选版本推进执行器：只把卡片绑定的候选提交快进到远端生产分支。 */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import type { CustomReleaseEventRecord } from '../services/custom-release-event.js';
import type { CustomReleasePromoteResult } from './custom-release-notifier-types.js';

const RESULT_PREFIX = 'BOTMUX_CUSTOM_RELEASE_RESULT=';
const MAX_TAIL = 64 * 1024;
const RELEASE_TAG = /^release\/v\d+\.\d+\.\d+-custom\.\d+$/;

interface CommandResult {
  code: number;
  output: string;
}

export interface CustomReleasePromoteDeps {
  run: (command: string, args: string[], cwd: string) => Promise<CommandResult>;
  exists: (path: string) => boolean;
  realpath: (path: string) => string;
}

function appendTail(current: string, chunk: Buffer | string): string {
  const next = current + String(chunk);
  return next.length <= MAX_TAIL ? next : next.slice(-MAX_TAIL);
}

/** 无 shell 执行发布入口，并限制捕获日志大小。 */
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

/** 回读受控远端分支，避免卡片基于过期生产状态执行写入。 */
async function remoteBranchHead(
  repoRoot: string,
  branch: 'custom/prod',
  run: CustomReleasePromoteDeps['run'],
): Promise<string> {
  const result = await run('git', ['ls-remote', 'origin', `refs/heads/${branch}`], repoRoot);
  if (result.code !== 0) throw new Error(`无法回读远端 ${branch}：${result.output.trim().slice(-1000)}`);
  const head = result.output.trim().split(/\s+/)[0] ?? '';
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error(`远端 ${branch} HEAD 格式无效`);
  return head;
}

function parsePromoteResult(output: string): Record<string, unknown> {
  const line = output.split(/\r?\n/).reverse().find(item => item.startsWith(RESULT_PREFIX));
  if (!line) throw new Error(`推进命令没有结构化终态：${output.trim().slice(-1000)}`);
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length)) as Record<string, unknown>;
  } catch {
    throw new Error('推进命令返回的结构化终态无效');
  }
}

/**
 * 推进前要求生产分支仍是卡片记录的基线，重复点击时也接受已到达候选 HEAD。
 * 本执行器不切换本机 wrapper、不部署，也不重启 daemon。
 */
export async function runCustomReleasePromote(
  record: CustomReleaseEventRecord,
  deps: CustomReleasePromoteDeps = { run: runCommand, exists: existsSync, realpath: realpathSync },
): Promise<CustomReleasePromoteResult> {
  const repoRoot = record.event.repoRoot;
  if (!deps.exists(repoRoot) || deps.realpath(repoRoot) !== repoRoot) {
    throw new Error('发版事件记录的 custom/dev checkout 不存在或不是规范路径');
  }
  const releaseTag = record.state.candidateTag ?? '';
  if (!RELEASE_TAG.test(releaseTag)) throw new Error('卡片没有有效的候选版本标签');
  const expectedHead = record.event.integration.head;
  const before = await remoteBranchHead(repoRoot, 'custom/prod', deps.run);
  if (before !== record.event.production.head && before !== expectedHead) {
    throw new Error(`远端 custom/prod 已由其它发布推进：${before.slice(0, 8)}`);
  }
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = await deps.run(pnpm, [
    'release:promote', '--', '--tag', releaseTag,
  ], repoRoot);
  if (result.code !== 0) throw new Error(`推进生产失败：${result.output.trim().slice(-2000)}`);
  const payload = parsePromoteResult(result.output);
  if (
    payload.ok !== true
    || payload.action !== 'promote'
    || payload.releaseTag !== releaseTag
    || payload.commit !== expectedHead
  ) throw new Error('推进结果与卡片绑定的候选版本或 HEAD 不一致');
  if (await remoteBranchHead(repoRoot, 'custom/prod', deps.run) !== expectedHead) {
    throw new Error('推进后远端 custom/prod 回读不一致');
  }
  return { productionHead: expectedHead };
}
