/**
 * Botmux 普通工作轮次的交付账本。
 *
 * 每次状态变化独立追加一行 JSON；进程重启后通过重放事件恢复状态，
 * 避免 CLI 已产生结论但飞书尚未收到时丢失交付责任。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export interface TurnDeliveryId {
  larkAppId: string;
  sessionId: string;
  turnId: string;
  dispatchAttempt: number;
}

export interface TurnDeliveryRecord {
  id: TurnDeliveryId;
  anchor: string;
  chatId: string;
  scope: 'thread' | 'chat';
  cliId: string;
  acceptedAtMs: number;
  promptSummary: string;
  nativeTurnId?: string;
  final?: {
    content: string;
    outcome: 'completed' | 'failed' | 'cancelled';
    observedAtMs: number;
  };
  delivery?: {
    state: 'pending' | 'delivered';
    uuid: string;
    messageId?: string;
    atMs: number;
  };
  recovery?: {
    state: 'required' | 'resumed' | 'failed' | 'suppressed';
    atMs: number;
    reason?: string;
    workerGeneration?: number;
  };
}

type AcceptedRecord = Omit<TurnDeliveryRecord, 'nativeTurnId' | 'final' | 'delivery' | 'recovery'>;
type FinalRecord = NonNullable<TurnDeliveryRecord['final']>;

type LedgerEvent =
  | { type: 'accepted'; record: AcceptedRecord; writtenAtMs: number }
  | { type: 'running'; id: TurnDeliveryId; nativeTurnId?: string; writtenAtMs: number }
  | { type: 'final'; id: TurnDeliveryId; final: FinalRecord; writtenAtMs: number }
  | { type: 'delivery_pending'; id: TurnDeliveryId; uuid: string; atMs: number; writtenAtMs: number }
  | { type: 'delivered'; id: TurnDeliveryId; messageId: string; deliveredAtMs: number; writtenAtMs: number }
  | { type: 'recovery_required'; id: TurnDeliveryId; atMs: number; writtenAtMs: number }
  | { type: 'recovery_resumed'; id: TurnDeliveryId; atMs: number; workerGeneration: number; writtenAtMs: number }
  | { type: 'recovery_suppressed'; id: TurnDeliveryId; atMs: number; reason: string; writtenAtMs: number }
  | { type: 'recovery_failed'; id: TurnDeliveryId; atMs: number; reason: string; writtenAtMs: number };

function turnKey(id: TurnDeliveryId): string {
  return JSON.stringify([id.larkAppId, id.sessionId, id.turnId, id.dispatchAttempt]);
}

function isTurnDeliveryId(value: unknown): value is TurnDeliveryId {
  if (!value || typeof value !== 'object') return false;
  const id = value as Record<string, unknown>;
  return typeof id.larkAppId === 'string'
    && typeof id.sessionId === 'string'
    && typeof id.turnId === 'string'
    && Number.isSafeInteger(id.dispatchAttempt)
    && Number(id.dispatchAttempt) >= 0;
}

function isAcceptedRecord(value: unknown): value is AcceptedRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return isTurnDeliveryId(record.id)
    && typeof record.anchor === 'string'
    && typeof record.chatId === 'string'
    && (record.scope === 'thread' || record.scope === 'chat')
    && typeof record.cliId === 'string'
    && typeof record.acceptedAtMs === 'number'
    && typeof record.promptSummary === 'string';
}

function parseEvent(line: string): LedgerEvent | undefined {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === 'accepted' && isAcceptedRecord(event.record)) return event as LedgerEvent;
    if (!isTurnDeliveryId(event.id)) return undefined;
    if (event.type === 'running') return event as LedgerEvent;
    if (event.type === 'final' && event.final && typeof event.final === 'object') return event as LedgerEvent;
    if (event.type === 'delivery_pending' && typeof event.uuid === 'string') return event as LedgerEvent;
    if (event.type === 'delivered' && typeof event.messageId === 'string') return event as LedgerEvent;
    if (event.type === 'recovery_required') return event as LedgerEvent;
    if (
      event.type === 'recovery_resumed'
      && Number.isSafeInteger(event.workerGeneration)
      && Number(event.workerGeneration) > 0
    ) return event as LedgerEvent;
    if (event.type === 'recovery_suppressed' && typeof event.reason === 'string') return event as LedgerEvent;
    if (event.type === 'recovery_failed' && typeof event.reason === 'string') return event as LedgerEvent;
  } catch {
    // 崩溃可能留下半行，恢复时忽略损坏尾部并保留此前完整事件。
  }
  return undefined;
}

function applyEvent(records: Map<string, TurnDeliveryRecord>, event: LedgerEvent): void {
  if (event.type === 'accepted') {
    const key = turnKey(event.record.id);
    if (!records.has(key)) records.set(key, { ...event.record, id: { ...event.record.id } });
    return;
  }
  const record = records.get(turnKey(event.id));
  if (!record) return;
  if (record.delivery?.state === 'delivered') return;

  switch (event.type) {
    case 'running':
      if (!record.nativeTurnId && event.nativeTurnId) record.nativeTurnId = event.nativeTurnId;
      if (record.recovery?.state === 'suppressed') record.recovery = undefined;
      break;
    case 'final':
      if (!record.final) record.final = { ...event.final };
      if (record.recovery?.state === 'suppressed') record.recovery = undefined;
      break;
    case 'delivery_pending':
      record.delivery = { state: 'pending', uuid: event.uuid, atMs: event.atMs };
      break;
    case 'delivered':
      record.delivery = {
        state: 'delivered',
        uuid: record.delivery?.uuid ?? stableTurnDeliveryUuid(record.id),
        messageId: event.messageId,
        atMs: event.deliveredAtMs,
      };
      break;
    case 'recovery_required':
      record.recovery = { state: 'required', atMs: event.atMs };
      break;
    case 'recovery_resumed':
      record.recovery = {
        state: 'resumed',
        atMs: event.atMs,
        workerGeneration: event.workerGeneration,
      };
      break;
    case 'recovery_suppressed':
      record.recovery = { state: 'suppressed', atMs: event.atMs, reason: event.reason };
      break;
    case 'recovery_failed':
      record.recovery = { state: 'failed', atMs: event.atMs, reason: event.reason };
      break;
  }
}

export function stableTurnDeliveryUuid(id: TurnDeliveryId): string {
  const canonical = [id.larkAppId, id.sessionId, id.turnId, String(id.dispatchAttempt)].join('\0');
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return `bmx-final-${digest}`;
}

export class TurnDeliveryLedger {
  private readonly ledgerDir: string;
  private readonly now: () => number;

  constructor(readonly dataDir: string, opts: { now?: () => number } = {}) {
    this.ledgerDir = join(dataDir, 'turn-delivery');
    this.now = opts.now ?? Date.now;
  }

  recordAccepted(input: AcceptedRecord): void {
    this.append(input.id.larkAppId, { type: 'accepted', record: input, writtenAtMs: this.now() });
  }

  recordRunning(id: TurnDeliveryId, input: { atMs: number; nativeTurnId?: string }): void {
    this.append(id.larkAppId, { type: 'running', id, nativeTurnId: input.nativeTurnId, writtenAtMs: this.now() });
  }

  recordFinal(id: TurnDeliveryId, input: FinalRecord): void {
    this.append(id.larkAppId, { type: 'final', id, final: input, writtenAtMs: this.now() });
  }

  recordDeliveryPending(id: TurnDeliveryId, input: { uuid: string; atMs: number }): void {
    this.append(id.larkAppId, { type: 'delivery_pending', id, ...input, writtenAtMs: this.now() });
  }

  recordDelivered(id: TurnDeliveryId, input: { messageId: string; deliveredAtMs: number }): void {
    this.append(id.larkAppId, { type: 'delivered', id, ...input, writtenAtMs: this.now() });
  }

  recordRecoveryRequired(id: TurnDeliveryId, atMs: number): void {
    this.append(id.larkAppId, { type: 'recovery_required', id, atMs, writtenAtMs: this.now() });
  }

  /** 续跑指令发送前持久化接管 generation，防止同一 worker 空闲重绘时重复注入。 */
  recordRecoveryResumed(
    id: TurnDeliveryId,
    input: { atMs: number; workerGeneration: number },
  ): void {
    this.append(id.larkAppId, {
      type: 'recovery_resumed',
      id,
      ...input,
      writtenAtMs: this.now(),
    });
  }

  /** 将没有执行中证据的历史轮次静默结算，避免每次 daemon 重启再次扫到并刷屏。 */
  recordRecoverySuppressed(id: TurnDeliveryId, input: { atMs: number; reason: string }): void {
    this.append(id.larkAppId, { type: 'recovery_suppressed', id, ...input, writtenAtMs: this.now() });
  }

  recordRecoveryFailed(id: TurnDeliveryId, input: { atMs: number; reason: string }): void {
    this.append(id.larkAppId, { type: 'recovery_failed', id, ...input, writtenAtMs: this.now() });
  }

  get(id: TurnDeliveryId): TurnDeliveryRecord | undefined {
    return this.readApp(id.larkAppId).get(turnKey(id));
  }

  listOutstanding(larkAppId: string): TurnDeliveryRecord[] {
    return [...this.readApp(larkAppId).values()]
      .filter(record => record.delivery?.state !== 'delivered'
        && record.recovery?.state !== 'suppressed')
      .sort((left, right) => left.acceptedAtMs - right.acceptedAtMs);
  }

  compact(input: { deliveredBeforeMs: number }): void {
    if (!existsSync(this.ledgerDir)) return;
    for (const name of readdirSync(this.ledgerDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(this.ledgerDir, name);
      const records = this.readPath(path);
      const kept = [...records.values()].filter(record =>
        (record.delivery?.state !== 'delivered' && record.recovery?.state !== 'suppressed')
        || (record.delivery?.state === 'delivered'
          ? record.delivery.atMs >= input.deliveredBeforeMs
          : (record.recovery?.atMs ?? Number.POSITIVE_INFINITY) >= input.deliveredBeforeMs));
      const body = kept.flatMap(record => this.snapshotEvents(record))
        .map(event => JSON.stringify(event))
        .join('\n');
      const temporaryPath = `${path}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, body ? `${body}\n` : '', 'utf8');
      renameSync(temporaryPath, path);
    }
  }

  private append(larkAppId: string, event: LedgerEvent): void {
    mkdirSync(this.ledgerDir, { recursive: true });
    appendFileSync(this.appPath(larkAppId), `${JSON.stringify(event)}\n`, 'utf8');
  }

  private readApp(larkAppId: string): Map<string, TurnDeliveryRecord> {
    return this.readPath(this.appPath(larkAppId), larkAppId);
  }

  private readPath(path: string, larkAppId?: string): Map<string, TurnDeliveryRecord> {
    const records = new Map<string, TurnDeliveryRecord>();
    if (!existsSync(path)) return records;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const event = parseEvent(line);
      if (!event) continue;
      const eventId = event.type === 'accepted' ? event.record.id : event.id;
      if (larkAppId && eventId.larkAppId !== larkAppId) continue;
      applyEvent(records, event);
    }
    return records;
  }

  private appPath(larkAppId: string): string {
    const encoded = createHash('sha256').update(larkAppId).digest('hex');
    return join(this.ledgerDir, `${encoded}.jsonl`);
  }

  private snapshotEvents(record: TurnDeliveryRecord): LedgerEvent[] {
    const writtenAtMs = this.now();
    const { nativeTurnId, final, delivery, recovery, ...accepted } = record;
    const events: LedgerEvent[] = [{ type: 'accepted', record: accepted, writtenAtMs }];
    if (nativeTurnId) events.push({ type: 'running', id: record.id, nativeTurnId, writtenAtMs });
    if (final) events.push({ type: 'final', id: record.id, final, writtenAtMs });
    if (delivery?.state === 'pending') {
      events.push({ type: 'delivery_pending', id: record.id, uuid: delivery.uuid, atMs: delivery.atMs, writtenAtMs });
    } else if (delivery?.state === 'delivered') {
      events.push({ type: 'delivery_pending', id: record.id, uuid: delivery.uuid, atMs: delivery.atMs, writtenAtMs });
      events.push({ type: 'delivered', id: record.id, messageId: delivery.messageId ?? '', deliveredAtMs: delivery.atMs, writtenAtMs });
    }
    if (recovery?.state === 'required') {
      events.push({ type: 'recovery_required', id: record.id, atMs: recovery.atMs, writtenAtMs });
    } else if (recovery?.state === 'resumed' && recovery.workerGeneration) {
      events.push({
        type: 'recovery_resumed',
        id: record.id,
        atMs: recovery.atMs,
        workerGeneration: recovery.workerGeneration,
        writtenAtMs,
      });
    } else if (recovery?.state === 'suppressed') {
      events.push({ type: 'recovery_suppressed', id: record.id, atMs: recovery.atMs, reason: recovery.reason ?? 'not_in_flight', writtenAtMs });
    } else if (recovery?.state === 'failed') {
      events.push({ type: 'recovery_failed', id: record.id, atMs: recovery.atMs, reason: recovery.reason ?? '', writtenAtMs });
    }
    return events;
  }
}
