/**
 * ASK 后续问题提醒策略测试。
 *
 * 通过真实 broker 与 Lark dispatcher 验证首次立即提醒、30 秒补提醒、
 * 推荐项自动推进和循环提醒，外部飞书接口仅使用内存替身。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _getPending,
  _resetForTest,
  registerAsk,
  setCanTalkChecker,
  setCardDispatcher,
} from '../src/core/ask-broker.js';
import type { AskQuestion } from '../src/core/ask-types.js';
import {
  ASK_SELECT_ACTION,
  createLarkAskCardDispatcher,
  handleAskCardAction,
} from '../src/im/lark/ask-card.js';
import {
  ASK_REMINDER_DELAY_MS,
  _resetAskReminderSchedulesForTest,
} from '../src/im/lark/ask-card-notification.js';

const sentCards: Array<{ messageId: string; card: Record<string, any> }> = [];
const updatedCards: Array<{ messageId: string; card: Record<string, any> }> = [];
const notices: string[] = [];

function question(prompt: string, recommended = '方案 A（推荐）'): AskQuestion {
  return {
    prompt,
    multiSelect: false,
    options: [
      { key: 'a', label: recommended },
      { key: 'b', label: '方案 B' },
    ],
  };
}

async function flushDispatch(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function latestCard(): Record<string, any> {
  return updatedCards.at(-1)?.card ?? sentCards.at(-1)!.card;
}

async function answerFirst(flowId: string): Promise<void> {
  const result = registerAsk({
    larkAppId: 'cli_ask',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    sessionId: 'sess-1',
    questions: [question('第一问')],
    timeoutMs: 180_000,
    flowId,
    approvers: ['ou_owner'],
  });
  await flushDispatch();
  const action = latestCard().elements
    .flatMap((element: any) => element.actions ?? [])
    .find((button: any) => button.value?.action === ASK_SELECT_ACTION);
  const pending = _getPending(action.value.ask_id)!;
  await handleAskCardAction({
    operator: { open_id: 'ou_owner' },
    action: {
      value: {
        action: ASK_SELECT_ACTION,
        ask_id: pending.askId,
        nonce: pending.nonce,
        projection_id: pending.projectionId,
        key: 'a',
      },
    },
  });
  await result;
  await flushDispatch();
}

function installDispatcher(policy: 'auto-recommend' | 'repeat-reminder'): void {
  setCardDispatcher(createLarkAskCardDispatcher({
    resolveAskReminderPolicy: () => policy,
    async replyMessage(_appId, _rootId, content, msgType) {
      if (msgType === 'text') {
        notices.push(content);
        return `om_notice_${notices.length}`;
      }
      const messageId = `om_card_${sentCards.length + 1}`;
      sentCards.push({ messageId, card: JSON.parse(content) });
      return messageId;
    },
    async updateMessage(_appId, messageId, content) {
      updatedCards.push({ messageId, card: JSON.parse(content) });
    },
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  sentCards.length = 0;
  updatedCards.length = 0;
  notices.length = 0;
  _resetAskReminderSchedulesForTest();
  _resetForTest();
  setCanTalkChecker((_app, _chat, openId) => openId === 'ou_owner');
});

afterEach(() => {
  _resetAskReminderSchedulesForTest();
  _resetForTest();
  vi.useRealTimers();
});

describe('ASK 后续问题提醒策略', () => {
  it('方案1默认：首问立即提醒，后续问题30秒提醒、60秒按明确推荐项自动推进', async () => {
    installDispatcher('auto-recommend');
    await answerFirst('turn-auto');
    expect(notices).toHaveLength(1);

    const second = registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: [question('第二问')],
      timeoutMs: 180_000,
      flowId: 'turn-auto',
      approvers: ['ou_owner'],
    });
    await flushDispatch();

    await vi.advanceTimersByTimeAsync(ASK_REMINDER_DELAY_MS - 1);
    expect(notices).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(notices).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(ASK_REMINDER_DELAY_MS);
    await expect(second).resolves.toMatchObject({
      kind: 'answered',
      answers: [['a']],
      by: 'botmux-auto-recommend',
    });
    expect(notices).toHaveLength(2);
  });

  it('方案1遇到没有明确推荐项的问题时不擅自选择，并退化为每30秒提醒', async () => {
    installDispatcher('auto-recommend');
    await answerFirst('turn-no-recommendation');
    const second = registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: [question('第二问', '方案 A')],
      timeoutMs: 180_000,
      flowId: 'turn-no-recommendation',
      approvers: ['ou_owner'],
    });
    await flushDispatch();

    await vi.advanceTimersByTimeAsync(ASK_REMINDER_DELAY_MS * 2);
    expect(notices).toHaveLength(3);
    const pending = _getPending(
      latestCard().elements
        .flatMap((element: any) => element.actions ?? [])
        .find((button: any) => button.value?.action === ASK_SELECT_ACTION)
        .value.ask_id,
    );
    expect(pending?.settled).toBe(false);
    void second;
  });

  it('方案2：后续问题从30秒开始每隔30秒提醒，回答前不自动推进', async () => {
    installDispatcher('repeat-reminder');
    await answerFirst('turn-repeat');
    const second = registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: [question('第二问')],
      timeoutMs: 180_000,
      flowId: 'turn-repeat',
      approvers: ['ou_owner'],
    });
    await flushDispatch();

    await vi.advanceTimersByTimeAsync(ASK_REMINDER_DELAY_MS * 3);
    expect(notices).toHaveLength(4);
    expect(JSON.stringify(latestCard())).toContain('第二问');
    void second;
  });
});
