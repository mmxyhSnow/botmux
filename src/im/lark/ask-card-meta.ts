/**
 * ASK 卡片公共元信息渲染。
 *
 * 提问对象来自 broker 已锁定的 `approvers`，这里只把合法飞书 open_id
 * 转为可触发通知的 `<at>` 标签，避免连续提问卡与普通卡出现不同语义。
 */
import type { PendingAsk } from '../../core/ask-types.js';
import { t, type Locale } from '../../i18n/index.js';

const LARK_OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;

/** 返回“可答复”字段内容；锁定对象时显示真实 @，否则保留群成员语义。 */
export function buildAskAnswerableContent(
  ask: PendingAsk,
  locale: Locale,
): string {
  if (!ask.approvers?.length) {
    return t('card.ask.answerable_talk_members', undefined, locale);
  }
  const mentions = ask.approvers
    .filter(openId => LARK_OPEN_ID.test(openId))
    .map(openId => `<at id=${openId}></at>`);
  const label = t('card.ask.answerable_turn_callers', undefined, locale);
  return mentions.length > 0 ? `${label}：${mentions.join(' ')}` : label;
}

/**
 * 构造每次新问题发出后的独立提醒消息。
 *
 * 文本消息必须使用 `user_id` 形式的标签才能触发飞书通知；没有合法锁定对象时
 * 不发送提醒，普通 ASK 仍保持原有的群成员可答语义。
 */
export function buildAskMentionNotice(
  ask: PendingAsk,
  locale: Locale,
): string | undefined {
  const mentions = ask.approvers
    ?.filter(openId => LARK_OPEN_ID.test(openId))
    .map(openId => `<at user_id="${openId}"></at>`) ?? [];
  if (mentions.length === 0) return undefined;
  return `${mentions.join(' ')} ${t('card.ask.new_question_notice', undefined, locale)}`;
}
