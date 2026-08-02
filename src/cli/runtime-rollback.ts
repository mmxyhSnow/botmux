/**
 * `botmux rollback` 编排器：以已验收 deploy tag 为目标，原子切换 current 并重启验收。
 * 失败时自动切回原版本，禁止把机器留在半回滚状态。
 */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { reconcileProductionMaintenanceSkillAt } from '../core/production-skill-sync.js';
import {
  activateRuntimeRelease,
  listRuntimeReleases,
  readCurrentRuntimeRelease,
  selectPreviousRuntimeRelease,
  type RuntimeReleaseRecord,
} from '../core/runtime-release.js';
import {
  globalInstallUpdateLockTarget,
} from '../core/maintenance.js';
import {
  claimRestartLease,
  clearRestartLease,
  resolveRestartSource,
  writeRestartIntent,
} from '../services/restart-intent-store.js';
import { withFileLockSync } from '../utils/file-lock.js';

const MAX_TAIL = 64 * 1024;

interface CommandResult {
  code: number;
  output: string;
}

export interface RuntimeRollbackDeps {
  listReleases: () => RuntimeReleaseRecord[];
  currentRelease: () => RuntimeReleaseRecord | null;
  assertRemoteTag: (target: RuntimeReleaseRecord) => Promise<void>;
  activate: (targetRoot: string) => void;
  writeIntent: (from: RuntimeReleaseRecord, to: RuntimeReleaseRecord) => void;
  restart: (targetRoot: string) => Promise<void>;
  verify: (target: RuntimeReleaseRecord) => Promise<void>;
  alignSkill: (targetRoot: string) => Promise<void>;
}

export interface RuntimeRollbackResult {
  action: 'list' | 'rollback';
  releases: Array<{ deployTag: string; commit: string; root: string; current: boolean }>;
  from?: string;
  to?: string;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const capture = (chunk: Buffer | string): void => {
      output = (output + String(chunk)).slice(-MAX_TAIL);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', reject);
    child.once('close', code => resolve({ code: code ?? 1, output }));
  });
}

function configRoot(): string {
  const dataDir = config.session.dataDir;
  return dataDir.endsWith('/data') ? dataDir.slice(0, -'/data'.length) : join(homedir(), '.botmux');
}

async function assertRemoteDeployTag(target: RuntimeReleaseRecord): Promise<void> {
  const tag = target.manifest.deployTag;
  const result = await runCommand(
    'git',
    ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    target.root,
  );
  if (result.code !== 0) throw new Error(`无法回读远端 ${tag}：${result.output.trim().slice(-1000)}`);
  const lines = result.output.split(/\r?\n/);
  const commit = lines.find(line => line.endsWith(`refs/tags/${tag}^{}`))?.split(/\s+/)[0]
    ?? lines.find(line => line.endsWith(`refs/tags/${tag}`))?.split(/\s+/)[0]
    ?? '';
  if (commit !== target.manifest.commit) throw new Error(`${tag} 与运行目录 commit 不一致`);
}

function writeRollbackIntent(from: RuntimeReleaseRecord, to: RuntimeReleaseRecord): void {
  writeRestartIntent({
    kind: 'rollback',
    oldVersion: from.manifest.deployTag.slice('deploy/v'.length),
    newVersion: to.manifest.deployTag.slice('deploy/v'.length),
    reason: `回滚 ${from.manifest.deployTag} → ${to.manifest.deployTag}`,
    source: resolveRestartSource(undefined),
    at: new Date().toISOString(),
  });
}

async function restartRuntime(targetRoot: string): Promise<void> {
  let leaseId: string | undefined;
  withFileLockSync(globalInstallUpdateLockTarget(), () => {
    leaseId = claimRestartLease() ?? undefined;
    if (!leaseId) throw new Error('已有其它重启任务占用维护锁');
  }, { maxWaitMs: 500 });
  try {
    const result = await runCommand(
      process.execPath,
      [join(targetRoot, 'dist', 'cli.js'), 'restart'],
      homedir(),
      {
        ...process.env,
        BOTMUX_RESTART_LEASE_ID: leaseId,
        BOTMUX_RESTART_LEASE_DIR: config.session.dataDir,
      },
    );
    if (result.code !== 0) throw new Error(result.output.trim().slice(-2000) || `exit ${result.code}`);
  } finally {
    if (leaseId) clearRestartLease(leaseId);
  }
}

async function verifyRuntime(target: RuntimeReleaseRecord): Promise<void> {
  const pm2Bin = join(target.root, 'node_modules', 'pm2', 'bin', 'pm2');
  if (!existsSync(pm2Bin)) throw new Error('目标运行目录缺少 pm2 CLI');
  const result = await runCommand(process.execPath, [pm2Bin, 'jlist'], homedir(), {
    ...process.env,
    PM2_HOME: join(configRoot(), 'pm2'),
  });
  if (result.code !== 0) throw new Error(`PM2 回读失败：${result.output.trim().slice(-1000)}`);
  let apps: Array<Record<string, unknown>>;
  try { apps = JSON.parse(result.output) as Array<Record<string, unknown>>; }
  catch { throw new Error('PM2 回读不是有效 JSON'); }
  const core = apps.filter(app => {
    const name = String(app.name ?? '');
    return name === 'botmux' || (name.startsWith('botmux-') && !name.startsWith('botmux-plugin-'));
  });
  if (core.length < 2) throw new Error('PM2 核心进程数量不足');
  const expectedDist = realpathSync(join(target.root, 'dist'));
  for (const app of core) {
    const env = app.pm2_env as Record<string, unknown> | undefined;
    const path = typeof env?.pm_exec_path === 'string' ? env.pm_exec_path : '';
    if (env?.status !== 'online' || !path || !realpathSync(path).startsWith(`${expectedDist}/`)) {
      throw new Error(`PM2 进程未运行目标版本：${String(app.name ?? 'unknown')}`);
    }
  }
}

async function alignMaintenanceSkill(targetRoot: string): Promise<void> {
  const result = await reconcileProductionMaintenanceSkillAt(targetRoot);
  if (result.status === 'failed') throw new Error(`维护 Skill 对齐失败：${result.reason ?? 'unknown'}`);
}

const PRODUCTION_DEPS: RuntimeRollbackDeps = {
  listReleases: () => listRuntimeReleases(configRoot()),
  currentRelease: () => readCurrentRuntimeRelease(configRoot()),
  assertRemoteTag: assertRemoteDeployTag,
  activate: root => { activateRuntimeRelease(configRoot(), root); },
  writeIntent: writeRollbackIntent,
  restart: restartRuntime,
  verify: verifyRuntime,
  alignSkill: alignMaintenanceSkill,
};

function outputList(
  releases: RuntimeReleaseRecord[],
  current: RuntimeReleaseRecord | null,
): RuntimeRollbackResult['releases'] {
  return releases.map(item => ({
    deployTag: item.manifest.deployTag,
    commit: item.manifest.commit,
    root: item.root,
    current: item.root === current?.root,
  }));
}

/** 解析只读 list 或一次明确的 --last/--to 状态变更。 */
export async function runRuntimeRollback(
  args: string[],
  deps: RuntimeRollbackDeps = PRODUCTION_DEPS,
): Promise<RuntimeRollbackResult> {
  const releases = deps.listReleases();
  const current = deps.currentRelease();
  if (args.includes('--list')) return { action: 'list', releases: outputList(releases, current) };
  if (!current) throw new Error('当前运行态不是完整版本化目录，拒绝回滚');
  const toIndex = args.indexOf('--to');
  const requested = toIndex >= 0 ? args[toIndex + 1] : undefined;
  const target = requested
    ? releases.find(item => item.manifest.deployTag === requested) ?? null
    : args.includes('--last')
      ? selectPreviousRuntimeRelease(releases, current.manifest.deployTag)
      : null;
  if (!target) throw new Error('用法：botmux rollback --list | --last | --to deploy/vX.Y.Z-custom.N');
  if (target.root === current.root) throw new Error('目标版本已经是 current');
  await deps.assertRemoteTag(target);
  deps.activate(target.root);
  // 只有 current 已成功 flip 后才写重启意图，避免切换前失败留下误导性回滚通知。
  deps.writeIntent(current, target);
  try {
    await deps.restart(target.root);
    await deps.verify(target);
    await deps.alignSkill(target.root);
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    try {
      deps.writeIntent(target, current);
      deps.activate(current.root);
      await deps.restart(current.root);
      await deps.verify(current);
      await deps.alignSkill(current.root);
    } catch (restoreError) {
      throw new Error(`回滚失败且恢复原版本失败：${failure}；恢复错误：${restoreError instanceof Error ? restoreError.message : restoreError}`);
    }
    throw new Error(`回滚失败，已恢复原版本：${failure}`);
  }
  return {
    action: 'rollback',
    releases: outputList(releases, target),
    from: current.manifest.deployTag,
    to: target.manifest.deployTag,
  };
}
