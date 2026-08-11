/**
 * 前端 CR 预览持久化模型。
 *
 * 类型与存储读写分离，避免状态机实现承担过多声明职责。
 */

import type {
  FrontendCrEditableFields,
  FrontendCrProtectedFields,
} from './frontend-cr-preview-model.js';

export const FRONTEND_CR_PREVIEW_SCHEMA_VERSION = 1;

export type FrontendCrPreviewStatus =
  | 'creating'
  | 'active'
  | 'processing'
  | 'sent'
  | 'regenerated'
  | 'failed'
  | 'expired';

export interface FrontendCrPreviewRecord {
  schemaVersion: typeof FRONTEND_CR_PREVIEW_SCHEMA_VERSION;
  previewId: string;
  larkAppId: string;
  initiatorOpenId: string;
  targetChatId: string;
  previewMessageId?: string;
  status: FrontendCrPreviewStatus;
  processingAction?: string;
  editable: FrontendCrEditableFields;
  protected: FrontendCrProtectedFields;
  formalMessageId?: string;
  replacementPreviewId?: string;
  replacementMessageId?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface CreateFrontendCrPreviewDraftInput {
  larkAppId: string;
  initiatorOpenId: string;
  targetChatId: string;
  editable: FrontendCrEditableFields;
  protected: FrontendCrProtectedFields;
  previewId?: string;
  now?: number;
}

export type FrontendCrPreviewClaimResult =
  | { kind: 'claimed'; record: FrontendCrPreviewRecord }
  | {
    kind: 'forbidden' | 'not_found' | 'stale' | 'busy' | 'expired';
    record?: FrontendCrPreviewRecord;
  };
