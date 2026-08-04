/**
 * Daemon 重启后的普通工作轮次追溯器。
 *
 * 只补偿用户可见的交付结果，不向 CLI 重放输入，因此不会重复安装、发布或删除等
 * 外部操作。每个轮次用短租约串行恢复，并复用稳定飞书 UUID 抵御发送边界崩溃。
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DaemonSession } from './types.js';
import {
  stableTurnDeliveryUuid,
  type TurnDeliveryLedger,
  type TurnDeliveryRecord,
} from '../services/turn-delivery-ledger.js';
import {
  ackCodexAppFinalOutbox,
  isSilentFinalOutput,
  readCodexAppFinalOutbox,
} from '../services/codex-app-final-outbox.js';

export type RestartTurnAction =
  | { kind: 'skip'; reason: string }
  | { kind: 'deliver-final'; content: string; outcome: 'completed' | 'failed' | 'cancelled' }
  | { kind: 'keep-following' }
  | { kind: 'settle-silently'; reason: string };

export interface RestartTurnDecisionInput {
  record: TurnDeliveryRecord;
  session?: { status: 'active' | 'closed'; working: boolean };
  reliableFinal?: {
    content: string;
    outcome: 'completed' | 'failed' | 'cancelled';
  };
}

export interface RestartTurnReconcileSummary {
  scanned: number;
  delivered: number;
  following: number;
  suppressed: number;
  deferred: number;
  skipped: number;
  failed: number;
}

type ReliableFinal = {
  content: string;
  outcome: 'completed' | 'failed' | 'cancelled';
  appTurnId?: string;
};

interface RecoveryLease {
  token: string;
  ownerPid: number;
  expiresAtMs: number;
}

export interface RestartTurnReconcileInput {
  dataDir: string;
  larkAppId: string;
  ledger: TurnDeliveryLedger;
  sessions: Iterable<DaemonSession>;
  send(
    record: TurnDeliveryRecord,
    content: string,
    uuid: string,
  ): Promise<string>;
  now?: () => number;
  settleUnconfirmed?: boolean;
  lookupSessionStatus?: (sessionId: string) => 'active' | 'closed' | undefined;
  log?: (message: string) => void;
}

export function decideRestartTurnAction(input: RestartTurnDecisionInput): RestartTurnAction {
  if (input.session?.status === 'closed') return { kind: 'skip', reason: 'session_closed' };
  const final = input.reliableFinal ?? input.record.final;
  if (final) {
    if (isSilentFinalOutput(final.content)) {
      return { kind: 'settle-silently', reason: 'silent_final_output' };
    }
    return {
      kind: 'deliver-final',
      content: final.content,
      outcome: final.outcome,
    };
  }
  if (input.session?.working) return { kind: 'keep-following' };
  return { kind: 'settle-silently', reason: 'not_in_flight' };
}

/** 只有精确属于当前执行任务的 turn 才能解除重启静默，不能复用 session 级 working。 */
function sessionState(
  ds: DaemonSession | undefined,
  record: TurnDeliveryRecord,
): RestartTurnDecisionInput['session'] {
  if (!ds) return undefined;
  const status = ds.session.status === 'closed' ? 'closed' : 'active';
  const workerAlive = !!ds.worker && !ds.worker.killed;
  const progress = ds.session.codexAppProgressCard;
  const progressRunning = progress?.phase === 'running'
    && progress.acceptedTurnIds?.includes(record.id.turnId) === true;
  const currentTurnId = (ds.currentReplyTarget ?? ds.session.currentReplyTarget)?.turnId
    ?? ds.session.quoteTargetId;
  const exactCurrentTurn = progressRunning || currentTurnId === record.id.turnId;
  const screenWorking = ds.lastScreenStatus === 'working'
    || ds.lastScreenStatus === 'analyzing'
    || ds.lastScreenStatus === 'starting';
  const working = workerAlive
    && exactCurrentTurn
    && (screenWorking || (progressRunning && ds.lastScreenStatus !== 'idle'));
  return { status, working: status === 'active' && working };
}

function reliableFinal(
  dataDir: string,
  record: TurnDeliveryRecord,
): ReliableFinal | undefined {
  const marker = record.cliId === 'codex-app'
    ? readCodexAppFinalOutbox(dataDir, record.id.sessionId).find(candidate =>
        candidate.replyTurnId === record.id.turnId
        && (!record.nativeTurnId || candidate.appTurnId === record.nativeTurnId))
    : undefined;
  if (record.final) {
    return {
      ...record.final,
      ...(marker?.content === record.final.content ? { appTurnId: marker.appTurnId } : {}),
    };
  }
  if (!marker) return undefined;
  return {
    content: marker.content,
    outcome: marker.outcome === 'failed'
      ? 'failed'
      : marker.outcome === 'interrupted'
        ? 'cancelled'
        : 'completed',
    appTurnId: marker.appTurnId,
  };
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLease(path: string): RecoveryLease | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as RecoveryLease;
    if (
      typeof value.token !== 'string'
      || !Number.isSafeInteger(value.ownerPid)
      || typeof value.expiresAtMs !== 'number'
    ) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function claimLease(
  dataDir: string,
  uuid: string,
  nowMs: number,
): { path: string; token: string } | undefined {
  const directory = join(dataDir, 'turn-delivery', 'leases');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${uuid}.json`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = randomUUID();
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, JSON.stringify({
        token,
        ownerPid: process.pid,
        expiresAtMs: nowMs + 60_000,
      }));
      closeSync(fd);
      return { path, token };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      const existing = readLease(path);
      if (
        existing
        && existing.expiresAtMs > nowMs
        && processAlive(existing.ownerPid)
      ) return undefined;
      try { unlinkSync(path); } catch { return undefined; }
    }
  }
  return undefined;
}

function releaseLease(lease: { path: string; token: string }): void {
  const current = readLease(lease.path);
  if (!current || current.token !== lease.token) return;
  try { unlinkSync(lease.path); } catch { /* 后续扫描可由过期机制接管。 */ }
}

function emptySummary(scanned: number): RestartTurnReconcileSummary {
  return {
    scanned,
    delivered: 0,
    following: 0,
    suppressed: 0,
    deferred: 0,
    skipped: 0,
    failed: 0,
  };
}

export async function reconcileOutstandingTurns(
  input: RestartTurnReconcileInput,
): Promise<RestartTurnReconcileSummary> {
  const records = input.ledger.listOutstanding(input.larkAppId);
  const summary = emptySummary(records.length);
  const sessions = new Map(
    [...input.sessions]
      .filter(ds => ds.larkAppId === input.larkAppId)
      .map(ds => [ds.session.sessionId, ds]),
  );
  const now = input.now ?? Date.now;

  for (const record of records) {
    const uuid = stableTurnDeliveryUuid(record.id);
    const lease = claimLease(input.dataDir, uuid, now());
    if (!lease) {
      summary.skipped++;
      continue;
    }
    try {
      const ds = sessions.get(record.id.sessionId);
      const foundFinal = reliableFinal(input.dataDir, record);
      const persistedStatus = ds
        ? undefined
        : input.lookupSessionStatus?.(record.id.sessionId);
      const action = decideRestartTurnAction({
        record,
        session: sessionState(ds, record) ?? (persistedStatus
          ? { status: persistedStatus, working: false }
          : undefined),
        reliableFinal: foundFinal,
      });
      if (action.kind === 'skip') {
        summary.skipped++;
        continue;
      }
      if (action.kind === 'keep-following') {
        if (ds) ds.suppressRecoveryCard = false;
        input.ledger.recordRecoveryRequired(record.id, now());
        summary.following++;
        continue;
      }
      if (action.kind === 'settle-silently' && input.settleUnconfirmed === false) {
        input.ledger.recordRecoveryRequired(record.id, now());
        summary.deferred++;
        continue;
      }

      if (action.kind === 'settle-silently') {
        input.ledger.recordRecoverySuppressed(record.id, {
          atMs: now(),
          reason: action.reason,
        });
        // 兼容修复前已写入 outbox 的静默终态；结算后同步 ACK，避免它继续
        // 污染后续恢复扫描或可信 reply turn 路由。
        if (foundFinal?.appTurnId) {
          ackCodexAppFinalOutbox(
            input.dataDir,
            record.id.sessionId,
            foundFinal.appTurnId,
          );
        }
        summary.suppressed++;
        continue;
      }

      const content = action.content;
      const outcome = action.outcome;
      input.ledger.recordFinal(record.id, { content, outcome, observedAtMs: now() });
      input.ledger.recordDeliveryPending(record.id, { uuid, atMs: now() });
      const current = input.ledger.get(record.id) ?? record;
      const messageId = await input.send(current, content, uuid);
      input.ledger.recordDelivered(record.id, { messageId, deliveredAtMs: now() });
      if (foundFinal?.appTurnId) {
        ackCodexAppFinalOutbox(
          input.dataDir,
          record.id.sessionId,
          foundFinal.appTurnId,
        );
      }
      summary.delivered++;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      input.ledger.recordRecoveryFailed(record.id, { atMs: now(), reason });
      input.log?.(`turn=${record.id.turnId.slice(0, 12)} failed: ${reason}`);
      summary.failed++;
    } finally {
      releaseLease(lease);
    }
  }
  return summary;
}
