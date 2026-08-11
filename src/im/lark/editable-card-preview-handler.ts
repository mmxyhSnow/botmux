/**
 * 通用可编辑卡片预览回调处理器。
 *
 * 处理器先用服务端记录校验应用、发起人和源消息，再认领一次性动作；
 * action.value 只用于定位 preview_id，不承载目标或模板。
 */

import { createHash } from 'node:crypto';
import type { CardActionData } from './card-handler.js';
import {
  buildEditableCardNotificationCard,
  buildEditableCardPreviewCard,
  buildEditableCardPreviewTerminalCard,
} from './editable-card-preview-card.js';
import {
  EDITABLE_CARD_PREVIEW_REGENERATE_ACTION,
  EDITABLE_CARD_PREVIEW_SEND_ACTION,
  EditableCardPreviewValidationError,
  normalizeEditableCardFormValue,
} from '../../services/editable-card-preview-model.js';
import {
  bindEditableCardPreviewMessage,
  claimEditableCardPreviewAction,
  createEditableCardPreviewDraft,
  failEditableCardPreviewDraft,
  finishEditableCardPreviewRegenerate,
  finishEditableCardPreviewSend,
  restoreEditableCardPreviewActive,
} from '../../services/editable-card-preview-store.js';

export interface EditableCardPreviewHandlerDeps {
  dataDir: string;
  larkAppId: string;
  sendFormal: (targetChatId: string, cardJson: string, providerKey: string) => Promise<string>;
  sendReplacement: (sourceMessageId: string, cardJson: string, providerKey: string) => Promise<string>;
}

/** 判断动作是否属于通用可编辑预览命名空间。 */
export function isEditableCardPreviewAction(
  action: unknown,
): action is typeof EDITABLE_CARD_PREVIEW_SEND_ACTION | typeof EDITABLE_CARD_PREVIEW_REGENERATE_ACTION {
  return action === EDITABLE_CARD_PREVIEW_SEND_ACTION
    || action === EDITABLE_CARD_PREVIEW_REGENERATE_ACTION;
}

/** 同一旧预览永远映射到同一个替代 ID，崩溃重试不会制造多张新卡。 */
function deriveReplacementPreviewId(previewId: string): string {
  const hex = createHash('sha256').update(`editable-card-replacement\0${previewId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function toast(type: 'success' | 'info' | 'warning' | 'error', content: string): Record<string, unknown> {
  return { toast: { type, content } };
}

function rawCard(cardJson: string, content: string): Record<string, unknown> {
  return {
    toast: { type: 'success', content },
    card: { type: 'raw', data: JSON.parse(cardJson) },
  };
}

function claimFailure(kind: string): Record<string, unknown> {
  if (kind === 'forbidden') return toast('warning', '只有这张预览的发起人可以操作');
  if (kind === 'busy') return toast('info', '这张预览正在处理，请勿重复点击');
  if (kind === 'expired') return toast('warning', '这张预览已过期，请重新生成');
  if (kind === 'not_found') return toast('warning', '找不到这张预览的服务端记录');
  return toast('info', '这张预览已失效，请使用最新卡片');
}

/** 执行发送或重新生成，并把旧预览终态化。 */
export async function handleEditableCardPreviewAction(
  data: CardActionData,
  deps: EditableCardPreviewHandlerDeps,
): Promise<Record<string, unknown>> {
  const action = data.action?.value?.action;
  const previewId = data.action?.value?.preview_id;
  const operatorOpenId = data.operator?.open_id;
  const sourceMessageId = data.context?.open_message_id ?? data.open_message_id;
  if (!isEditableCardPreviewAction(action) || !previewId || !operatorOpenId || !sourceMessageId) {
    return toast('error', '可编辑卡片预览回调参数不完整');
  }

  let claim;
  try {
    claim = claimEditableCardPreviewAction(deps.dataDir, {
      previewId,
      larkAppId: deps.larkAppId,
      operatorOpenId,
      sourceMessageId,
      action,
    });
  } catch (error) {
    return toast('error', `可编辑卡片预览状态无效：${error instanceof Error ? error.message : String(error)}`);
  }
  if (claim.kind !== 'claimed') return claimFailure(claim.kind);
  const record = claim.record;
  let editable;
  try {
    editable = normalizeEditableCardFormValue(
      data.action?.form_value,
      record.editable,
      record.definition.fields,
    );
  } catch (error) {
    const message = error instanceof EditableCardPreviewValidationError
      ? error.message
      : `表单内容无效：${error instanceof Error ? error.message : String(error)}`;
    restoreEditableCardPreviewActive(deps.dataDir, previewId, action, message);
    return toast('warning', message);
  }

  if (action === EDITABLE_CARD_PREVIEW_SEND_ACTION) {
    try {
      const card = buildEditableCardNotificationCard(editable, record.definition);
      const formalMessageId = await deps.sendFormal(
        record.targetChatId,
        card,
        `ecp-send-${previewId}`,
      );
      finishEditableCardPreviewSend(deps.dataDir, previewId, action, editable, formalMessageId);
      return rawCard(
        buildEditableCardPreviewTerminalCard(record.definition, 'sent', formalMessageId),
        '通知已发送',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      restoreEditableCardPreviewActive(deps.dataDir, previewId, action, message);
      return toast('error', `发送失败：${message}`);
    }
  }

  let replacementPreviewId: string | undefined;
  try {
    const replacement = createEditableCardPreviewDraft(deps.dataDir, {
      larkAppId: deps.larkAppId,
      initiatorOpenId: record.initiatorOpenId,
      targetChatId: record.targetChatId,
      editable,
      definition: record.definition,
      previewId: deriveReplacementPreviewId(previewId),
    });
    replacementPreviewId = replacement.previewId;
    let replacementMessageId = replacement.previewMessageId;
    if (!replacementMessageId) {
      const replacementCard = buildEditableCardPreviewCard(replacement);
      replacementMessageId = await deps.sendReplacement(
        sourceMessageId,
        replacementCard,
        `ecp-preview-${replacement.previewId}`,
      );
      bindEditableCardPreviewMessage(deps.dataDir, replacement.previewId, replacementMessageId);
    }
    finishEditableCardPreviewRegenerate(
      deps.dataDir,
      previewId,
      action,
      replacement.editable,
      replacement.previewId,
      replacementMessageId,
    );
    return rawCard(
      buildEditableCardPreviewTerminalCard(record.definition, 'regenerated', replacementMessageId),
      '已生成新的可编辑预览',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (replacementPreviewId) {
      failEditableCardPreviewDraft(deps.dataDir, replacementPreviewId, message);
    }
    restoreEditableCardPreviewActive(deps.dataDir, previewId, action, message);
    return toast('error', `重新生成失败：${message}`);
  }
}
