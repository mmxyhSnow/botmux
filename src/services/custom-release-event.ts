/**
 * 自定义发版合入事件及持久化队列。
 * Git 合入脚本先落盘，primary daemon 再负责私聊投递和冻结状态收敛。
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface CustomReleaseChangeStats {
  commits: number;
  files: number;
  insertions: number;
  deletions: number;
}

export interface CustomReleaseItem {
  title: string;
  mergeCommit: string;
  sourceHead: string;
}

export interface CustomReleaseEvent {
  schemaVersion: 1;
  eventId: string;
  repository: string;
  repoRoot: string;
  createdAt: string;
  source: { ref: string; head: string; title: string };
  integration: {
    branch: 'custom/dev';
    previousHead: string;
    head: string;
    mergeCommit: string;
  };
  production: { branch: 'custom/prod'; head: string };
  release: { pendingVersion: string; baseRef: string; baseHead: string };
  current: CustomReleaseChangeStats;
  cumulative: CustomReleaseItem[];
  totals: CustomReleaseChangeStats;
}

export type CustomReleaseEventStatus =
  | 'queued'
  | 'delivering'
  | 'delivery_failed'
  | 'delivered'
  | 'freezing'
  | 'freeze_failed'
  | 'stale'
  | 'frozen'
  | 'promoting'
  | 'promote_failed'
  | 'promoted'
  | 'deploying'
  | 'deploy_failed'
  | 'deployed';

export interface CustomReleaseEventState {
  status: CustomReleaseEventStatus;
  attempts: number;
  updatedAt: string;
  messageId?: string;
  lastError?: string;
  supersededBy?: string;
  candidateTag?: string;
  productionHead?: string;
  deployTag?: string;
  notifiedStatus?: CustomReleaseEventStatus;
}

export interface CustomReleaseEventRecord {
  schemaVersion: 1;
  event: CustomReleaseEvent;
  state: CustomReleaseEventState;
}

const HEX_40 = /^[a-f0-9]{40}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const SAFE_REF = /^[A-Za-z0-9._/-]{1,240}$/;
const VERSION = /^\d+\.\d+\.\d+-custom\.\d+$/;
const STATUS = new Set<CustomReleaseEventStatus>([
  'queued', 'delivering', 'delivery_failed', 'delivered',
  'freezing', 'freeze_failed', 'stale', 'frozen',
  'promoting', 'promote_failed', 'promoted',
  'deploying', 'deploy_failed', 'deployed',
]);

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function shortText(value: unknown, max = 240): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value);
}

function sha(value: unknown): value is string {
  return typeof value === 'string' && HEX_40.test(value);
}

function stats(value: unknown): value is CustomReleaseChangeStats {
  if (!plain(value)) return false;
  return ['commits', 'files', 'insertions', 'deletions'].every(key =>
    Number.isSafeInteger(value[key]) && Number(value[key]) >= 0);
}

function parseEvent(value: unknown): CustomReleaseEvent {
  if (!plain(value) || value.schemaVersion !== 1 || !HEX_64.test(String(value.eventId ?? ''))) {
    throw new Error('自定义发版事件格式无效');
  }
  const source = value.source;
  const integration = value.integration;
  const production = value.production;
  const release = value.release;
  if (
    !shortText(value.repository)
    || !shortText(value.repoRoot, 4096)
    || !isAbsolute(value.repoRoot)
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))
    || !plain(source)
    || !SAFE_REF.test(String(source.ref ?? ''))
    || !sha(source.head)
    || !shortText(source.title, 160)
    || !plain(integration)
    || integration.branch !== 'custom/dev'
    || !sha(integration.previousHead)
    || !sha(integration.head)
    || !sha(integration.mergeCommit)
    || !plain(production)
    || production.branch !== 'custom/prod'
    || !sha(production.head)
    || !plain(release)
    || !shortText(release.baseRef)
    || !sha(release.baseHead)
    || typeof release.pendingVersion !== 'string'
    || !VERSION.test(release.pendingVersion)
    || !stats(value.current)
    || !stats(value.totals)
    || !Array.isArray(value.cumulative)
    || value.cumulative.length > 100
  ) throw new Error('自定义发版事件字段无效');
  for (const item of value.cumulative) {
    if (!plain(item) || !shortText(item.title, 160) || !sha(item.mergeCommit) || !sha(item.sourceHead)) {
      throw new Error('自定义发版累计项无效');
    }
  }
  return value as unknown as CustomReleaseEvent;
}

export function parseCustomReleaseRecord(value: unknown): CustomReleaseEventRecord {
  if (!plain(value) || value.schemaVersion !== 1 || !plain(value.state)) {
    throw new Error('自定义发版记录格式无效');
  }
  const event = parseEvent(value.event);
  const state = value.state;
  if (
    typeof state.status !== 'string'
    || !STATUS.has(state.status as CustomReleaseEventStatus)
    || !Number.isSafeInteger(state.attempts)
    || Number(state.attempts) < 0
    || typeof state.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(state.updatedAt))
  ) throw new Error('自定义发版状态无效');
  for (const key of ['messageId', 'lastError', 'supersededBy', 'candidateTag', 'deployTag'] as const) {
    if (state[key] !== undefined && !shortText(state[key], key === 'lastError' ? 1000 : 240)) {
      throw new Error(`自定义发版状态字段无效: ${key}`);
    }
  }
  if (state.productionHead !== undefined && !sha(state.productionHead)) {
    throw new Error('自定义发版状态字段无效: productionHead');
  }
  if (
    state.notifiedStatus !== undefined
    && (typeof state.notifiedStatus !== 'string' || !STATUS.has(state.notifiedStatus as CustomReleaseEventStatus))
  ) throw new Error('自定义发版状态字段无效: notifiedStatus');
  return { schemaVersion: 1, event, state: state as unknown as CustomReleaseEventState };
}

/** 飞书消息 UUID 对同一合入事件稳定，重试不会生成重复私聊。 */
export function customReleaseMessageUuid(eventId: string): string {
  return `release-${createHash('sha256').update(eventId).digest('hex').slice(0, 32)}`;
}

/** createdAt 只保留首次落盘值，不影响同一仓库 HEAD 的幂等判断。 */
function sameEvent(left: CustomReleaseEvent, right: CustomReleaseEvent): boolean {
  return JSON.stringify({ ...left, createdAt: '' }) === JSON.stringify({ ...right, createdAt: '' });
}

/** 单文件原子账本避免整表并发覆盖；每个 integration HEAD 只对应一个事件。 */
export class CustomReleaseEventStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'custom-release-notifications', 'events');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { chmodSync(this.dir, 0o700); } catch { /* 非 POSIX 或无权限时保持原状态 */ }
  }

  private path(eventId: string): string {
    if (!HEX_64.test(eventId)) throw new Error('自定义发版事件 ID 无效');
    return join(this.dir, `${eventId}.json`);
  }

  enqueue(event: CustomReleaseEvent): CustomReleaseEventRecord {
    const normalized = parseEvent(event);
    const existing = this.get(normalized.eventId);
    if (existing) {
      if (!sameEvent(existing.event, normalized)) {
        throw new Error(`自定义发版事件 ID 冲突: ${normalized.eventId}`);
      }
      return existing;
    }
    const record: CustomReleaseEventRecord = {
      schemaVersion: 1,
      event: normalized,
      state: { status: 'queued', attempts: 0, updatedAt: new Date().toISOString() },
    };
    this.write(record);
    return record;
  }

  get(eventId: string): CustomReleaseEventRecord | undefined {
    const path = this.path(eventId);
    if (!existsSync(path)) return undefined;
    return parseCustomReleaseRecord(JSON.parse(readFileSync(path, 'utf8')));
  }

  list(): CustomReleaseEventRecord[] {
    return readdirSync(this.dir)
      .filter(name => HEX_64.test(name.replace(/\.json$/, '')) && name.endsWith('.json'))
      .map(name => this.get(name.slice(0, -5)))
      .filter((record): record is CustomReleaseEventRecord => !!record)
      .sort((a, b) => a.event.createdAt.localeCompare(b.event.createdAt));
  }

  listDeliverable(): CustomReleaseEventRecord[] {
    return this.list().filter(record =>
      record.state.status === 'queued'
      || record.state.status === 'delivery_failed'
      || record.state.status === 'delivering');
  }

  updateState(eventId: string, patch: Partial<CustomReleaseEventState>): CustomReleaseEventRecord {
    const record = this.get(eventId);
    if (!record) throw new Error(`自定义发版事件不存在: ${eventId}`);
    const next = parseCustomReleaseRecord({
      ...record,
      state: {
        ...record.state,
        ...patch,
        updatedAt: patch.updatedAt ?? new Date().toISOString(),
      },
    });
    this.write(next);
    return next;
  }

  previousDelivered(record: CustomReleaseEventRecord): CustomReleaseEventRecord | undefined {
    return this.list().reverse().find(candidate =>
      candidate.event.eventId !== record.event.eventId
      && candidate.event.repository === record.event.repository
      && candidate.state.status === 'delivered'
      && !!candidate.state.messageId);
  }

  private write(record: CustomReleaseEventRecord): void {
    atomicWriteFileSync(this.path(record.event.eventId), `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
  }
}
