#!/usr/bin/env node
/**
 * Botmux fork 三段式发布入口：查看待发状态、冻结 custom/dev、推进 custom/prod，
 * 并在真实部署验收完成后写入不可变部署标签。脚本本身不切换 wrapper 或重启 daemon。
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  customTag,
  latestOfficialTag,
  nextCustomVersion,
  parseCustomTag,
} from './lib/custom-release-version.mjs';
import {
  executeCustomReleaseJoin,
} from './lib/custom-release-join.mjs';

const RESULT_PREFIX = 'BOTMUX_CUSTOM_RELEASE_RESULT=';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const integrationBranch = 'custom/dev';
const safeName = /^[A-Za-z0-9._/-]+$/;

/** 执行无 shell 子进程，避免分支名和标签进入命令解释器。 */
function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.capture === false ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  if (result.status !== 0) {
    const detail = options.capture === false ? '' : `\n${result.stderr || result.stdout || ''}`;
    throw new Error(`${bin} ${args.join(' ')} 失败（${result.status ?? 'spawn'}）${detail}`);
  }
  return options.capture === false ? '' : String(result.stdout || '').trim();
}

/** 执行 Git 并默认读取输出。 */
function git(args, options = {}) {
  return run('git', args, options);
}

/** 读取既有受信任源码配置，复用生产分支和双远端身份。 */
function readConfig() {
  const value = JSON.parse(readFileSync(join(repoRoot, '.botmux-source-update.json'), 'utf8'));
  const required = ['productionBranch', 'originRemote', 'originRepo', 'upstreamRemote', 'upstreamRepo'];
  if (
    value?.schemaVersion !== 1
    || required.some(key => typeof value[key] !== 'string' || !safeName.test(value[key]))
  ) {
    throw new Error('源码同步配置无效');
  }
  return value;
}

/** 从 HTTPS 或 SSH GitHub 地址提取 owner/repo。 */
function githubRepo(url) {
  return String(url).trim().match(/github\.com(?::|\/)([^/\s]+\/[^/\s]+?)(?:\.git)?$/i)?.[1] ?? null;
}

/** 校验脚本操作的正是受信任 fork 和官方只读远端。 */
function assertRemoteIdentity(config) {
  const origin = githubRepo(git(['remote', 'get-url', config.originRemote]));
  const upstream = githubRepo(git(['remote', 'get-url', config.upstreamRemote]));
  if (origin?.toLowerCase() !== config.originRepo.toLowerCase()) throw new Error('origin 身份与配置不一致');
  if (upstream?.toLowerCase() !== config.upstreamRepo.toLowerCase()) throw new Error('upstream 身份与配置不一致');
}

/** 刷新两个受控分支以及 origin/upstream 标签。 */
function fetchState(config) {
  git([
    'fetch',
    '--prune',
    config.originRemote,
    `+refs/heads/${integrationBranch}:refs/remotes/${config.originRemote}/${integrationBranch}`,
    `+refs/heads/${config.productionBranch}:refs/remotes/${config.originRemote}/${config.productionBranch}`,
  ], { capture: false });
  git(['fetch', '--prune', '--tags', config.originRemote], { capture: false });
  git(['fetch', '--prune', '--tags', config.upstreamRemote], { capture: false });
}

/** 要求当前工作树没有 tracked 或 untracked 改动。 */
function assertClean() {
  if (git(['status', '--porcelain'])) throw new Error(`当前工作树存在未提交改动：${repoRoot}`);
}

/** 判断祖先关系，非祖先时返回 false，其它 Git 错误继续抛出。 */
function isAncestor(older, newer) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', older, newer], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`无法判断提交祖先关系：${older} -> ${newer}`);
}

/** 把 annotated/lightweight 标签统一解析为提交 SHA。 */
function tagCommit(tag) {
  return git(['rev-parse', `${tag}^{commit}`]);
}

/** 读取远端标签指向的提交 SHA，兼容 annotated tag 的 peeled ref。 */
function remoteTagCommit(remote, tag) {
  const lines = git(['ls-remote', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).split(/\r?\n/);
  return lines.find(line => line.endsWith(`refs/tags/${tag}^{}`))?.split(/\s+/)[0]
    ?? lines.find(line => line.endsWith(`refs/tags/${tag}`))?.split(/\s+/)[0]
    ?? '';
}

/** 读取分支和标签状态，供人工决策及后续动作复用。 */
function releaseState(config) {
  const integrationRef = `${config.originRemote}/${integrationBranch}`;
  const productionRef = `${config.originRemote}/${config.productionBranch}`;
  const integrationHead = git(['rev-parse', integrationRef]);
  const productionHead = git(['rev-parse', productionRef]);
  const officialTag = latestOfficialTag(
    git(['tag', '--merged', integrationRef, '--list', 'v*']).split(/\r?\n/).filter(Boolean),
  );
  const versionTags = git(['tag', '--list', 'release/v*-custom.*', '--list', 'deploy/v*-custom.*'])
    .split(/\r?\n/).filter(Boolean);
  const exactCandidates = git(['tag', '--points-at', integrationHead, '--list', 'release/v*-custom.*'])
    .split(/\r?\n/).filter(Boolean);
  const exactCandidate = exactCandidates
    .map(parseCustomTag)
    .filter(Boolean)
    .sort((a, b) => b.custom - a.custom)[0] ?? null;
  return {
    integrationBranch,
    productionBranch: config.productionBranch,
    integrationHead,
    productionHead,
    productionIsAncestor: isAncestor(productionHead, integrationHead),
    commitsPending: Number(git(['rev-list', '--count', `${productionRef}..${integrationRef}`])),
    officialTag,
    candidateTag: exactCandidate?.tag ?? null,
    candidateVersion: exactCandidate?.version ?? null,
    pendingVersion: nextCustomVersion(officialTag, versionTags),
  };
}

/** 回读远端分支，确保推进结果与预期提交完全一致。 */
function verifyRemoteBranch(remote, branch, expected) {
  const actual = git(['ls-remote', remote, `refs/heads/${branch}`]).split(/\s+/)[0] || '';
  if (actual !== expected) throw new Error(`远端分支回读不一致: expected=${expected} actual=${actual || 'missing'}`);
}

/** 输出唯一结构化终态，方便 Dashboard 或维护 Agent 消费。 */
function output(action, payload) {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify({ ok: true, action, ...payload })}\n`);
}

/** 冻结 custom/dev 当前 HEAD；可绑定卡片里的版本和 HEAD，重复执行同一提交时保持幂等。 */
function prepare(config, expectedHead = '', expectedVersion = '') {
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch !== integrationBranch) throw new Error(`prepare 只允许在 ${integrationBranch} 工作树执行`);
  assertClean();
  fetchState(config);
  const state = releaseState(config);
  if (git(['rev-parse', 'HEAD']) !== state.integrationHead) throw new Error(`本地 ${integrationBranch} 与远端不一致`);
  if (!state.productionIsAncestor) throw new Error(`${config.productionBranch} 不是 ${integrationBranch} 的祖先`);
  if (expectedHead && state.integrationHead !== expectedHead) throw new Error('卡片绑定的 custom/dev HEAD 已过期');
  const targetVersion = state.candidateVersion ?? state.pendingVersion;
  if (expectedVersion && targetVersion !== expectedVersion) throw new Error('卡片绑定的待发版本已过期');
  if (state.candidateTag) {
    const remoteCommit = remoteTagCommit(config.originRemote, state.candidateTag);
    if (!remoteCommit) git(['push', config.originRemote, `refs/tags/${state.candidateTag}`], { capture: false });
    else if (remoteCommit !== state.integrationHead) throw new Error(`远端候选标签指向异常: ${state.candidateTag}`);
    output('prepare', { changed: false, ...state });
    return;
  }

  // CLI 级测试依赖 dist/cli.js；先锁定 Node/pnpm，再构建当前 HEAD 并运行全量门禁。
  run(process.execPath, ['scripts/check-release-toolchain.mjs'], { capture: false });
  run('pnpm', ['build'], { capture: false });
  run('pnpm', ['test'], { capture: false });
  assertClean();
  fetchState(config);
  const finalState = releaseState(config);
  if (git(['rev-parse', 'HEAD']) !== state.integrationHead || finalState.integrationHead !== state.integrationHead) {
    throw new Error('冻结验证期间 custom/dev HEAD 已变化');
  }
  if (!finalState.productionIsAncestor) throw new Error(`${config.productionBranch} 不再是 ${integrationBranch} 的祖先`);
  if (finalState.candidateTag) {
    if (finalState.candidateVersion !== targetVersion) throw new Error('冻结验证期间候选版本已被占用');
    const remoteCommit = remoteTagCommit(config.originRemote, finalState.candidateTag);
    if (remoteCommit !== finalState.integrationHead) throw new Error(`远端候选标签指向异常: ${finalState.candidateTag}`);
    output('prepare', { changed: false, ...finalState });
    return;
  }
  if (finalState.pendingVersion !== targetVersion) throw new Error('冻结验证期间待发版本序号已变化');
  const releaseTag = customTag('release', targetVersion);
  git(['tag', '-a', releaseTag, '-m', `release: ${state.pendingVersion}`]);
  git(['push', config.originRemote, `refs/tags/${releaseTag}`], { capture: false });
  if (remoteTagCommit(config.originRemote, releaseTag) !== finalState.integrationHead) {
    throw new Error(`候选标签回读不一致: ${releaseTag}`);
  }
  output('prepare', { changed: true, ...finalState, candidateTag: releaseTag, candidateVersion: targetVersion });
}

/** 把已冻结候选提交以 fast-forward 方式推进到生产分支，不触碰本机运行态。 */
function promote(config, releaseTag) {
  const parsed = parseCustomTag(releaseTag);
  if (parsed?.kind !== 'release') throw new Error(`必须指定 release/vX.Y.Z-custom.N 标签: ${releaseTag}`);
  assertClean();
  fetchState(config);
  const commit = tagCommit(releaseTag);
  const integrationRef = `${config.originRemote}/${integrationBranch}`;
  const productionRef = `${config.originRemote}/${config.productionBranch}`;
  if (!isAncestor(commit, integrationRef)) throw new Error(`${releaseTag} 不属于 ${integrationBranch}`);
  if (!isAncestor(productionRef, commit)) throw new Error(`${releaseTag} 无法 fast-forward ${config.productionBranch}`);
  const changed = git(['rev-parse', productionRef]) !== commit;
  git(['push', config.originRemote, `${commit}:refs/heads/${config.productionBranch}`], { capture: false });
  verifyRemoteBranch(config.originRemote, config.productionBranch, commit);
  output('promote', { changed, releaseTag, commit });
}

/** 真实部署验收后，为生产 HEAD 写入与候选版本同号的不可变部署标签。 */
function recordDeploy(config, releaseTag) {
  const parsed = parseCustomTag(releaseTag);
  if (parsed?.kind !== 'release') throw new Error(`必须指定 release/vX.Y.Z-custom.N 标签: ${releaseTag}`);
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch !== config.productionBranch) throw new Error(`record-deploy 只允许在 ${config.productionBranch} 工作树执行`);
  assertClean();
  fetchState(config);
  const commit = tagCommit(releaseTag);
  const productionHead = git(['rev-parse', `${config.originRemote}/${config.productionBranch}`]);
  if (git(['rev-parse', 'HEAD']) !== productionHead || productionHead !== commit) {
    throw new Error('本地生产 HEAD、远端生产 HEAD 与候选版本提交不一致');
  }
  const deployTag = customTag('deploy', parsed.version);
  const existing = git(['tag', '--list', deployTag]);
  let changed = false;
  if (existing) {
    if (tagCommit(deployTag) !== commit) throw new Error(`部署标签已指向其它提交: ${deployTag}`);
  } else {
    git(['tag', '-a', deployTag, '-m', `deploy: ${parsed.version}`]);
    changed = true;
  }
  git(['push', config.originRemote, `refs/tags/${deployTag}`], { capture: false });
  if (remoteTagCommit(config.originRemote, deployTag) !== commit) throw new Error(`部署标签回读不一致: ${deployTag}`);
  output('record-deploy', { changed, releaseTag, deployTag, commit });
}

/** 解析最小命令行参数，所有写操作都要求明确动作和候选标签。 */
function main() {
  const [action = 'status', ...args] = process.argv.slice(2);
  const tagIndex = args.indexOf('--tag');
  const releaseTag = tagIndex >= 0 ? args[tagIndex + 1] : '';
  const expectedHeadIndex = args.indexOf('--expected-head');
  const expectedVersionIndex = args.indexOf('--expected-version');
  const expectedHead = expectedHeadIndex >= 0 ? args[expectedHeadIndex + 1] ?? '' : '';
  const expectedVersion = expectedVersionIndex >= 0 ? args[expectedVersionIndex + 1] ?? '' : '';
  const config = readConfig();
  assertRemoteIdentity(config);
  if (action === 'status') {
    const refreshRemote = args.includes('--remote');
    if (refreshRemote) fetchState(config);
    output('status', { source: refreshRemote ? 'remote' : 'local', ...releaseState(config) });
  } else if (action === 'join') {
    output('join', executeCustomReleaseJoin({
      repoRoot,
      config,
      args,
      assertClean,
      fetchState,
      releaseState,
      localHead: () => git(['rev-parse', 'HEAD']),
    }));
  } else if (action === 'prepare') prepare(config, expectedHead, expectedVersion);
  else if (action === 'promote') promote(config, releaseTag);
  else if (action === 'record-deploy') recordDeploy(config, releaseTag);
  else throw new Error('Usage: pnpm release:status [-- --remote] | release:join -- --source <branch> --expected-head <sha> --title <text> | release:prepare | release:promote -- --tag <release/...> | release:record-deploy -- --tag <release/...>');
}

try {
  main();
} catch (error) {
  process.stderr.write(`custom-release: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
