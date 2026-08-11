#!/usr/bin/env node
/**
 * 官方同步执行器：prepare 只生成隔离候选，verify 只跑契约门禁，promote 才推进
 * custom/dev、custom/prod 与版本化运行目录。默认 all 保持 Dashboard 一键入口兼容。
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  backupActiveDist,
  runtimeCurrentRoot,
  writeRuntimeManifest,
} from './runtime-release-files.mjs';
import {
  assertSourceUpdatePromotable,
  captureCandidateSnapshot,
  captureSourceUpdateSnapshot,
  readSourceUpdateState,
  sourceUpdatePhase,
  sourceUpdateStatePath,
  verifyPreparedSourceUpdate,
  writeSourceUpdateState,
} from './lib/source-update-phases.mjs';
import {
  alignedStableTag,
  cleanTracked,
  compatibleUnitTests,
  ensureUpgradeWorktree,
  git,
  githubRepo,
  latestStableTag,
  replaceDist,
  run,
  sourceUpdateConfigAt,
} from './lib/source-update-support.mjs';

const RESULT_PREFIX = 'BOTMUX_SOURCE_UPDATE_RESULT=';
const INTEGRATION_BRANCH = 'custom/dev';

function rootArg(argv) {
  const index = argv.indexOf('--root');
  if (index < 0 || !argv[index + 1]) throw new Error('缺少 --root');
  return resolve(argv[index + 1]);
}

function emit(result) {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
}

function assertTrustedRoot(root, config) {
  const branch = git(root, ['symbolic-ref', '--short', 'HEAD']);
  if (branch !== config.productionBranch) throw new Error(`当前分支 ${branch} 不是生产分支 ${config.productionBranch}`);
  if (!cleanTracked(root)) throw new Error(`生产工作树存在未提交改动：${root}`);
  const origin = githubRepo(git(root, ['remote', 'get-url', config.originRemote]));
  if (origin?.toLowerCase() !== config.originRepo.toLowerCase()) throw new Error('origin 身份与同步配置不一致');
  const upstream = githubRepo(git(root, ['remote', 'get-url', config.upstreamRemote]));
  if (upstream?.toLowerCase() !== config.upstreamRepo.toLowerCase()) throw new Error('upstream 身份与同步配置不一致');
}

function baseResult(state) {
  return {
    oldVersion: state.oldVersion,
    newVersion: state.newVersion,
    changed: true,
    branch: state.config.productionBranch,
    upgradeBranch: state.upgradeBranch,
    releaseTag: state.releaseTag,
    deployTag: null,
    productionHead: state.candidateHead,
  };
}

async function prepare(root, config, statePath) {
  assertTrustedRoot(root, config);
  git(root, [
    'fetch',
    '--prune',
    config.originRemote,
    `+refs/heads/${INTEGRATION_BRANCH}:refs/remotes/${config.originRemote}/${INTEGRATION_BRANCH}`,
    `+refs/heads/${config.productionBranch}:refs/remotes/${config.originRemote}/${config.productionBranch}`,
  ], { timeout: 180_000 });
  git(root, ['fetch', '--prune', '--tags', config.upstreamRemote], { timeout: 180_000 });
  const remoteBase = `${config.originRemote}/${config.productionBranch}`;
  const rootHead = git(root, ['rev-parse', 'HEAD']);
  const productionHead = git(root, ['rev-parse', remoteBase]);
  if (rootHead !== productionHead) throw new Error(`本机 ${config.productionBranch} 与 ${remoteBase} 不一致，请先人工核对`);
  const integrationBase = `${config.originRemote}/${INTEGRATION_BRANCH}`;
  if (git(root, ['rev-parse', integrationBase]) !== productionHead) {
    throw new Error(`${INTEGRATION_BRANCH} 存在待发改动；请先完成或放弃当前候选版本，再同步官方版本`);
  }

  const currentTag = alignedStableTag(root);
  const latestTag = latestStableTag(root, config.upstreamRemote);
  if (currentTag === latestTag) {
    return { noChange: {
      oldVersion: currentTag.slice(1),
      newVersion: latestTag.slice(1),
      changed: false,
      branch: config.productionBranch,
      upgradeBranch: null,
      releaseTag: null,
      deployTag: null,
      productionHead: rootHead,
    } };
  }

  const upgradeBranch = `upgrade/${latestTag}`;
  const releaseTag = `release/${latestTag}-custom.1`;
  const upgradePath = join(homedir(), '.botmux', 'releases', `${latestTag}-custom.1`);
  ensureUpgradeWorktree(root, upgradeBranch, upgradePath, remoteBase);
  try {
    git(upgradePath, ['merge', '--no-ff', latestTag, '-m', `merge: 合入 Botmux ${latestTag}`], { timeout: 180_000 });
  } catch (error) {
    let conflicts = '';
    try {
      conflicts = git(upgradePath, ['diff', '--name-only', '--diff-filter=U']);
    } catch { /* 二次诊断不能覆盖最初的 merge 错误。 */ }
    if (conflicts) {
      throw new Error(`官方同步发生合并冲突；已停在 ${upgradePath}，请人工处理冲突后再继续，生产分支尚未推进`);
    }
    throw error;
  }

  const candidateHead = git(upgradePath, ['rev-parse', 'HEAD']);
  const state = {
    schemaVersion: 1,
    status: 'prepared',
    root,
    config,
    oldVersion: currentTag.slice(1),
    newVersion: latestTag.slice(1),
    upgradeBranch,
    upgradePath,
    releaseTag,
    candidateHead,
    snapshot: captureSourceUpdateSnapshot(root, config),
    preparedAt: new Date().toISOString(),
  };
  writeSourceUpdateState(statePath, state);
  return { state };
}

async function verify(statePath, root, config) {
  assertTrustedRoot(root, config);
  const state = readSourceUpdateState(statePath, root, config);
  const operations = {
    snapshot: () => captureSourceUpdateSnapshot(root, config),
    candidate: () => captureCandidateSnapshot(state.upgradePath),
    now: () => new Date(),
    runGates: async () => {
      await run(state.upgradePath, process.execPath, ['scripts/check-release-toolchain.mjs']);
      await run(state.upgradePath, 'corepack', ['pnpm@9.5.0', 'install', '--frozen-lockfile']);
      await run(state.upgradePath, 'corepack', ['pnpm@9.5.0', 'test:upgrade-contract'], 20 * 60_000);
      await run(state.upgradePath, 'corepack', [
        'pnpm@9.5.0',
        'exec',
        'vitest',
        'run',
        '--project',
        'unit',
        ...compatibleUnitTests(state.upgradePath),
      ], 20 * 60_000);
      await run(state.upgradePath, 'corepack', ['pnpm@9.5.0', 'build'], 20 * 60_000);
    },
  };
  const verified = await verifyPreparedSourceUpdate(state, operations);
  writeSourceUpdateState(statePath, verified);
  return verified;
}

async function promote(statePath, root, config) {
  assertTrustedRoot(root, config);
  const state = readSourceUpdateState(statePath, root, config);
  const operations = {
    snapshot: () => captureSourceUpdateSnapshot(root, config),
    candidate: () => captureCandidateSnapshot(state.upgradePath),
  };
  await assertSourceUpdatePromotable(state, operations);
  if (git(state.upgradePath, ['tag', '--list', state.releaseTag])) throw new Error(`候选标签已存在：${state.releaseTag}`);
  writeRuntimeManifest(state.upgradePath, state.releaseTag, state.candidateHead);
  git(state.upgradePath, ['tag', '-a', state.releaseTag, '-m', `release: v${state.newVersion} custom.1`]);
  git(state.upgradePath, [
    'push', '--atomic', config.originRemote,
    `HEAD:refs/heads/${state.upgradeBranch}`,
    `refs/tags/${state.releaseTag}:refs/tags/${state.releaseTag}`,
    `HEAD:refs/heads/${INTEGRATION_BRANCH}`,
    `HEAD:refs/heads/${config.productionBranch}`,
  ], { timeout: 180_000 });

  const remoteBase = `${config.originRemote}/${config.productionBranch}`;
  git(root, ['fetch', config.originRemote, `+refs/heads/${config.productionBranch}:refs/remotes/${remoteBase}`], { timeout: 180_000 });
  git(root, ['merge', '--ff-only', remoteBase], { timeout: 180_000 });
  await run(root, 'corepack', ['pnpm@9.5.0', 'install', '--frozen-lockfile']);
  replaceDist(root, join(state.upgradePath, 'dist'), state.newVersion);

  const rollbackRoot = runtimeCurrentRoot(git);
  const rollbackVersion = git(rollbackRoot, [
    'tag', '--points-at', 'HEAD', '--list', 'deploy/v*-custom.*', '--sort=-v:refname',
  ]).split(/\r?\n/).filter(Boolean)[0]?.slice('deploy/'.length);
  if (!rollbackVersion) throw new Error('当前运行目录没有精确 deploy tag，拒绝覆盖 current');
  backupActiveDist(rollbackRoot, rollbackVersion);
  execFileSync(process.execPath, [
    join(state.upgradePath, 'scripts', 'claim-botmux-bin.mjs'),
    '--runtime-release', state.upgradePath,
  ], { cwd: state.upgradePath, stdio: 'inherit' });

  const promoted = { ...state, status: 'promoted', promotedAt: new Date().toISOString() };
  writeSourceUpdateState(statePath, promoted);
  return { ...baseResult(promoted), runtimeRoot: state.upgradePath, rollbackRoot };
}

async function main() {
  const argv = process.argv.slice(2);
  const root = rootArg(argv);
  const phase = sourceUpdatePhase(argv);
  const config = sourceUpdateConfigAt(root);
  const statePath = sourceUpdateStatePath(config);
  let state;
  if (phase === 'prepare' || phase === 'all') {
    const prepared = await prepare(root, config, statePath);
    if (prepared.noChange) return emit(prepared.noChange);
    state = prepared.state;
    if (phase === 'prepare') return emit({ ...baseResult(state), phase: 'prepare', status: state.status });
  }
  if (phase === 'verify' || phase === 'all') {
    state = await verify(statePath, root, config);
    if (phase === 'verify') return emit({ ...baseResult(state), phase: 'verify', status: state.status });
  }
  const result = await promote(statePath, root, config);
  emit(result);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
