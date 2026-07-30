/**
 * ASK 新问题通知发送器。
 *
 * 卡片更新不会触发飞书的新消息提醒，因此每轮问题展示后都由这里单独发送 @。
 */
import type { PendingAsk } from '../../core/ask-types.js';
import { localeForBot } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';
import { replyMessage, sendMessage } from './client.js';
import { buildAskMentionNotice } from './ask-card-meta.js';

interface AskNoticeDeps {
  canReplyToRoot: boolean;
  reply: typeof replyMessage;
  send: typeof sendMessage;
}

/**
 * 向本轮锁定的提问对象发送真实 @；失败只记告警，不能把已展示的卡片变成死卡。
 */
export async function notifyAskApprovers(
  ask: PendingAsk,
  deps: AskNoticeDeps,
): Promise<void> {
  const notice = buildAskMentionNotice(ask, localeForBot(ask.larkAppId));
  if (!notice) return;

  try {
    if (deps.canReplyToRoot) {
      await deps.reply(ask.larkAppId, ask.rootMessageId!, notice, 'text', true);
    } else {
      await deps.send(ask.larkAppId, ask.chatId, notice, 'text');
    }
  } catch (err) {
    logger.warn(`[ask:${ask.askId}] failed to notify approvers: ${
      err instanceof Error ? err.message : String(err)
    }`);
  }
}
