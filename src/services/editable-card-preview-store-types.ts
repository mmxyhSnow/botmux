/** 通用可编辑卡片预览的持久化类型。 */

import type {
  EditableCardDefinition,
  EditableCardValues,
} from './editable-card-preview-model.js';

export const EDITABLE_CARD_PREVIEW_SCHEMA_VERSION = 1;

export type EditableCardPreviewStatus =
  | 'creating'
  | 'active'
  | 'processing'
  | 'sent'
  | 'regenerated'
  | 'failed'
  | 'expired';

export interface EditableCardPreviewRecord {
  schemaVersion: typeof EDITABLE_CARD_PREVIEW_SCHEMA_VERSION;
  previewId: string;
  larkAppId: string;
  initiatorOpenId: string;
  targetChatId: string;
  previewMessageId?: string;
  status: EditableCardPreviewStatus;
  processingAction?: string;
  editable: EditableCardValues;
  definition: EditableCardDefinition;
  formalMessageId?: string;
  replacementPreviewId?: string;
  replacementMessageId?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface CreateEditableCardPreviewDraftInput {
  larkAppId: string;
  initiatorOpenId: string;
  targetChatId: string;
  editable: EditableCardValues;
  definition: EditableCardDefinition;
  previewId?: string;
  now?: number;
}

export type EditableCardPreviewClaimResult =
  | { kind: 'claimed'; record: EditableCardPreviewRecord }
  | {
    kind: 'forbidden' | 'not_found' | 'stale' | 'busy' | 'expired';
    record?: EditableCardPreviewRecord;
  };
