/**
 * 前端 CR 预览的跨进程持久化状态。
 *
 * CLI 负责创建并绑定预览消息，daemon 回调在同一文件锁下认领动作；这样即使
 * 重复点击、事件重投或多 daemon 竞争，也只有一个发送或重新生成副作用。
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import type {
  FrontendCrEditableFields,
} from './frontend-cr-preview-model.js';
import {
  FRONTEND_CR_PREVIEW_SCHEMA_VERSION,
  type CreateFrontendCrPreviewDraftInput,
  type FrontendCrPreviewClaimResult,
  type FrontendCrPreviewRecord,
  type FrontendCrPreviewStatus,
} from './frontend-cr-preview-store-types.js';

export type {
  CreateFrontendCrPreviewDraftInput,
  FrontendCrPreviewClaimResult,
  FrontendCrPreviewRecord,
  FrontendCrPreviewStatus,
} from './frontend-cr-preview-store-types.js';

const STORE_DIR = 'frontend-cr-previews';
const PREVIEW_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
const PROCESSING_LEASE_MS = 2 * 60 * 1_000;
const SAFE_ID = /^[0-9a-f-]{36}$/i;

function cloneRecord(record: FrontendCrPreviewRecord): FrontendCrPreviewRecord {
  return structuredClone(record);
}

function storePath(dataDir: string, previewId: string): string {
  if (!SAFE_ID.test(previewId)) throw new Error('preview_id 格式无效');
  return join(dataDir, STORE_DIR, `${previewId}.json`);
}

function readRecordFile(path: string): FrontendCrPreviewRecord | undefined {
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, 'utf-8')) as FrontendCrPreviewRecord;
  if (
    value?.schemaVersion !== FRONTEND_CR_PREVIEW_SCHEMA_VERSION
    || !SAFE_ID.test(value.previewId)
    || typeof value.larkAppId !== 'string'
    || typeof value.initiatorOpenId !== 'string'
    || typeof value.targetChatId !== 'string'
    || typeof value.createdAt !== 'number'
    || typeof value.updatedAt !== 'number'
    || typeof value.expiresAt !== 'number'
  ) throw new Error('CR 预览状态文件损坏');
  return value;
}

function writeRecord(path: string, record: FrontendCrPreviewRecord): void {
  atomicWriteFileSync(path, `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

/** 创建尚未绑定飞书消息的预览草稿。 */
export function createFrontendCrPreviewDraft(
  dataDir: string,
  input: CreateFrontendCrPreviewDraftInput,
): FrontendCrPreviewRecord {
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
        && JSON.stringify(existing.protected) === JSON.stringify(input.protected);
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
    const record: FrontendCrPreviewRecord = {
      schemaVersion: FRONTEND_CR_PREVIEW_SCHEMA_VERSION,
      previewId,
      larkAppId: input.larkAppId,
      initiatorOpenId: input.initiatorOpenId,
      targetChatId: input.targetChatId,
      status: 'creating',
      editable: structuredClone(input.editable),
      protected: structuredClone(input.protected),
      createdAt: now,
      updatedAt: now,
      expiresAt: now + PREVIEW_TTL_MS,
    };
    writeRecord(path, record);
    return cloneRecord(record);
  });
}

/** 发送成功后把草稿与唯一的飞书预览消息绑定。 */
export function bindFrontendCrPreviewMessage(
  dataDir: string,
  previewId: string,
  messageId: string,
  now = Date.now(),
): FrontendCrPreviewRecord {
  const path = storePath(dataDir, previewId);
  return withFileLockSync(path, () => {
    const record = readRecordFile(path);
    if (!record) throw new Error('CR 预览草稿不存在');
    if (record.status === 'active' && record.previewMessageId === messageId) return cloneRecord(record);
    if (record.status !== 'creating' || record.previewMessageId) throw new Error('CR 预览草稿状态不可绑定');
    record.previewMessageId = messageId;
    record.status = 'active';
    record.updatedAt = now;
    writeRecord(path, record);
    return cloneRecord(record);
  });
}

/** 回读预览状态，供回调和验收使用。 */
export function readFrontendCrPreview(
  dataDir: string,
  previewId: string,
): FrontendCrPreviewRecord | undefined {
  const record = readRecordFile(storePath(dataDir, previewId));
  return record ? cloneRecord(record) : undefined;
}

/** 在身份、应用和源消息全部匹配后原子认领一次动作。 */
export function claimFrontendCrPreviewAction(
  dataDir: string,
  input: {
    previewId: string;
    larkAppId: string;
    operatorOpenId: string;
    sourceMessageId: string;
    action: string;
    now?: number;
  },
): FrontendCrPreviewClaimResult {
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
export function restoreFrontendCrPreviewActive(
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

/** 完成正式发送并固化最终可编辑字段。 */
export function finishFrontendCrPreviewSend(
  dataDir: string,
  previewId: string,
  action: string,
  editable: FrontendCrEditableFields,
  formalMessageId: string,
  now = Date.now(),
): FrontendCrPreviewRecord {
  return finishAction(dataDir, previewId, action, now, record => {
    record.status = 'sent';
    record.editable = structuredClone(editable);
    record.formalMessageId = formalMessageId;
  });
}

/** 完成重新生成并把旧预览绑定到唯一替代卡。 */
export function finishFrontendCrPreviewRegenerate(
  dataDir: string,
  previewId: string,
  action: string,
  editable: FrontendCrEditableFields,
  replacementPreviewId: string,
  replacementMessageId: string,
  now = Date.now(),
): FrontendCrPreviewRecord {
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
  mutate: (record: FrontendCrPreviewRecord) => void,
): FrontendCrPreviewRecord {
  const path = storePath(dataDir, previewId);
  return withFileLockSync(path, () => {
    const record = readRecordFile(path);
    if (!record || record.status !== 'processing' || record.processingAction !== action) {
      throw new Error('CR 预览动作完成状态不匹配');
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
export function failFrontendCrPreviewDraft(
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
