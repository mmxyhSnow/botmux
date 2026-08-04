/**
 * Codex App Runner 的最终回复 outbox。
 *
 * Runner 必须先把 final 写入该目录，再输出 OSC marker；Daemon 即使在两步之间
 * 重启，也能从这里恢复可靠结论。ACK 使用独立原子快照，保留 append-only 正文。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { CodexAppFinalMarker } from './codex-app-runner-protocol.js';

export type CodexAppFinalOutboxEntry = CodexAppFinalMarker & {
  appTurnId: string;
};

type StoredFinal = CodexAppFinalOutboxEntry & {
  version: 1;
  persistedAtMs: number;
};

/** 模型显式声明本轮无需用户可见回复时使用的内部终态。 */
export const BOTMUX_NO_REPLY_FINAL = 'BOTMUX_NO_REPLY';

/** 只识别完整内部标记，避免误吞正文中对该标记的解释或引用。 */
export function isSilentFinalOutput(content: string): boolean {
  return content.trim() === BOTMUX_NO_REPLY_FINAL;
}

function sessionFileKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

function outboxDirectory(dataDir: string): string {
  return join(dataDir, 'codex-app-final-outbox');
}

function outboxPath(dataDir: string, sessionId: string): string {
  return join(outboxDirectory(dataDir), `${sessionFileKey(sessionId)}.jsonl`);
}

function ackPath(dataDir: string, sessionId: string): string {
  return join(outboxDirectory(dataDir), `${sessionFileKey(sessionId)}.acked.json`);
}

function validOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function parseStoredFinal(line: string): StoredFinal | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const validOutcome = value.outcome === undefined
      || value.outcome === 'completed'
      || value.outcome === 'failed'
      || value.outcome === 'interrupted';
    if (
      value.version !== 1
      || typeof value.appTurnId !== 'string'
      || !value.appTurnId
      || value.appTurnId.length > 512
      || typeof value.content !== 'string'
      || !validOutcome
      || !validOptionalNumber(value.startedAtMs)
      || !validOptionalNumber(value.completedAtMs)
      || typeof value.persistedAtMs !== 'number'
      || !Number.isFinite(value.persistedAtMs)
    ) return undefined;
    if (
      value.replyTurnId !== undefined
      && (typeof value.replyTurnId !== 'string' || !value.replyTurnId || value.replyTurnId.length > 512)
    ) return undefined;
    return {
      version: 1,
      appTurnId: value.appTurnId,
      content: value.content,
      persistedAtMs: value.persistedAtMs,
      ...(typeof value.replyTurnId === 'string' ? { replyTurnId: value.replyTurnId } : {}),
      ...(typeof value.legacyTurnId === 'string' ? { legacyTurnId: value.legacyTurnId } : {}),
      ...(value.outcome === 'completed' || value.outcome === 'failed' || value.outcome === 'interrupted'
        ? { outcome: value.outcome }
        : {}),
      ...(typeof value.startedAtMs === 'number' ? { startedAtMs: value.startedAtMs } : {}),
      ...(typeof value.completedAtMs === 'number' ? { completedAtMs: value.completedAtMs } : {}),
    };
  } catch {
    // Runner 崩溃可能留下半行，恢复时跳过损坏内容。
    return undefined;
  }
}

function readAcked(dataDir: string, sessionId: string): Set<string> {
  const path = ackPath(dataDir, sessionId);
  if (!existsSync(path)) return new Set();
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter(item => typeof item === 'string' && item.length > 0));
  } catch {
    return new Set();
  }
}

export function appendCodexAppFinalOutbox(
  dataDir: string,
  sessionId: string,
  marker: CodexAppFinalOutboxEntry,
): void {
  if (!dataDir || !sessionId || !marker.appTurnId || typeof marker.content !== 'string') {
    throw new Error('Codex App final outbox 缺少必要字段');
  }
  const directory = outboxDirectory(dataDir);
  mkdirSync(directory, { recursive: true });
  const stored: StoredFinal = {
    version: 1,
    ...marker,
    persistedAtMs: Date.now(),
  };
  appendFileSync(outboxPath(dataDir, sessionId), `${JSON.stringify(stored)}\n`, 'utf8');
}

export function readCodexAppFinalOutbox(
  dataDir: string,
  sessionId: string,
): CodexAppFinalOutboxEntry[] {
  const path = outboxPath(dataDir, sessionId);
  if (!existsSync(path)) return [];
  const acked = readAcked(dataDir, sessionId);
  const unique = new Map<string, CodexAppFinalOutboxEntry>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const stored = parseStoredFinal(line);
    if (!stored || acked.has(stored.appTurnId) || unique.has(stored.appTurnId)) continue;
    const { version: _version, persistedAtMs: _persistedAtMs, ...marker } = stored;
    unique.set(stored.appTurnId, marker);
  }
  return [...unique.values()];
}

/**
 * 恢复 worker 重启前建立的 reply turn 路由。
 *
 * 活跃 worker 可直接信任本进程提交过的 reply turn；进程重启后内存集合为空，
 * 此时只有与当前 session 的 durable outbox 完全匹配的 final 才能恢复路由，
 * 避免任意 OSC marker 伪造其它消息的 reply turn。
 */
export function resolveTrustedCodexAppReplyTurnId(input: {
  dataDir?: string;
  sessionId?: string;
  marker: Pick<CodexAppFinalOutboxEntry, 'appTurnId' | 'replyTurnId' | 'content'>;
  submittedReplyTurnIds: ReadonlySet<string>;
}): string | undefined {
  const { replyTurnId } = input.marker;
  if (!replyTurnId) return undefined;
  if (input.submittedReplyTurnIds.has(replyTurnId)) return replyTurnId;
  if (!input.dataDir || !input.sessionId) return undefined;
  return readCodexAppFinalOutbox(input.dataDir, input.sessionId).some(entry => (
    entry.appTurnId === input.marker.appTurnId
    && entry.replyTurnId === replyTurnId
    && entry.content === input.marker.content
  ))
    ? replyTurnId
    : undefined;
}

export function ackCodexAppFinalOutbox(
  dataDir: string,
  sessionId: string,
  appTurnId: string,
): void {
  if (!dataDir || !sessionId || !appTurnId) {
    throw new Error('Codex App final outbox ACK 缺少必要字段');
  }
  const directory = outboxDirectory(dataDir);
  mkdirSync(directory, { recursive: true });
  const path = ackPath(dataDir, sessionId);
  const acked = readAcked(dataDir, sessionId);
  acked.add(appTurnId);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify([...acked].sort())}\n`, 'utf8');
  renameSync(temporaryPath, path);
}

/** 公开顺序契约：只有 outbox 追加成功后才允许发布 OSC final marker。 */
export function emitCodexAppFinalWithOutbox(
  dataDir: string,
  sessionId: string,
  marker: CodexAppFinalOutboxEntry,
  emit: (marker: CodexAppFinalOutboxEntry) => void,
): void {
  // 静默终态仍要通知 daemon 结算入站轮次，但它不是用户可见回复，不能进入
  // 可靠回复 outbox；否则 daemon 重启会把历史静默标记误当正文重放。
  if (!isSilentFinalOutput(marker.content)) {
    appendCodexAppFinalOutbox(dataDir, sessionId, marker);
  }
  emit(marker);
}
