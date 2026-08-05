/**
 * ASK 新问题通知发送器。
 *
 * 卡片更新不会触发飞书的新消息提醒，因此按当前策略由这里单独发送真实 @。
 */
import { getAskSnapshot, submitAskFromDesktop } from '../../core/ask-broker.js';
import type { AskQuestion, PendingAsk } from '../../core/ask-types.js';
import type { AskReminderPolicy } from '../../bot-registry.js';
import { localeForBot } from '../../i18n/index.js';
import { getBotCardPrefs } from '../../services/card-prefs-store.js';
import { logger } from '../../utils/logger.js';
import { replyMessage, sendMessage } from './client.js';
import { buildAskMentionNotice } from './ask-card-meta.js';

interface AskNoticeDeps {
  canReplyToRoot: boolean;
  reply: typeof replyMessage;
  send: typeof sendMessage;
  /** 测试或特殊调用方可覆盖策略读取；生产默认从当前 bot 配置实时读取。 */
  resolvePolicy?: (larkAppId: string) => AskReminderPolicy;
}

/** 后续问题的统一提醒间隔。 */
export const ASK_REMINDER_DELAY_MS = 30_000;

const askReminderTimers = new Map<string, NodeJS.Timeout>();

/** 停止指定 ASK 的后续提醒，结算、失效和超时时均由 dispatcher 调用。 */
export function cancelAskApproverFollowups(askId: string): void {
  const timer = askReminderTimers.get(askId);
  if (timer) clearTimeout(timer);
  askReminderTimers.delete(askId);
}

/** 仅接受标签末尾的明确推荐标记，避免把正文里的“推荐”误当默认答案。 */
function recommendedAnswers(questions: ReadonlyArray<AskQuestion>): string[][] | undefined {
  const answers: string[][] = [];
  for (const question of questions) {
    const recommended = question.options.filter(option => (
      /[（(]\s*(?:推荐|recommended)\s*[）)]\s*$/i.test(option.label)
    ));
    if (recommended.length !== 1) return undefined;
    answers.push([recommended[0]!.key]);
  }
  return answers;
}

function resolvePolicy(ask: PendingAsk, deps: AskNoticeDeps): AskReminderPolicy {
  return deps.resolvePolicy?.(ask.larkAppId)
    ?? getBotCardPrefs(ask.larkAppId).askReminderPolicy;
}

/**
 * 为连续提问的后续问题安排 30 秒节拍。
 *
 * 方案 1 的首个节拍只提醒，第二个节拍尝试按每题唯一推荐项推进；缺少明确
 * 推荐时安全退化为持续提醒。方案 2 每个节拍都只提醒。
 */
export function scheduleAskApproverFollowups(
  ask: PendingAsk,
  deps: AskNoticeDeps,
): void {
  cancelAskApproverFollowups(ask.askId);
  let tick = 0;

  const scheduleNext = () => {
    const timer = setTimeout(() => {
      askReminderTimers.delete(ask.askId);
      void runTick();
    }, ASK_REMINDER_DELAY_MS);
    timer.unref?.();
    askReminderTimers.set(ask.askId, timer);
  };

  const runTick = async () => {
    const current = getAskSnapshot(ask.askId);
    if (!current || current.settled) return;
    tick += 1;

    if (tick >= 2 && resolvePolicy(current, deps) === 'auto-recommend') {
      const selections = recommendedAnswers(current.questions);
      if (selections) {
        const outcome = submitAskFromDesktop({
          askId: current.askId,
          selections,
          by: 'botmux-auto-recommend',
        });
        if (outcome === 'accepted' || outcome === 'already_settled' || outcome === 'stale') return;
      }
    }

    await notifyAskApprovers(current, deps);
    const afterNotice = getAskSnapshot(ask.askId);
    if (afterNotice && !afterNotice.settled) scheduleNext();
  };

  scheduleNext();
}

/** 清理测试用计时器，避免假时钟跨用例泄漏。 */
export function _resetAskReminderSchedulesForTest(): void {
  for (const timer of askReminderTimers.values()) clearTimeout(timer);
  askReminderTimers.clear();
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
