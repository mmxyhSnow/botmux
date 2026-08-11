/**
 * 官方同步的受限 Git、命令和文件操作。
 * 这里只提供固定参数能力，不读取或执行仓库配置中的任意命令。
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const SAFE_NAME = /^[A-Za-z0-9._/-]+$/;

/** 读取并严格约束仓库内官方同步配置。 */
export function sourceUpdateConfigAt(root) {
  const value = JSON.parse(readFileSync(join(root, '.botmux-source-update.json'), 'utf8'));
  const names = ['productionBranch', 'originRemote', 'originRepo', 'upstreamRemote', 'upstreamRepo'];
  const allowed = new Set(['schemaVersion', ...names]);
  if (
    value?.schemaVersion !== 1
    || Object.keys(value).some(key => !allowed.has(key))
    || names.some(key => typeof value[key] !== 'string' || !SAFE_NAME.test(value[key]))
  ) throw new Error('源码同步配置无效');
  return value;
}

/** 在指定仓库执行固定 Git 子命令并返回去除尾部换行的输出。 */
export function git(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** 归一化 GitHub SSH/HTTPS 远端为 owner/repo。 */
export function githubRepo(url) {
  return url.trim().match(/github\.com(?::|\/)([^/\s]+\/[^/\s]+?)(?:\.git)?$/i)?.[1] ?? null;
}

function semverParts(tag) {
  const match = tag.match(STABLE_TAG);
  return match ? match.slice(1).map(Number) : null;
}

function compareTags(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  if (!a || !b) return 0;
  return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
}

/** 从官方远端标签中选择最新正式版本。 */
export function latestStableTag(root, remote) {
  const tags = git(root, ['ls-remote', '--tags', remote], { timeout: 120_000 })
    .split(/\r?\n/)
    .map(line => line.match(/refs\/tags\/(v\d+\.\d+\.\d+)(?:\^\{\})?$/)?.[1])
    .filter(Boolean);
  const latest = [...new Set(tags)].sort(compareTags)[0];
  if (!latest) throw new Error(`远端 ${remote} 没有正式版标签`);
  return latest;
}

/** 返回当前提交已经包含的最新官方正式版标签。 */
export function alignedStableTag(root) {
  return git(root, ['tag', '--merged', 'HEAD', '--list', 'v*'])
    .split(/\r?\n/)
    .filter(tag => STABLE_TAG.test(tag))
    .sort(compareTags)[0] ?? 'v0.0.0';
}

/** 列出当前宿主 Git/内核能够稳定执行的全量 unit 测试。 */
export function compatibleUnitTests(root) {
  const unsupported = new Set([
    'test/git-worktree.test.ts',
    'test/default-worktree.test.ts',
    'test/repo-selection.test.ts',
    'test/v3-distillation-runner.test.ts',
  ]);
  return git(root, ['ls-files', 'test'])
    .split(/\r?\n/)
    .filter(path => /\.(?:test|spec)\.ts$/.test(path) && !unsupported.has(path));
}

/** 只检查已跟踪文件，避免依赖安装产物影响候选判定。 */
export function cleanTracked(root) {
  return git(root, ['status', '--porcelain', '--untracked-files=no']) === '';
}

/** 运行固定门禁命令，保留末尾日志用于失败定位。 */
export function run(root, command, args, timeout = 10 * 60_000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const capture = data => {
      const output = data.toString();
      process.stderr.write(output);
      tail = (tail + output).slice(-8_000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectRun(new Error(`${command} ${args.join(' ')} 超时`));
    }, timeout);
    child.once('error', error => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(' ')} 失败（${code}）\n${tail.slice(-2_000)}`));
    });
  });
}

/** 创建或复用只指向指定基线的隔离升级 worktree。 */
export function ensureUpgradeWorktree(root, branch, path, base) {
  if (existsSync(path)) {
    const actual = git(path, ['symbolic-ref', '--short', 'HEAD']);
    if (actual !== branch) throw new Error(`升级工作树分支不符：${path} 当前为 ${actual}`);
    if (!cleanTracked(path)) throw new Error(`升级工作树存在未提交改动：${path}`);
    const head = git(path, ['rev-parse', 'HEAD']);
    const baseHead = git(root, ['rev-parse', base]);
    if (head !== baseHead) throw new Error(`升级工作树不是最新生产基线，请先处理：${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  let branchExists = false;
  try {
    git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    branchExists = true;
  } catch { /* 首次同步还没有本地升级分支。 */ }
  if (branchExists) git(root, ['branch', '-f', branch, base]);
  else git(root, ['branch', branch, base]);
  git(root, ['worktree', 'add', path, branch], { timeout: 120_000 });
}

/** 以同文件系统 rename 原子替换 canonical checkout 的构建产物。 */
export function replaceDist(root, builtDist, tag) {
  const backupRoot = join(dirname(root), '.botmux-dist-backups', `source-update-${tag}-${Date.now()}`);
  const staging = join(root, `dist.next-${process.pid}`);
  mkdirSync(backupRoot, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  cpSync(builtDist, staging, { recursive: true });
  if (existsSync(join(root, 'dist'))) renameSync(join(root, 'dist'), join(backupRoot, 'dist'));
  renameSync(staging, join(root, 'dist'));
  return backupRoot;
}
