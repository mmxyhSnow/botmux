/**
 * Restart-intent breadcrumb: a small file written just before an *intentional*
 * restart (manual `botmux restart`, or an auto-update that restarts to apply).
 * On the next daemon startup the primary daemon consumes it to decide whether
 * to DM the owner a restart summary.
 *
 * A pm2 crash-autorestart (or machine reboot) writes no breadcrumb, so the
 * fresh daemon stays silent — this is how we distinguish "crash" from
 * "intentional restart" without a debounce. See core/maintenance.ts and
 * core/restart-report.ts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { config } from '../config.js';
import { readProcessStartIdentity } from '../core/session-marker.js';
import { withFileLockSync } from '../utils/file-lock.js';

export type RestartKind = 'manual' | 'update' | 'rollback';
export type RestartSource = 'cli' | 'ai' | 'dashboard';

export interface SourceDeploymentIntent {
  releaseTag: string;
  expectedHead: string;
}

export interface RestartIntentPayload {
  kind: RestartKind;
  /** Present for an update or rollback: the version delta to report. */
  oldVersion?: string;
  newVersion?: string;
  /** 发起方提供的具体维护原因；缺省时由卡片按 kind 给出可理解的原因。 */
  reason?: string;
  /** 触发本次维护的真实入口；旧数据缺省时按普通 CLI 处理。 */
  source?: RestartSource;
  /** 源码同步专用：新 daemon 验收后再写 deploy 标签，禁止安装阶段提前留痕。 */
  sourceDeployment?: SourceDeploymentIntent;
  /** ISO 8601 timestamp the breadcrumb was written. */
  at: string;
}

export interface RestartIntent extends RestartIntentPayload {
  attemptId?: string;
  attemptState?: 'prepared' | 'committed' | 'aborted';
  deferredIntent?: RestartIntentPayload;
}

export type RestartIntentReportClaim =
  | { state: 'claimed'; intent: RestartIntent }
  | { state: 'prepared' }
  | { state: 'absent' };

const FILE = 'restart-intent.json';
const LEASE_FILE = 'restart-lease.json';

/** Breadcrumbs older than this are stale (an aborted/failed restart left it)
 *  and never produce a report. */
export const RESTART_INTENT_FRESH_MS = 10 * 60_000;
export const RESTART_LEASE_CLAIM_MS = 60_000;
export const RESTART_LEASE_MAX_MS = 30 * 60_000;

export function restartIntentPathIn(dir: string): string {
  return join(dir, FILE);
}

function writeRestartIntentUnlocked(dir: string, intent: RestartIntent): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = restartIntentPathIn(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  const reason = normalizeRestartReason(intent.reason);
  const source = normalizeRestartSource(intent.source);
  const sourceDeployment = normalizeSourceDeployment(intent.sourceDeployment);
  writeFileSync(tmp, JSON.stringify({ ...intent, reason, source, sourceDeployment }, null, 2) + '\n');
  renameSync(tmp, path);
}

/** 将维护原因压成适合飞书卡片单行展示的短文本，避免换行和超长内容撑满卡片。 */
export function normalizeRestartReason(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.replace(/\s+/g, ' ').trim();
  return value ? value.slice(0, 200) : undefined;
}

/** 只接受维护通知支持的固定触发来源，避免把任意外部文本带进卡片。 */
export function normalizeRestartSource(raw: unknown): RestartSource | undefined {
  return raw === 'cli' || raw === 'ai' || raw === 'dashboard' ? raw : undefined;
}

/** 只持久化固定候选标签和完整 SHA，避免 Dashboard 请求注入任意 Git 参数。 */
export function normalizeSourceDeployment(raw: unknown): SourceDeploymentIntent | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'releaseTag' && key !== 'expectedHead')) return undefined;
  if (typeof value.releaseTag !== 'string' || !/^release\/v\d+\.\d+\.\d+-custom\.\d+$/.test(value.releaseTag)) {
    return undefined;
  }
  if (typeof value.expectedHead !== 'string' || !/^[0-9a-f]{40}$/.test(value.expectedHead)) return undefined;
  return { releaseTag: value.releaseTag, expectedHead: value.expectedHead };
}

/**
 * 显式来源优先；未声明时仅在 Botmux 托管轮次环境中判定为 AI，
 * 普通宿主终端保持为 CLI，避免再次把执行主体误写成管理员。
 */
export function resolveRestartSource(
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
): RestartSource {
  return normalizeRestartSource(raw)
    ?? (env.BOTMUX_SESSION_ID && env.BOTMUX_TURN_ID ? 'ai' : 'cli');
}

export function clearRestartIntentTo(dir: string): void {
  if (!existsSync(dir)) return;
  withFileLockSync(restartIntentPathIn(dir), () => {
    try { rmSync(restartIntentPathIn(dir)); } catch { /* absent / best-effort */ }
  });
}

function payloadOf(intent: RestartIntent): RestartIntentPayload {
  return {
    kind: intent.kind,
    at: intent.at,
    ...(intent.oldVersion !== undefined ? { oldVersion: intent.oldVersion } : {}),
    ...(intent.newVersion !== undefined ? { newVersion: intent.newVersion } : {}),
    ...(intent.reason !== undefined ? { reason: intent.reason } : {}),
    ...(intent.source !== undefined ? { source: intent.source } : {}),
    ...(intent.sourceDeployment !== undefined ? { sourceDeployment: intent.sourceDeployment } : {}),
  };
}

export function writeRestartIntentTo(dir: string, intent: RestartIntent): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  withFileLockSync(restartIntentPathIn(dir), () => {
    const current = readRaw(dir);
    const intentAt = Date.parse(intent.at);
    const writerNow = Number.isFinite(intentAt) ? intentAt : Date.now();
    if ((current?.attemptState === 'prepared' || current?.attemptState === 'aborted')
        && isFresh(current, writerNow)) {
      writeRestartIntentUnlocked(dir, {
        ...current,
        deferredIntent: payloadOf(intent),
      });
      return;
    }
    writeRestartIntentUnlocked(dir, payloadOf(intent));
  });
}

function readRaw(dir: string): RestartIntent | null {
  const path = restartIntentPathIn(dir);
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, 'utf-8'));
    if (v && typeof v === 'object' && typeof v.kind === 'string' && typeof v.at === 'string') {
      return {
        ...v,
        source: normalizeRestartSource(v.source),
        sourceDeployment: normalizeSourceDeployment(v.sourceDeployment),
      } as RestartIntent;
    }
  } catch {
    /* corrupt → treated as absent (and cleaned up by consume) */
  }
  return null;
}

function isFresh(intent: RestartIntent, nowMs: number): boolean {
  const at = Date.parse(intent.at);
  return Number.isFinite(at) && Math.abs(nowMs - at) <= RESTART_INTENT_FRESH_MS;
}

export function restartLeasePathIn(dir: string): string {
  return join(dir, LEASE_FILE);
}

interface RestartLease {
  id: string;
  at: number;
  pid?: number;
  procStart?: string;
}

function readRestartLeaseTo(dir: string): RestartLease | null {
  try {
    const value = JSON.parse(readFileSync(restartLeasePathIn(dir), 'utf-8')) as Record<string, unknown>;
    if (typeof value.id !== 'string' || !value.id || typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
    if (value.pid !== undefined && (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 1)) return null;
    if (value.procStart !== undefined && (typeof value.procStart !== 'string' || !value.procStart)) return null;
    return {
      id: value.id,
      at: value.at,
      ...(typeof value.pid === 'number' ? { pid: value.pid } : {}),
      ...(typeof value.procStart === 'string' ? { procStart: value.procStart } : {}),
    };
  } catch {
    return null;
  }
}

/** Call while holding globalInstallUpdateLockTarget(). */
export function hasActiveRestartLeaseTo(dir: string, nowMs: number): boolean {
  const lease = readRestartLeaseTo(dir);
  if (!lease) return false;
  const age = Math.abs(nowMs - lease.at);
  if (!lease.pid) return age <= RESTART_LEASE_CLAIM_MS;
  if (lease.procStart) {
    const liveStart = readProcessStartIdentity(lease.pid);
    if (liveStart !== undefined) {
      if (liveStart !== lease.procStart) return false;
      // A stuck driver must not hold the lease forever: even if the process
      // is still alive (and its start time matches), expire after MAX_MS so a
      // new restart can be attempted.
      if (age > RESTART_LEASE_MAX_MS) return false;
      return true;
    }
  }
  if (age > RESTART_LEASE_MAX_MS) return false;
  try { process.kill(lease.pid, 0); return true; } catch { return false; }
}

/** Claim the restart handoff while holding globalInstallUpdateLockTarget(). */
export function claimRestartLeaseTo(dir: string, nowMs: number): string | null {
  if (hasActiveRestartLeaseTo(dir, nowMs)) return null;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = restartLeasePathIn(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  const id = randomBytes(12).toString('hex');
  writeFileSync(tmp, JSON.stringify({ id, at: nowMs }) + '\n');
  renameSync(tmp, path);
  return id;
}

/** Bind a provisional claim while holding globalInstallUpdateLockTarget(). */
export function bindRestartLeaseTo(dir: string, id: string, pid: number, nowMs: number): boolean {
  const lease = readRestartLeaseTo(dir);
  if (!lease || lease.id !== id || !Number.isSafeInteger(pid) || pid <= 1) return false;
  const path = restartLeasePathIn(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  const procStart = readProcessStartIdentity(pid);
  writeFileSync(tmp, JSON.stringify({ id, at: nowMs, pid, ...(procStart ? { procStart } : {}) }) + '\n');
  renameSync(tmp, path);
  return true;
}

export function clearRestartLeaseTo(dir: string, id: string): void {
  if (readRestartLeaseTo(dir)?.id !== id) return;
  try { rmSync(restartLeasePathIn(dir)); } catch { /* absent / best-effort */ }
}

/** Read + delete the breadcrumb. Always deletes (fresh, stale, or corrupt) so
 *  it fires at most once and never lingers into a later restart. Returns the
 *  intent only when it is fresh. */
export function consumeRestartIntentTo(dir: string, nowMs: number): RestartIntent | null {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return withFileLockSync(restartIntentPathIn(dir), () => {
    const intent = readRaw(dir);
    const path = restartIntentPathIn(dir);
    if ((intent?.attemptState === 'prepared' || intent?.attemptState === 'aborted')
        && isFresh(intent, nowMs)) {
      return null;
    }
    if (existsSync(path)) {
      try { rmSync(path); } catch { /* best-effort */ }
    }
    if (!intent) return null;
    return isFresh(intent, nowMs) ? intent : null;
  });
}

export function claimRestartIntentForReportTo(
  dir: string,
  nowMs: number,
): RestartIntentReportClaim {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return withFileLockSync(restartIntentPathIn(dir), () => {
    const intent = readRaw(dir);
    const path = restartIntentPathIn(dir);
    if (!intent || !isFresh(intent, nowMs)) {
      if (existsSync(path)) {
        try { rmSync(path); } catch { /* best-effort stale/corrupt cleanup */ }
      }
      return { state: 'absent' };
    }
    if (intent.attemptState === 'prepared') return { state: 'prepared' };
    if (intent.attemptState === 'aborted') return { state: 'absent' };
    if (existsSync(path)) {
      try { rmSync(path); }
      catch { return { state: 'absent' }; }
    }
    return { state: 'claimed', intent };
  });
}

export function hasPreparedRestartIntentTo(dir: string, nowMs: number): boolean {
  if (!existsSync(dir)) return false;
  return withFileLockSync(restartIntentPathIn(dir), () => {
    const intent = readRaw(dir);
    if (intent?.attemptState !== 'prepared') return false;
    if (isFresh(intent, nowMs)) return true;
    try { rmSync(restartIntentPathIn(dir)); } catch { /* best-effort stale cleanup */ }
    return false;
  });
}

/** Write a `manual` breadcrumb only when no *fresh* breadcrumb already exists —
 *  so a maintenance-written `update` breadcrumb is not clobbered
 *  by the `botmux restart` it spawns. */
export function writeManualIntentIfAbsentTo(
  dir: string,
  nowMs: number,
  atIso: string,
  reason?: string,
  source: RestartSource = 'cli',
): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  withFileLockSync(restartIntentPathIn(dir), () => {
    const existing = readRaw(dir);
    if (existing && isFresh(existing, nowMs)) return;
    writeRestartIntentUnlocked(dir, { kind: 'manual', reason, source, at: atIso });
  });
}

export function writeRestartAttemptIntentTo(
  dir: string,
  preferred: RestartIntent,
  nowMs: number,
  attemptId: string,
): RestartIntent {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return withFileLockSync(restartIntentPathIn(dir), () => {
    const existing = readRaw(dir);
    const selected = existing && isFresh(existing, nowMs)
      ? ((existing.attemptState === 'prepared' || existing.attemptState === 'aborted')
          && existing.deferredIntent
          ? existing.deferredIntent
          : payloadOf(existing))
      : payloadOf(preferred);
    const written: RestartIntent = { ...selected, attemptId, attemptState: 'prepared' };
    writeRestartIntentUnlocked(dir, written);
    return written;
  });
}

export function commitRestartIntentAttemptTo(dir: string, attemptId: string): boolean {
  if (!existsSync(dir)) return false;
  return withFileLockSync(restartIntentPathIn(dir), () => {
    const current = readRaw(dir);
    if (current?.attemptId !== attemptId || current.attemptState !== 'prepared') return false;
    const selected = current.deferredIntent ?? payloadOf(current);
    writeRestartIntentUnlocked(dir, {
      ...selected,
      attemptId,
      attemptState: 'committed',
    });
    return true;
  });
}

export function removeRestartIntentAttemptTo(dir: string, attemptId: string): boolean {
  if (!existsSync(dir)) return false;
  return withFileLockSync(restartIntentPathIn(dir), () => {
    const current = readRaw(dir);
    if (current?.attemptId !== attemptId) return false;
    writeRestartIntentUnlocked(dir, {
      ...(current.deferredIntent ?? payloadOf(current)),
      attemptId: `aborted:${attemptId}`,
      attemptState: 'aborted',
    });
    return true;
  });
}

// ---- default-dir wrappers (production wiring) ----

export function writeRestartIntent(intent: RestartIntent): void {
  writeRestartIntentTo(config.session.dataDir, intent);
}

export function clearRestartIntent(): void {
  clearRestartIntentTo(config.session.dataDir);
}

export function consumeRestartIntent(nowMs: number = Date.now()): RestartIntent | null {
  return consumeRestartIntentTo(config.session.dataDir, nowMs);
}

export function hasActiveRestartLease(nowMs: number = Date.now()): boolean {
  return hasActiveRestartLeaseTo(config.session.dataDir, nowMs);
}

export function claimRestartLease(nowMs: number = Date.now()): string | null {
  return claimRestartLeaseTo(config.session.dataDir, nowMs);
}

export function clearRestartLease(id: string): void {
  clearRestartLeaseTo(config.session.dataDir, id);
}

export function writeManualIntentIfAbsent(
  nowMs: number = Date.now(),
  reason?: string,
  source: RestartSource = resolveRestartSource(undefined),
): void {
  writeManualIntentIfAbsentTo(
    config.session.dataDir,
    nowMs,
    new Date(nowMs).toISOString(),
    reason,
    source,
  );
}

export function claimRestartIntentForReport(
  nowMs: number = Date.now(),
): RestartIntentReportClaim {
  return claimRestartIntentForReportTo(config.session.dataDir, nowMs);
}

export function hasPreparedRestartIntent(nowMs: number = Date.now()): boolean {
  return hasPreparedRestartIntentTo(config.session.dataDir, nowMs);
}
