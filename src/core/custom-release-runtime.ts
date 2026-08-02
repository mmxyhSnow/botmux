/**
 * 自定义发版的版本化运行目录准备器。
 * 所有 install/build/smoke 都发生在独立 tag worktree，绝不改写当前活跃 dist。
 */
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { config } from '../config.js';
import {
  activateRuntimeController,
  readCurrentRuntimeRelease,
  readRuntimeRelease,
  runtimeReleaseRoot,
  writeRuntimeReleaseManifest,
} from './runtime-release.js';

const RELEASE_TAG = /^release\/(v\d+\.\d+\.\d+-custom\.\d+)$/;
const DEPLOY_TAG = /^deploy\/(v\d+\.\d+\.\d+-custom\.\d+)$/;
const MAX_TAIL = 64 * 1024;

interface CommandResult {
  code: number;
  output: string;
}

export interface PreparedRuntimeRelease {
  releaseRoot: string;
  rollbackRoot: string;
  rollbackDeployTag: string;
}

export interface CustomReleaseRuntimeDeps {
  configRoot: () => string;
  exists: (path: string) => boolean;
  run: (command: string, args: string[], cwd: string) => Promise<CommandResult>;
  now: () => Date;
}

function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

function defaultConfigRoot(): string {
  const dataRoot = config.session.dataDir;
  return basename(dataRoot) === 'data' ? dirname(dataRoot) : join(homedir(), '.botmux');
}

const PRODUCTION_DEPS: CustomReleaseRuntimeDeps = {
  configRoot: defaultConfigRoot,
  exists: existsSync,
  run: runCommand,
  now: () => new Date(),
};

async function checkedRun(
  deps: CustomReleaseRuntimeDeps,
  label: string,
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  const result = await deps.run(command, args, cwd);
  if (result.code !== 0) {
    throw new Error(`${label}：${result.output.trim().slice(-1500) || `exit ${result.code}`}`);
  }
  return result.output.trim();
}

function deployTagFor(releaseTag: string): string {
  const match = releaseTag.match(RELEASE_TAG);
  if (!match) throw new Error('候选标签无效');
  return `deploy/${match[1]}`;
}

function releaseTagFor(deployTag: string): string {
  const match = deployTag.match(DEPLOY_TAG);
  if (!match) throw new Error('部署标签无效');
  return `release/${match[1]}`;
}

/** 创建或复用精确 tag 的 detached worktree，并完成 build-id 绑定与 smoke。 */
async function ensureRuntimeWorktree(
  productionRoot: string,
  releaseTag: string,
  expectedHead: string,
  deps: CustomReleaseRuntimeDeps,
): Promise<string> {
  const actualTagHead = await checkedRun(
    deps,
    '无法解析候选标签',
    'git',
    ['rev-parse', `${releaseTag}^{commit}`],
    productionRoot,
  );
  if (actualTagHead !== expectedHead) throw new Error('候选标签与期望 HEAD 不一致');
  const root = runtimeReleaseRoot(deps.configRoot(), releaseTag);
  if (!deps.exists(root)) {
    mkdirSync(join(root, '..'), { recursive: true });
    await checkedRun(
      deps,
      '无法创建版本化运行 worktree',
      'git',
      ['worktree', 'add', '--detach', root, releaseTag],
      productionRoot,
    );
  }
  const head = await checkedRun(deps, '无法回读运行 worktree HEAD', 'git', ['rev-parse', 'HEAD'], root);
  if (head !== expectedHead) throw new Error(`版本化运行目录 HEAD 不一致：${root}`);

  const existing = readRuntimeRelease(root);
  if (existing?.manifest.releaseTag === releaseTag && existing.manifest.commit === expectedHead) {
    await checkedRun(deps, '既有运行版本 smoke 失败', process.execPath, ['dist/cli.js', '--version'], root);
    return root;
  }

  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  await checkedRun(deps, '版本化运行依赖安装失败', pnpm, ['install', '--frozen-lockfile'], root);
  await checkedRun(deps, '版本化运行构建失败', pnpm, ['build'], root);
  for (const entry of ['cli.js', 'index-daemon.js', 'dashboard.js', '.runtime-build-id']) {
    if (!deps.exists(join(root, 'dist', entry))) throw new Error(`运行产物缺少 ${entry}`);
  }
  await checkedRun(deps, '版本化运行产物 smoke 失败', process.execPath, ['dist/cli.js', '--version'], root);
  const runtimeBuildId = readFileSync(join(root, 'dist', '.runtime-build-id'), 'utf8').trim();
  writeRuntimeReleaseManifest(root, {
    schemaVersion: 1,
    releaseTag,
    deployTag: deployTagFor(releaseTag),
    commit: expectedHead,
    runtimeBuildId,
    createdAt: deps.now().toISOString(),
  });
  if (!readRuntimeRelease(root)) throw new Error('运行版本身份写入后回读失败');
  return root;
}

async function currentDeployIdentity(
  productionRoot: string,
  activeRoot: string,
  deps: CustomReleaseRuntimeDeps,
): Promise<{ deployTag: string; commit: string }> {
  const managed = readCurrentRuntimeRelease(deps.configRoot());
  if (managed && managed.root === activeRoot) {
    return { deployTag: managed.manifest.deployTag, commit: managed.manifest.commit };
  }
  const commit = await checkedRun(deps, '无法回读当前运行 HEAD', 'git', ['rev-parse', 'HEAD'], activeRoot);
  const tags = await checkedRun(
    deps,
    '无法定位当前 deploy tag',
    'git',
    ['tag', '--points-at', commit, '--list', 'deploy/v*-custom.*', '--sort=-v:refname'],
    productionRoot,
  );
  const deployTag = tags.split(/\r?\n/).find(tag => DEPLOY_TAG.test(tag)) ?? '';
  if (!deployTag) throw new Error('当前运行版本没有精确 deploy tag，拒绝无回滚点部署');
  return { deployTag, commit };
}

/** 同时准备目标版本与当前 live 的版本化副本，确保 flip 前已有 O(1) 回滚点。 */
export async function prepareCustomReleaseRuntime(
  productionRoot: string,
  releaseTag: string,
  expectedHead: string,
  activeRoot: string,
  deps: CustomReleaseRuntimeDeps = PRODUCTION_DEPS,
): Promise<PreparedRuntimeRelease> {
  const current = await currentDeployIdentity(productionRoot, activeRoot, deps);
  const rollbackRoot = await ensureRuntimeWorktree(
    productionRoot,
    releaseTagFor(current.deployTag),
    current.commit,
    deps,
  );
  const releaseRoot = await ensureRuntimeWorktree(productionRoot, releaseTag, expectedHead, deps);
  return { releaseRoot, rollbackRoot, rollbackDeployTag: current.deployTag };
}

/** 统一通过 use:here 更新动态 wrapper 与 current，保持人工/卡片切换语义一致。 */
export async function activateCustomReleaseRuntime(
  releaseRoot: string,
  deps: CustomReleaseRuntimeDeps = PRODUCTION_DEPS,
): Promise<void> {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  await checkedRun(
    deps,
    '版本化运行目录切换失败',
    pnpm,
    ['use:here', '--', '--runtime-release', releaseRoot],
    releaseRoot,
  );
}

/** 迁移前兼容 canonical live；迁移后只认 current 指向的完整版本目录。 */
export function currentCustomReleaseRuntimeRoot(fallback: () => string): string {
  return readCurrentRuntimeRelease(PRODUCTION_DEPS.configRoot())?.root ?? fallback();
}

/** 在 current flip 前保存真实活跃 dist，目录快照只作为 deploy-tag 回滚之外的灾备兜底。 */
export async function backupCustomReleaseRuntime(
  activeRoot: string,
  deployTag: string,
  deps: CustomReleaseRuntimeDeps = PRODUCTION_DEPS,
): Promise<string> {
  const match = deployTag.match(DEPLOY_TAG);
  if (!match) throw new Error('备份 deploy tag 无效');
  const stamp = deps.now().toISOString().replace(/[:.]/g, '-');
  const root = join(deps.configRoot(), 'backups', `${stamp}-${match[1]}`);
  mkdirSync(root, { recursive: true });
  cpSync(join(activeRoot, 'dist'), join(root, 'dist'), { recursive: true, errorOnExist: true });
  writeFileSync(join(root, 'metadata.json'), `${JSON.stringify({
    schemaVersion: 1,
    deployTag,
    sourceRoot: activeRoot,
    createdAt: deps.now().toISOString(),
  }, null, 2)}\n`, 'utf8');
  return root;
}

/** 部署验收完成后，更新稳定 rollback 控制器；普通 CLI 始终仍跟随 current。 */
export function activateCustomReleaseController(releaseRoot: string): void {
  activateRuntimeController(PRODUCTION_DEPS.configRoot(), releaseRoot);
}
