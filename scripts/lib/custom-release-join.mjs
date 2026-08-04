/**
 * custom/dev 统一合入与通知事件生成。
 * 合入在一次性共享 clone 中完成，push 竞态可以无污染重试，成功后再快进规范 checkout。
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SAFE_BRANCH = /^[A-Za-z0-9._/-]{1,220}$/;
const SHA = /^[a-f0-9]{40}$/;

class CommandError extends Error {
  constructor(command, output) {
    super(`${command} 失败：${output.trim().slice(-2000)}`);
    this.output = output;
  }
}

function run(bin, args, cwd, allowFailure = false) {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status !== 0 && !allowFailure) throw new CommandError(`${bin} ${args.join(' ')}`, output);
  return { code: result.status ?? 1, output: output.trim() };
}

function git(cwd, args, allowFailure = false) {
  return run('git', args, cwd, allowFailure);
}

function gitText(cwd, args) {
  return git(cwd, args).output;
}

function isAncestor(cwd, older, newer) {
  const result = git(cwd, ['merge-base', '--is-ancestor', older, newer], true);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new CommandError('git merge-base --is-ancestor', result.output);
}

function normalizeSourceBranch(remote, value) {
  const source = String(value || '').replace(new RegExp(`^${remote}/`), '');
  if (!SAFE_BRANCH.test(source) || source.includes('..') || source.startsWith('/') || source.endsWith('/')) {
    throw new Error(`开发分支无效: ${value}`);
  }
  if (source === 'custom/dev' || source === 'custom/prod') throw new Error('开发分支不能是受控发布分支');
  return source;
}

function pushWasRaced(result) {
  return result.code !== 0 && /non-fast-forward|fetch first|rejected/i.test(result.output);
}

/** 一次性 clone 继承规范 checkout 的 SSH 传输配置，避免私钥只配置在仓库本地时认证丢失。 */
export function inheritReleaseJoinTransportConfig(repoRoot, staging) {
  const sshCommand = git(repoRoot, ['config', '--get', 'core.sshCommand'], true);
  if (sshCommand.code === 0 && sshCommand.output) {
    git(staging, ['config', 'core.sshCommand', sshCommand.output]);
  }
}

/** 仓库与 integration HEAD 共同构成通知幂等键。 */
export function customReleaseEventId(repository, integrationHead) {
  return createHash('sha256').update(`${repository}\0${integrationHead}`).digest('hex');
}

/** createdAt 只记录首次入队时间，不参与同一 Git HEAD 的事件身份比较。 */
function sameCustomReleaseEvent(left, right) {
  return JSON.stringify({ ...left, createdAt: '' }) === JSON.stringify({ ...right, createdAt: '' });
}

/** 从 numstat 计算文件数和文本增删行；二进制文件计文件数但不虚构行数。 */
export function summarizeNumstat(raw) {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of String(raw || '').split(/\r?\n/).filter(Boolean)) {
    const [added, removed] = line.split('\t');
    files += 1;
    if (/^\d+$/.test(added || '')) insertions += Number(added);
    if (/^\d+$/.test(removed || '')) deletions += Number(removed);
  }
  return { files, insertions, deletions };
}

/** 选第一父链上离 HEAD 最近的冻结/部署边界；没有更近标签时使用 custom/prod。 */
export function selectCustomReleaseBase({ firstParentCommits, productionHead, taggedHeads }) {
  const candidates = [{ ref: 'custom/prod', head: productionHead }, ...taggedHeads]
    .map(candidate => ({ ...candidate, index: firstParentCommits.indexOf(candidate.head) }))
    .filter(candidate => candidate.index >= 0);
  candidates.sort((a, b) => a.index - b.index || (a.ref === 'custom/prod' ? 1 : -1));
  const selected = candidates[0];
  if (!selected) throw new Error('custom/prod 与 custom/dev 第一父链不一致');
  return { ref: selected.ref, head: selected.head };
}

/**
 * 以 expected source HEAD 在最新远端 custom/dev 上创建可审计 merge。
 * push 竞态最多重建三次临时 clone，不会重置或污染规范 checkout。
 */
export function joinCustomRelease({ repoRoot, remote, sourceRef, expectedHead, title }) {
  const sourceBranch = normalizeSourceBranch(remote, sourceRef);
  if (!SHA.test(expectedHead)) throw new Error('expected source HEAD 无效');
  const normalizedTitle = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!normalizedTitle) throw new Error('合入标题不能为空');
  const branch = gitText(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch !== 'custom/dev') throw new Error('release:join 只允许在 custom/dev checkout 执行');
  if (gitText(repoRoot, ['status', '--porcelain'])) throw new Error('custom/dev checkout 存在未提交改动');
  const originUrl = gitText(repoRoot, ['remote', 'get-url', remote]);
  const userName = gitText(repoRoot, ['config', 'user.name']);
  const userEmail = gitText(repoRoot, ['config', 'user.email']);
  let joined;

  for (let attempt = 1; attempt <= 3 && !joined; attempt += 1) {
    const staging = mkdtempSync(join(tmpdir(), 'botmux-release-join-'));
    try {
      git(staging, ['clone', '--quiet', '--shared', '--no-checkout', repoRoot, staging]);
      inheritReleaseJoinTransportConfig(repoRoot, staging);
      git(staging, ['remote', 'set-url', remote, originUrl]);
      git(staging, [
        'fetch', '--prune', remote,
        '+refs/heads/custom/dev:refs/remotes/origin/custom/dev',
        `+refs/heads/${sourceBranch}:refs/remotes/origin/${sourceBranch}`,
      ]);
      const beforeHead = gitText(staging, ['rev-parse', 'origin/custom/dev']);
      const sourceHead = gitText(staging, ['rev-parse', `origin/${sourceBranch}`]);
      if (sourceHead !== expectedHead) throw new Error(`开发分支远端 HEAD 已变化: ${sourceHead}`);
      if (isAncestor(staging, sourceHead, beforeHead)) throw new Error('该开发分支已经进入 custom/dev');
      git(staging, ['checkout', '-B', 'custom/dev', 'origin/custom/dev']);
      git(staging, [
        '-c', `user.name=${userName}`,
        '-c', `user.email=${userEmail}`,
        'merge', '--no-ff', `origin/${sourceBranch}`,
        '-m', `merge(release): ${normalizedTitle}`,
        '-m', `Source-Ref: ${remote}/${sourceBranch}\nSource-Head: ${expectedHead}`,
      ]);
      const integrationHead = gitText(staging, ['rev-parse', 'HEAD']);
      const pushed = git(staging, ['push', remote, 'HEAD:refs/heads/custom/dev'], true);
      if (pushWasRaced(pushed)) continue;
      if (pushed.code !== 0) throw new CommandError('git push custom/dev', pushed.output);
      const remoteHead = gitText(staging, ['ls-remote', remote, 'refs/heads/custom/dev']).split(/\s+/)[0];
      if (remoteHead !== integrationHead) throw new Error('custom/dev push 后远端 HEAD 回读不一致');
      joined = { sourceBranch, sourceHead, beforeHead, integrationHead, mergeCommit: integrationHead, title: normalizedTitle };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  if (!joined) throw new Error('custom/dev 连续发生 push 竞态，未合入也未发送通知');
  git(repoRoot, ['fetch', remote, '+refs/heads/custom/dev:refs/remotes/origin/custom/dev']);
  git(repoRoot, ['merge', '--ff-only', 'origin/custom/dev']);
  if (gitText(repoRoot, ['rev-parse', 'HEAD']) !== joined.integrationHead) {
    throw new Error('规范 custom/dev checkout 未快进到新远端 HEAD');
  }
  return joined;
}

/** 复用主发布脚本的状态读取，完成 join、远端回读和通知排队三段事务。 */
export function executeCustomReleaseJoin({
  repoRoot,
  config,
  args,
  assertClean,
  fetchState,
  releaseState,
  localHead,
}) {
  assertClean();
  fetchState(config);
  const before = releaseState(config);
  if (localHead() !== before.integrationHead) throw new Error('本地 custom/dev 与远端不一致');
  if (!before.productionIsAncestor) {
    throw new Error('custom/prod 不是 custom/dev 的祖先，必须先修复发布分支关系，未执行合入');
  }
  const value = name => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? '' : '';
  };
  const sourceRef = value('--source');
  const expectedHead = value('--expected-head');
  const title = value('--title');
  if (!sourceRef || !expectedHead || !title) {
    throw new Error('release:join 必须提供 --source、--expected-head 和 --title');
  }
  const joined = joinCustomRelease({
    repoRoot,
    remote: config.originRemote,
    sourceRef,
    expectedHead,
    title,
  });
  fetchState(config);
  const after = releaseState(config);
  if (after.integrationHead !== joined.integrationHead) throw new Error('合入后 release 状态与远端 HEAD 不一致');
  if (!after.productionIsAncestor) throw new Error('合入后 custom/prod 分支关系被并发改动，未生成冻结卡');
  const notification = queueCustomReleaseEvent({
    repoRoot,
    repository: config.originRepo,
    productionHead: after.productionHead,
    pendingVersion: after.pendingVersion,
    joined,
  });
  return { ...after, ...joined, notification };
}

function resolveDataDir(env = process.env) {
  if (env.SESSION_DATA_DIR?.trim()) return resolve(env.SESSION_DATA_DIR.trim());
  const configDir = join(env.HOME || homedir(), '.botmux');
  const breadcrumb = join(configDir, '.data-dir');
  try {
    const file = lstatSync(breadcrumb);
    const candidate = readFileSync(breadcrumb, 'utf8').trim();
    if (file.isFile() && !file.isSymbolicLink() && file.size <= 4096 && isAbsolute(candidate)
      && existsSync(candidate) && statSync(candidate).isDirectory()) return resolve(candidate);
  } catch { /* 缺失或非法 breadcrumb 回退稳定目录 */ }
  return join(configDir, 'data');
}

function taggedHeads(repoRoot) {
  const tags = gitText(repoRoot, ['tag', '--list', 'release/v*-custom.*', '--list', 'deploy/v*-custom.*'])
    .split(/\r?\n/).filter(Boolean);
  return tags.map(ref => ({ ref, head: gitText(repoRoot, ['rev-parse', `${ref}^{commit}`]) }));
}

/** 脚本侧按源分支与 Conventional Commit 归一化卡片小标签。 */
export function customReleaseChangeKind({ sourceRef = '', sourceSubject = '', title = '' }) {
  const mapping = {
    feat: 'feat', feature: 'feat',
    fix: 'bugfix', bugfix: 'bugfix', hotfix: 'bugfix',
    opt: 'opt', perf: 'opt', refactor: 'opt',
  };
  const branchToken = String(sourceRef).toLowerCase().match(
    /(?:^|\/)(feat|feature|fix|bugfix|hotfix|opt|perf|refactor)(?:[\/_-]|$)/,
  )?.[1];
  const subjectToken = [sourceSubject, title]
    .map(value => String(value).trim().toLowerCase().match(
      /^(feat|feature|fix|bugfix|hotfix|opt|perf|refactor)(?:\([^)]*\))?!?:/,
    )?.[1])
    .find(Boolean);
  return mapping[branchToken || subjectToken] || undefined;
}

function sourceRefFromMerge(repoRoot, mergeCommit, current) {
  if (mergeCommit === current.mergeCommit) return `origin/${current.sourceBranch}`;
  return gitText(repoRoot, ['log', '-1', '--format=%B', mergeCommit])
    .match(/^Source-Ref:\s*(\S+)\s*$/m)?.[1] || '';
}

function changeItems(repoRoot, baseHead, integrationHead, current) {
  const commits = gitText(repoRoot, ['rev-list', '--first-parent', '--merges', '--reverse', `${baseHead}..${integrationHead}`])
    .split(/\r?\n/).filter(Boolean);
  return commits.slice(-100).map(mergeCommit => {
    const parents = gitText(repoRoot, ['rev-list', '--parents', '-n', '1', mergeCommit]).split(/\s+/).slice(1);
    const sourceHead = parents[1] || mergeCommit;
    const sourceSubject = gitText(repoRoot, ['log', '-1', '--format=%s', sourceHead]);
    let title = mergeCommit === current.mergeCommit
      ? current.title
      : gitText(repoRoot, ['log', '-1', '--format=%s', mergeCommit]).replace(/^merge\(release\):\s*/, '');
    if (/^merge: 加入待发版/.test(title) && parents[1]) {
      title = gitText(repoRoot, ['log', '-1', '--format=%s', parents[1]]);
    }
    const kind = customReleaseChangeKind({
      sourceRef: sourceRefFromMerge(repoRoot, mergeCommit, current),
      sourceSubject,
      title,
    });
    return { title: title.slice(0, 160), mergeCommit, sourceHead, ...(kind ? { kind } : {}) };
  });
}

function statsBetween(repoRoot, older, newer) {
  return {
    commits: Number(gitText(repoRoot, ['rev-list', '--count', `${older}..${newer}`])),
    ...summarizeNumstat(gitText(repoRoot, ['diff', '--numstat', `${older}..${newer}`])),
  };
}

/** 根据已 push 的 Git 真相生成事件并原子排入 daemon 持久化队列。 */
export function queueCustomReleaseEvent({ repoRoot, repository, productionHead, pendingVersion, joined, dataDir }) {
  const firstParentCommits = gitText(repoRoot, ['rev-list', '--first-parent', joined.integrationHead])
    .split(/\r?\n/).filter(Boolean);
  const base = selectCustomReleaseBase({ firstParentCommits, productionHead, taggedHeads: taggedHeads(repoRoot) });
  const eventId = customReleaseEventId(repository, joined.integrationHead);
  const event = {
    schemaVersion: 1,
    eventId,
    repository,
    repoRoot: realpathSafe(repoRoot),
    createdAt: new Date().toISOString(),
    source: { ref: `origin/${joined.sourceBranch}`, head: joined.sourceHead, title: joined.title },
    integration: { branch: 'custom/dev', previousHead: joined.beforeHead, head: joined.integrationHead, mergeCommit: joined.mergeCommit },
    production: { branch: 'custom/prod', head: productionHead },
    release: { pendingVersion, baseRef: base.ref, baseHead: base.head },
    current: statsBetween(repoRoot, joined.beforeHead, joined.integrationHead),
    cumulative: changeItems(repoRoot, base.head, joined.integrationHead, joined),
    totals: statsBetween(repoRoot, base.head, joined.integrationHead),
  };
  const root = join(dataDir || resolveDataDir(), 'custom-release-notifications', 'events');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try { chmodSync(root, 0o700); } catch { /* 非 POSIX 环境保持原权限 */ }
  const target = join(root, `${eventId}.json`);
  const record = { schemaVersion: 1, event, state: { status: 'queued', attempts: 0, updatedAt: new Date().toISOString() } };
  if (existsSync(target)) {
    const existing = JSON.parse(readFileSync(target, 'utf8'));
    if (!sameCustomReleaseEvent(existing.event, event)) throw new Error(`发版通知事件 ID 冲突: ${eventId}`);
    return { eventId, status: existing.state?.status || 'queued' };
  }
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, target);
  return { eventId, status: 'queued' };
}

function realpathSafe(path) {
  return realpathSync(path);
}
