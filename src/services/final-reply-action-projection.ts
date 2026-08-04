/**
 * 最终回复快捷操作的稳定身份与卡片重投影工具。
 *
 * 本模块只负责可序列化状态和纯卡片变换；发送、防抖及会话持久化由 worker-pool 编排。
 */
import { createHash } from 'node:crypto';
import type { FinalReplyActionProjectionState } from '../types.js';
import type { FinalReplyAction } from './final-reply-actions.js';

/** 机器人消息短时间连续到达时只在消息收敛后补一张卡。 */
export const FINAL_REPLY_ACTION_REPROJECT_DELAY_MS = 1_200;
/** 防止异常机器人对话无限制造新消息；一次任务最多抬升八次。 */
export const FINAL_REPLY_ACTION_MAX_REPROJECTS = 8;

/** 用会话、轮次和完整动作契约生成稳定身份，重试发送不会得到第二组逻辑操作。 */
export function finalReplyActionSetId(input: {
  sessionId: string;
  turnId: string;
  actions: FinalReplyAction[];
}): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');
}

/** 生成首次成功投递后写入 Session 的待操作状态。 */
export function createFinalReplyActionProjection(input: {
  sessionId: string;
  turnId: string;
  actions: FinalReplyAction[];
  messageId: string;
  cardJson: string;
  now?: number;
}): FinalReplyActionProjectionState {
  const now = input.now ?? Date.now();
  return {
    schemaVersion: 1,
    actionSetId: finalReplyActionSetId({
      sessionId: input.sessionId,
      turnId: input.turnId,
      actions: input.actions,
    }),
    turnId: input.turnId,
    status: 'pending',
    actions: input.actions.map(action => ({ ...action })),
    messageId: input.messageId,
    cardJson: input.cardJson,
    createdAt: now,
    updatedAt: now,
    reprojectCount: 0,
  };
}

/** 最新操作卡使用精简正文，完整结果仍保留在上方原回复。 */
export function finalReplyActionReminderMarkdown(): string {
  return '**待你操作**\n\n上方任务结果仍有待处理操作，请在这里选择。';
}

function callbackAction(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return typeof (value as Record<string, unknown>).action === 'string'
    ? (value as Record<string, unknown>).action as string
    : undefined;
}

function isFinalReplyActionColumnSet(element: unknown): boolean {
  if (!element || typeof element !== 'object') return false;
  const record = element as Record<string, unknown>;
  if (record.tag !== 'column_set' || !Array.isArray(record.columns)) return false;
  return record.columns.some(column => {
    if (!column || typeof column !== 'object') return false;
    const elements = (column as Record<string, unknown>).elements;
    if (!Array.isArray(elements)) return false;
    return elements.some(item => {
      if (!item || typeof item !== 'object') return false;
      const behaviors = (item as Record<string, unknown>).behaviors;
      return Array.isArray(behaviors) && behaviors.some(behavior => {
        if (!behavior || typeof behavior !== 'object') return false;
        return callbackAction((behavior as Record<string, unknown>).value) === 'final_reply_quick_action';
      });
    });
  });
}

/**
 * 保留原回复正文和 footer，只把旧快捷操作组替换成迁移提示。
 * 视觉更新失败也不影响安全性，回调仍会按最新 messageId 拒绝旧卡。
 */
export function retireFinalReplyActionCard(cardJson: string): string | undefined {
  try {
    const card = JSON.parse(cardJson) as Record<string, unknown>;
    const body = card.body as Record<string, unknown> | undefined;
    if (!body || !Array.isArray(body.elements)) return undefined;
    let replaced = false;
    body.elements = body.elements.map(element => {
      if (!isFinalReplyActionColumnSet(element)) return element;
      replaced = true;
      return {
        tag: 'div',
        text: { tag: 'lark_md', content: '操作入口已移至下方最新卡片。' },
      };
    });
    return replaced ? JSON.stringify(card) : undefined;
  } catch {
    return undefined;
  }
}
