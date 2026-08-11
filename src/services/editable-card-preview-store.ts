/**
 * 通用可编辑卡片预览的跨进程持久化状态机。
 *
 * CLI 创建并绑定预览消息，daemon 在同一文件锁下认领动作，保证重复点击、
 * 事件重投和多进程竞争只产生一个可恢复副作用。
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import type { EditableCardValues } from './editable-card-preview-model.js';
import {
  EDITABLE_CARD_PREVIEW_SCHEMA_VERSION,
  type CreateEditableCardPreviewDraftInput,
  type EditableCardPreviewClaimResult,
  type EditableCardPreviewRecord,
  type EditableCardPreviewStatus,
} from './editable-card-preview-store-types.js';

export type {
  CreateEditableCardPreviewDraftInput,
  EditableCardPreviewClaimResult,
  EditableCardPreviewRecord,
  EditableCardPreviewStatus,
} from './editable-card-preview-store-types.js';

const STORE_DIR = 'editable-card-previews';
const PREVIEW_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
const PROCESSING_LEASE_MS = 2 * 60 * 1_000;
const SAFE_ID = /^[0-9a-f-]{36}$/i;

function cloneRecord(record: EditableCardPreviewRecord): EditableCardPreviewRecord {
  return structuredClone(record);
}

function storePath(dataDir: string, previewId: string): string {
  if (!SAFE_ID.test(previewId)) throw new Error('preview_id 格式无效');
  return join(dataDir, STORE_DIR, `${previewId}.json`);
}

function readRecordFile(path: string): EditableCardPreviewRecord | undefined {
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, 'utf-8')) as EditableCardPreviewRecord;
  if (
    value?.schemaVersion !== EDITABLE_CARD_PREVIEW_SCHEMA_VERSION
    || !SAFE_ID.test(value.previewId)
    || typeof value.larkAppId !== 'string'
    || typeof value.initiatorOpenId !== 'string'
    || typeof value.targetChatId !== 'string'
    || typeof value.createdAt !== 'number'
    || typeof value.updatedAt !== 'number'
    || typeof value.expiresAt !== 'number'
  ) throw new Error('可编辑卡片预览状态文件损坏');
  return value;
}

function writeRecord(path: string, record: EditableCardPreviewRecord): void {
  atomicWriteFileSync(path, `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

/** 创建尚未绑定飞书消息的预览草稿。 */
export function createEditableCardPreviewDraft(
  dataDir: string,
  input: CreateEditableCardPreviewDraftInput,
): EditableCardPreviewRecord {
  const now = input.now ?? Date.now();
  const previewId = input.previewId ?? randomUUID();
  const dir = join(dataDir, STORE_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = storePath(dataDir, previewId);
  return withFileLockSync(path, () => {
    const existing = readRecordFile(path);
    if (existing) {
      const sameScope = existing.larkAppId === input.larkAppId
        && existing.initiatorOpenId === input.initiatorOpenId
        && existing.targetChatId === input.targetChatId
        && JSON.stringify(existing.definition) === JSON.stringify(input.definition);
      if (!sameScope) throw new Error('preview_id 已被其它预览占用');
      if (existing.status === 'active') return cloneRecord(existing);
      if (existing.status !== 'creating' && existing.status !== 'failed') {
        throw new Error('preview_id 已进入不可复用状态');
      }
      existing.status = 'creating';
      existing.editable = structuredClone(input.editable);
      existing.previewMessageId = undefined;
      existing.lastError = undefined;
      existing.updatedAt = now;
      existing.expiresAt = now + PREVIEW_TTL_MS;
      writeRecord(path, existing);
      return cloneRecord(existing);
    }
    const record: EditableCardPreviewRecord = {
      schemaVersion: EDITABLE_CARD_PREVIEW_SCHEMA_VERSION,
      previewId,
      larkAppId: input.larkAppId,
      initiatorOpenId: input.initiatorOpenId,
      targetChatId: input.targetChatId,
      status: 'creating',
      editable: structuredClone(input.editable),
      definition: structuredClone(input.definition),
      createdAt: now,
      updatedAt: now,
      expiresAt: now + PREVIEW_TTL_MS,
    };
    writeRecord(path, record);
    return cloneRecord(record);
  });
}

/** 发送成功后把草稿与唯一的飞书预览消息绑定。 */
export function bindEditableCardPreviewMessage(
  dataDir: string,
  previewId: string,
  messageId: string,
  now = Date.now(),
): EditableCardPreviewRecord {
  const path = storePath(dataDir, previewId);
  return withFileLockSync(path, () => {
    const record = readRecordFile(path);
    if (!record) throw new Error('可编辑卡片预览草稿不存在');
    if (record.status === 'active' && record.previewMessageId === messageId) return cloneRecord(record);
    if (record.status !== 'creating' || record.previewMessageId) throw new Error('预览草稿状态不可绑定');
    record.previewMessageId = messageId;
    record.status = 'active';
    record.updatedAt = now;
    writeRecord(path, record);
    return cloneRecord(record);
  });
}

/** 回读预览状态，供回调和验收使用。 */
export function readEditableCardPreview(
  dataDir: string,
  previewId: string,
): EditableCardPreviewRecord | undefined {
  const record = readRecordFile(storePath(dataDir, previewId));
  return record ? cloneRecord(record) : undefined;
}

/** 在身份、应用和源消息全部匹配后原子认领一次动作。 */
export function claimEditableCardPreviewAction(
  dataDir: string,
  input: {
    previewId: string;
    larkAppId: string;
    operatorOpenId: string;
    sourceMessageId: string;
    action: string;
    now?: number;
  },
): EditableCardPreviewClaimResult {
  const path = storePath(dataDir, input.previewId);
  if (!existsSync(path)) return { kind: 'not_found' };
  return withFileLockSync(path, () => {
    const record = readRecordFile(path);
    if (!record) return { kind: 'not_found' };
    const now = input.now ?? Date.now();
    if (now >= record.expiresAt) {
      record.status = 'expired';
      record.updatedAt = now;
      writeRecord(path, record);
      return { kind: 'expired', record: cloneRecord(record) };
    }
    if (
      record.larkAppId !== input.larkAppId
      || record.initiatorOpenId !== input.operatorOpenId
      || record.previewMessageId !== input.sourceMessageId
    ) return { kind: 'forbidden', record: cloneRecord(record) };
    if (record.status === 'processing') {
      const sameExpiredLease = record.processingAction === input.action
        && now - record.updatedAt >= PROCESSING_LEASE_MS;
      if (!sameExpiredLease) return { kind: 'busy', record: cloneRecord(record) };
      record.updatedAt = now;
      record.lastError = undefined;
      writeRecord(path, record);
      return { kind: 'claimed', record: cloneRecord(record) };
    }
    if (record.status !== 'active') return { kind: 'stale', record: cloneRecord(record) };
    record.status = 'processing';
    record.processingAction = input.action;
    record.lastError = undefined;
    record.updatedAt = now;
    writeRecord(path, record);
    return { kind: 'claimed', record: cloneRecord(record) };
  });
}

/** 副作用失败时释放动作认领，允许用户修正后重试。 */
export function restoreEditableCardPreviewActive(
  dataDir: string,
  previewId: string,
  action: string,
  error: string,
  now = Date.now(),
): void {
  const path = storePath(dataDir, previewId);
  withFileLockSync(path, () => {
    const record = readRecordFile(path);
    if (!record || record.status !== 'processing' || record.processingAction !== action) return;
    record.status = 'active';
    record.processingAction = undefined;
    record.lastError = error.slice(0, 500);
    record.updatedAt = now;
    writeRecord(path, record);
  });
}

/** 完成正式发送并固化最终字段。 */
export function finishEditableCardPreviewSend(
  dataDir: string,
  previewId: string,
  action: string,
  editable: EditableCardValues,
  formalMessageId: string,
  now = Date.now(),
): EditableCardPreviewRecord {
  return finishAction(dataDir, previewId, action, now, record => {
    record.status = 'sent';
    record.editable = structuredClone(editable);
    record.formalMessageId = formalMessageId;
  });
}

/** 完成重新生成并把旧预览绑定到唯一替代卡。 */
export function finishEditableCardPreviewRegenerate(
  dataDir: string,
  previewId: string,
  action: string,
  editable: EditableCardValues,
  replacementPreviewId: string,
  replacementMessageId: string,
  now = Date.now(),
): EditableCardPreviewRecord {
  return finishAction(dataDir, previewId, action, now, record => {
    record.status = 'regenerated';
    record.editable = structuredClone(editable);
    record.replacementPreviewId = replacementPreviewId;
    record.replacementMessageId = replacementMessageId;
  });
}

function finishAction(
  dataDir: string,
  previewId: string,
  action: string,
  now: number,
  mutate: (record: EditableCardPreviewRecord) => void,
): EditableCardPreviewRecord {
  const path = storePath(dataDir, previewId);
  return withFileLockSync(path, () => {
    const record = readRecordFile(path);
    if (!record || record.status !== 'processing' || record.processingAction !== action) {
      throw new Error('可编辑卡片预览动作完成状态不匹配');
    }
    mutate(record);
    record.processingAction = undefined;
    record.lastError = undefined;
    record.updatedAt = now;
    writeRecord(path, record);
    return cloneRecord(record);
  });
}

/** 预览投递失败时保留可审计失败状态，不留下可点击的幽灵草稿。 */
export function failEditableCardPreviewDraft(
  dataDir: string,
  previewId: string,
  error: string,
  now = Date.now(),
): void {
  const path = storePath(dataDir, previewId);
  withFileLockSync(path, () => {
    const record = readRecordFile(path);
    if (!record || (record.status !== 'creating' && record.status !== 'active')) return;
    record.status = 'failed';
    record.lastError = error.slice(0, 500);
    record.updatedAt = now;
    writeRecord(path, record);
  });
}
