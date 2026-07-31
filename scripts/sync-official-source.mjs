#!/usr/bin/env node
/**
 * 官方同步执行器：在隔离 upgrade worktree 完成合并、测试和构建，通过后才快进
 * fork 的生产分支并替换本机 dist。脚本只接受仓库内受限配置，不执行配置中的任意命令。
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
import { basename, dirname, join, resolve } from 'node:path';

const RESULT_PREFIX = 'BOTMUX_SOURCE_UPDATE_RESULT=';
const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const SAFE_NAME = /^[A-Za-z0-9._/-]+$/;
const INTEGRATION_BRANCH = 'custom/dev';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function rootArg(argv) {
  const index = argv.indexOf('--root');
  if (index < 0 || !argv[index + 1]) fail('缺少 --root');
  return resolve(argv[index + 1]);
}

function configAt(root) {
  const value = JSON.parse(readFileSync(join(root, '.botmux-source-update.json'), 'utf8'));
  const names = ['productionBranch', 'originRemote', 'originRepo', 'upstreamRemote', 'upstreamRepo'];
  const allowed = new Set(['schemaVersion', ...names]);
  if (
    value?.schemaVersion !== 1
    || Object.keys(value).some(key => !allowed.has(key))
    || names.some(key => typeof value[key] !== 'string' || !SAFE_NAME.test(value[key]))
  ) {
    fail('源码同步配置无效');
  }
  return value;
}

function git(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function githubRepo(url) {
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

function latestStableTag(root, remote) {
  const refs = git(root, ['ls-remote', '--tags', remote], { timeout: 120_000 });
  const tags = refs.split(/\r?\n/)
    .map(line => line.match(/refs\/tags\/(v\d+\.\d+\.\d+)(?:\^\{\})?$/)?.[1])
    .filter(Boolean);
  const unique = [...new Set(tags)].sort(compareTags);
  if (!unique[0]) fail(`远端 ${remote} 没有正式版标签`);
  return unique[0];
}

function alignedStableTag(root) {
  const tags = git(root, ['tag', '--merged', 'HEAD', '--list', 'v*'])
    .split(/\r?\n/)
    .filter(tag => STABLE_TAG.test(tag))
    .sort(compareTags);
  return tags[0] ?? 'v0.0.0';
}

function compatibleUnitTests(root) {
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

function cleanTracked(root) {
  return git(root, ['status', '--porcelain', '--untracked-files=no']) === '';
}

function run(root, command, args, timeout = 10 * 60_000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const capture = data => {
      const text = data.toString();
      process.stderr.write(text);
      tail = (tail + text).slice(-8_000);
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

function ensureUpgradeWorktree(root, branch, path, base) {
  if (existsSync(path)) {
    const actual = git(path, ['symbolic-ref', '--short', 'HEAD']);
    if (actual !== branch) fail(`升级工作树分支不符：${path} 当前为 ${actual}`);
    if (!cleanTracked(path)) fail(`升级工作树存在未提交改动：${path}`);
    const head = git(path, ['rev-parse', 'HEAD']);
    const baseHead = git(root, ['rev-parse', base]);
    if (head !== baseHead) fail(`升级工作树不是最新生产基线，请先处理：${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  let branchExists = false;
  try {
    git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    branchExists = true;
  } catch { /* 未创建过的自动升级分支走首次创建。 */ }
  if (branchExists) git(root, ['branch', '-f', branch, base]);
  else git(root, ['branch', branch, base]);
  git(root, ['worktree', 'add', path, branch], { timeout: 120_000 });
}

function replaceDist(root, builtDist, tag) {
  // 备份与生产 dist 必须位于同一文件系统，才能用 rename 原子切换。
  const backupRoot = join(dirname(root), '.botmux-dist-backups', `source-update-${tag}-${Date.now()}`);
  const staging = join(root, `dist.next-${process.pid}`);
  mkdirSync(backupRoot, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  cpSync(builtDist, staging, { recursive: true });
  if (existsSync(join(root, 'dist'))) renameSync(join(root, 'dist'), join(backupRoot, 'dist'));
  renameSync(staging, join(root, 'dist'));
  return backupRoot;
}

async function main() {
  const root = rootArg(process.argv.slice(2));
  const config = configAt(root);
  const branch = git(root, ['symbolic-ref', '--short', 'HEAD']);
  if (branch !== config.productionBranch) fail(`当前分支 ${branch} 不是生产分支 ${config.productionBranch}`);
  if (!cleanTracked(root)) fail(`生产工作树存在未提交改动：${root}`);
  if (githubRepo(git(root, ['remote', 'get-url', config.originRemote]))?.toLowerCase() !== config.originRepo.toLowerCase()) {
    fail('origin 身份与同步配置不一致');
  }
  if (githubRepo(git(root, ['remote', 'get-url', config.upstreamRemote]))?.toLowerCase() !== config.upstreamRepo.toLowerCase()) {
    fail('upstream 身份与同步配置不一致');
  }

  git(root, [
    'fetch',
    '--prune',
    config.originRemote,
    `+refs/heads/${INTEGRATION_BRANCH}:refs/remotes/${config.originRemote}/${INTEGRATION_BRANCH}`,
    `+refs/heads/${config.productionBranch}:refs/remotes/${config.originRemote}/${config.productionBranch}`,
  ], { timeout: 180_000 });
  git(root, ['fetch', '--prune', '--tags', config.upstreamRemote], { timeout: 180_000 });
  const remoteBase = `${config.originRemote}/${config.productionBranch}`;
  if (git(root, ['rev-parse', 'HEAD']) !== git(root, ['rev-parse', remoteBase])) {
    fail(`本机 ${config.productionBranch} 与 ${remoteBase} 不一致，请先人工核对`);
  }
  const integrationBase = `${config.originRemote}/${INTEGRATION_BRANCH}`;
  if (git(root, ['rev-parse', integrationBase]) !== git(root, ['rev-parse', remoteBase])) {
    fail(`${INTEGRATION_BRANCH} 存在待发改动；请先完成或放弃当前候选版本，再同步官方版本`);
  }

  const currentTag = alignedStableTag(root);
  const latestTag = latestStableTag(root, config.upstreamRemote);
  const baseResult = {
    oldVersion: currentTag.slice(1),
    newVersion: latestTag.slice(1),
    branch: config.productionBranch,
  };
  if (currentTag === latestTag) {
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify({
      ...baseResult,
      changed: false,
      upgradeBranch: null,
      releaseTag: null,
      deployTag: null,
    })}\n`);
    return;
  }

  const upgradeBranch = `upgrade/${latestTag}`;
  const commonDir = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const repositoryRoot = basename(commonDir) === '.git' ? dirname(commonDir) : dirname(dirname(commonDir));
  const upgradePath = join(repositoryRoot, '.worktrees', `upgrade-${latestTag.slice(1)}`);
  ensureUpgradeWorktree(root, upgradeBranch, upgradePath, remoteBase);
  git(upgradePath, ['merge', '--no-ff', latestTag, '-m', `merge: 合入 Botmux ${latestTag}`], { timeout: 180_000 });

  await run(upgradePath, 'pnpm', ['install', '--frozen-lockfile']);
  // 本机 Git 2.20 不支持夹具使用的 `git init -b`，PID namespace 用例也依赖宿主内核；
  // 其余 unit 全量执行，更新链路自身的测试不在排除范围内。
  await run(upgradePath, 'pnpm', [
    'exec',
    'vitest',
    'run',
    '--project',
    'unit',
    ...compatibleUnitTests(upgradePath),
  ], 20 * 60_000);
  await run(upgradePath, 'pnpm', ['build'], 20 * 60_000);
  const releaseTag = `release/${latestTag}-custom.1`;
  if (git(upgradePath, ['tag', '--list', releaseTag])) fail(`候选标签已存在：${releaseTag}`);
  git(upgradePath, ['tag', '-a', releaseTag, '-m', `release: ${latestTag} custom.1`]);
  git(upgradePath, ['push', config.originRemote, `HEAD:refs/heads/${upgradeBranch}`], { timeout: 180_000 });
  git(upgradePath, ['push', config.originRemote, `refs/tags/${releaseTag}`], { timeout: 180_000 });
  git(upgradePath, ['push', config.originRemote, `HEAD:refs/heads/${INTEGRATION_BRANCH}`], { timeout: 180_000 });
  git(upgradePath, ['push', config.originRemote, `HEAD:refs/heads/${config.productionBranch}`], { timeout: 180_000 });

  git(root, [
    'fetch',
    config.originRemote,
    `+refs/heads/${config.productionBranch}:refs/remotes/${config.originRemote}/${config.productionBranch}`,
  ], { timeout: 180_000 });
  git(root, ['merge', '--ff-only', remoteBase], { timeout: 180_000 });
  await run(root, 'pnpm', ['install', '--frozen-lockfile']);
  replaceDist(root, join(upgradePath, 'dist'), latestTag.slice(1));

  const deployTag = `deploy/${latestTag}-custom.1`;
  git(upgradePath, ['tag', '-a', deployTag, '-m', `deploy: ${latestTag} custom.1`]);
  git(upgradePath, ['push', config.originRemote, `refs/tags/${deployTag}`], { timeout: 180_000 });
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify({
    ...baseResult,
    changed: true,
    upgradeBranch,
    releaseTag,
    deployTag,
  })}\n`);
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
