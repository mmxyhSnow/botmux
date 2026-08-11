/**
 * 官方同步 prepare/verify/promote 状态契约。
 * 所有推进动作都必须重新核对 prepare 冻结的分支、候选和 runtime/current 快照。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { runtimeCurrentRoot } from '../runtime-release-files.mjs';
import { cleanTracked, git } from './source-update-support.mjs';

const PHASES = new Set(['all', 'prepare', 'verify', 'promote']);
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** 解析可选阶段；默认 all 保持 Dashboard 一键同步兼容。 */
export function sourceUpdatePhase(argv) {
  const index = argv.indexOf('--phase');
  const phase = index < 0 ? 'all' : argv[index + 1];
  if (!PHASES.has(phase)) throw new Error('无效 --phase，仅支持 prepare、verify、promote 或 all');
  return phase;
}

/** 为当前 fork 生成唯一的候选状态文件位置。 */
export function sourceUpdateStatePath(config) {
  return join(homedir(), '.botmux', 'source-updates', config.originRepo.replace('/', '-'), 'active.json');
}

/** 原子持久化阶段结果，失败时不会留下半写状态。 */
export function writeSourceUpdateState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

/** 读取并校验本脚本产生的候选状态。 */
export function readSourceUpdateState(path, root, config) {
  if (!existsSync(path)) throw new Error('没有 prepare 候选，请先执行 --phase prepare');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  const validStatus = ['prepared', 'verified', 'promoted'].includes(state?.status);
  if (
    state?.schemaVersion !== 1
    || !validStatus
    || state.root !== root
    || JSON.stringify(state.config) !== JSON.stringify(config)
    || !SHA_PATTERN.test(state.candidateHead ?? '')
  ) throw new Error('官方同步候选状态无效或不属于当前仓库');
  return state;
}

function remoteHead(root, remote, branch) {
  const line = git(root, ['ls-remote', '--heads', remote, `refs/heads/${branch}`]);
  const head = line.split(/\s+/)[0];
  if (!SHA_PATTERN.test(head ?? '')) throw new Error(`无法回读 ${remote}/${branch}`);
  return head;
}

/** 实时捕获两个保护分支、生产 checkout 与 runtime/current 身份。 */
export function captureSourceUpdateSnapshot(root, config) {
  const runtimeRoot = runtimeCurrentRoot(git);
  return {
    rootHead: git(root, ['rev-parse', 'HEAD']),
    integrationHead: remoteHead(root, config.originRemote, 'custom/dev'),
    productionHead: remoteHead(root, config.originRemote, config.productionBranch),
    runtimeRoot,
    runtimeHead: git(runtimeRoot, ['rev-parse', 'HEAD']),
  };
}

/** 读取隔离候选 HEAD 与 clean 状态，避免验证后被静默改写。 */
export function captureCandidateSnapshot(path) {
  return {
    head: git(path, ['rev-parse', 'HEAD']),
    clean: cleanTracked(path),
  };
}

/** 快照任一字段漂移都拒绝继续，不把失败降级为警告。 */
export function assertSourceUpdateSnapshot(expected, actual) {
  for (const key of ['rootHead', 'integrationHead', 'productionHead', 'runtimeRoot', 'runtimeHead']) {
    if (expected?.[key] !== actual?.[key]) {
      throw new Error(`官方同步保护快照已变化：${key}`);
    }
  }
}

function assertCandidate(state, actual) {
  if (actual?.head !== state.candidateHead) throw new Error('官方同步候选 HEAD 已变化');
  if (actual?.clean !== true) throw new Error('官方同步候选存在未提交改动');
}

/**
 * 执行 verify 契约：先核对快照，再跑门禁，最后二次核对；
 * runGates 抛错时函数不生成 verified 状态，也不包含任何 ref/runtime 写入。
 */
export async function verifyPreparedSourceUpdate(state, operations) {
  if (state.status !== 'prepared') throw new Error(`候选状态 ${state.status} 不能执行 verify`);
  assertSourceUpdateSnapshot(state.snapshot, await operations.snapshot());
  assertCandidate(state, await operations.candidate());
  await operations.runGates();
  assertSourceUpdateSnapshot(state.snapshot, await operations.snapshot());
  assertCandidate(state, await operations.candidate());
  return { ...state, status: 'verified', verifiedAt: operations.now().toISOString() };
}

/** promote 前再次要求 verified 状态及完全未漂移的快照。 */
export async function assertSourceUpdatePromotable(state, operations) {
  if (state.status !== 'verified') throw new Error(`候选状态 ${state.status} 不能执行 promote`);
  assertSourceUpdateSnapshot(state.snapshot, await operations.snapshot());
  assertCandidate(state, await operations.candidate());
}
