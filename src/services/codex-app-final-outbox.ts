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
  appendCodexAppFinalOutbox(dataDir, sessionId, marker);
  emit(marker);
}
