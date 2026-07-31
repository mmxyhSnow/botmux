/**
 * 候选版本一键部署执行器。
 * 卡片点击后推进远端生产分支、更新 canonical 生产 checkout、构建并切换 wrapper；
 * 新 daemon 启动后再验收真实运行 checkout，最后记录同号 deploy 标签。
 */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import type { CustomReleaseEventRecord } from '../services/custom-release-event.js';
import {
  claimRestartLease,
  clearRestartIntent,
  clearRestartLease,
  writeRestartIntent,
} from '../services/restart-intent-store.js';
import { botmuxInstallRoot } from '../utils/install-info.js';
import { withFileLockSync } from '../utils/file-lock.js';
import {
  globalInstallUpdateLockTarget,
  spawnDetachedRestart,
} from './maintenance.js';
import { runCustomReleasePromote } from './custom-release-promote.js';
import type { CustomReleaseDeployResult } from './custom-release-notifier-types.js';

const RESULT_PREFIX = 'BOTMUX_CUSTOM_RELEASE_RESULT=';
const RELEASE_TAG = /^release\/v\d+\.\d+\.\d+-custom\.\d+$/;
const MAX_TAIL = 64 * 1024;

interface CommandResult {
  code: number;
  output: string;
}

export interface CustomReleaseDeployDeps {
  run: (command: string, args: string[], cwd: string) => Promise<CommandResult>;
  promote: (record: CustomReleaseEventRecord) => Promise<{ productionHead: string }>;
  exists: (path: string) => boolean;
  realpath: (path: string) => string;
  activePackageRoot: () => string;
  startRestart: (productionRoot: string, releaseTag: string) => void;
}

function appendTail(current: string, chunk: Buffer | string): string {
  const next = current + String(chunk);
  return next.length <= MAX_TAIL ? next : next.slice(-MAX_TAIL);
}

/** 无 shell 执行受控命令，并只保留足够诊断失败的尾部日志。 */
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

function commandError(label: string, result: CommandResult): never {
  throw new Error(`${label}：${result.output.trim().slice(-2000) || `exit ${result.code}`}`);
}

async function checkedRun(
  deps: CustomReleaseDeployDeps,
  label: string,
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  const result = await deps.run(command, args, cwd);
  if (result.code !== 0) commandError(label, result);
  return result.output.trim();
}

/** 从 Git 登记信息中精确找出唯一的 custom/prod worktree，不猜目录名。 */
async function productionWorktree(
  record: CustomReleaseEventRecord,
  deps: CustomReleaseDeployDeps,
): Promise<string> {
  const output = await checkedRun(
    deps,
    '无法读取 worktree 登记',
    'git',
    ['worktree', 'list', '--porcelain'],
    record.event.repoRoot,
  );
  const roots = output.split(/\n\s*\n/).flatMap(block => {
    const lines = block.split(/\r?\n/);
    const worktree = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length);
    const branch = lines.find(line => line.startsWith('branch '))?.slice('branch '.length);
    return worktree && branch === 'refs/heads/custom/prod' ? [worktree] : [];
  });
  if (roots.length !== 1) throw new Error(`必须且只能登记一个 custom/prod worktree，当前为 ${roots.length} 个`);
  if (!deps.exists(roots[0])) throw new Error('登记的 custom/prod worktree 不存在');
  return deps.realpath(roots[0]);
}

function candidateTag(record: CustomReleaseEventRecord): string {
  const tag = record.state.candidateTag ?? '';
  if (!RELEASE_TAG.test(tag)) throw new Error('卡片没有有效的候选版本标签');
  return tag;
}

/** 写入维护原因并用现有 setsid 驱动脱离当前 daemon 发起重启。 */
function startDetachedRestart(productionRoot: string, releaseTag: string): void {
  let leaseId: string | undefined;
  try {
    withFileLockSync(globalInstallUpdateLockTarget(), () => {
      leaseId = claimRestartLease() ?? undefined;
      if (!leaseId) throw new Error('已有其它重启任务占用维护锁');
      writeRestartIntent({
        kind: 'manual',
        reason: `部署 ${releaseTag}（由 owner 私聊发版卡授权）`,
        source: 'ai',
        at: new Date().toISOString(),
      });
      const child = spawnDetachedRestart('custom-release-card', productionRoot, leaseId);
      if (!child.pid) throw new Error('重启驱动没有成功启动');
    }, { maxWaitMs: 500 });
  } catch (error) {
    clearRestartIntent();
    if (leaseId) clearRestartLease(leaseId);
    throw error;
  }
}

const PRODUCTION_DEPS: CustomReleaseDeployDeps = {
  run: runCommand,
  promote: record => runCustomReleasePromote(record),
  exists: existsSync,
  realpath: realpathSync,
  activePackageRoot: botmuxInstallRoot,
  startRestart: startDetachedRestart,
};

/**
 * 卡片点击后的前半程。所有会失败的 checkout 身份/clean 校验都先于远端推进；
 * 一旦 wrapper 切换成功便留下 deploying 状态，由重启后的同一事件继续验收。
 */
export async function runCustomReleaseDeployment(
  record: CustomReleaseEventRecord,
  deps: CustomReleaseDeployDeps = PRODUCTION_DEPS,
): Promise<void> {
  const releaseTag = candidateTag(record);
  const expectedHead = record.event.integration.head;
  const root = await productionWorktree(record, deps);
  const dirty = await checkedRun(deps, '无法检查生产 checkout', 'git', ['status', '--porcelain'], root);
  if (dirty) throw new Error('canonical custom/prod checkout 存在未提交改动，拒绝自动部署');

  const promoted = await deps.promote(record);
  if (promoted.productionHead !== expectedHead) throw new Error('推进结果与卡片绑定 HEAD 不一致');
  await checkedRun(deps, '生产 checkout fetch 失败', 'git', ['fetch', 'origin', '--prune', '--tags'], root);
  await checkedRun(deps, '生产 checkout 无法 fast-forward', 'git', ['merge', '--ff-only', 'origin/custom/prod'], root);
  const localHead = await checkedRun(deps, '无法回读生产 checkout HEAD', 'git', ['rev-parse', 'HEAD'], root);
  if (localHead !== expectedHead) throw new Error('生产 checkout HEAD 与候选版本不一致');

  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  await checkedRun(deps, '生产依赖安装失败', pnpm, ['install', '--frozen-lockfile'], root);
  await checkedRun(deps, '生产构建失败', pnpm, ['build'], root);
  await checkedRun(deps, '全局 wrapper 切换失败', pnpm, ['use:here'], root);
  deps.startRestart(root, releaseTag);
}

function parseDeployResult(output: string): Record<string, unknown> {
  const line = output.split(/\r?\n/).reverse().find(item => item.startsWith(RESULT_PREFIX));
  if (!line) throw new Error(`部署留痕命令没有结构化终态：${output.trim().slice(-1000)}`);
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length)) as Record<string, unknown>;
  } catch {
    throw new Error('部署留痕命令返回的结构化终态无效');
  }
}

/** 新 daemon 的后半程：只有真实运行 checkout 与候选 HEAD 一致时才写不可变 deploy 标签。 */
export async function finalizeCustomReleaseDeployment(
  record: CustomReleaseEventRecord,
  deps: CustomReleaseDeployDeps = PRODUCTION_DEPS,
): Promise<CustomReleaseDeployResult> {
  const releaseTag = candidateTag(record);
  const expectedHead = record.event.integration.head;
  const root = await productionWorktree(record, deps);
  if (deps.realpath(deps.activePackageRoot()) !== root) {
    throw new Error('新 daemon 实际执行路径不是 canonical custom/prod checkout');
  }
  const localHead = await checkedRun(deps, '无法回读运行 checkout HEAD', 'git', ['rev-parse', 'HEAD'], root);
  if (localHead !== expectedHead) throw new Error('新 daemon 运行 HEAD 与候选版本不一致');
  const remote = await checkedRun(
    deps,
    '无法回读远端 custom/prod',
    'git',
    ['ls-remote', 'origin', 'refs/heads/custom/prod'],
    root,
  );
  if (remote.split(/\s+/)[0] !== expectedHead) throw new Error('远端 custom/prod 与运行 HEAD 不一致');

  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = await deps.run(pnpm, ['release:record-deploy', '--', '--tag', releaseTag], root);
  if (result.code !== 0) commandError('部署留痕失败', result);
  const payload = parseDeployResult(result.output);
  const deployTag = `deploy/${releaseTag.slice('release/'.length)}`;
  if (
    payload.ok !== true
    || payload.action !== 'record-deploy'
    || payload.releaseTag !== releaseTag
    || payload.deployTag !== deployTag
    || payload.commit !== expectedHead
  ) throw new Error('部署留痕结果与卡片绑定的候选版本或 HEAD 不一致');
  return { productionHead: expectedHead, deployTag };
}
