/**
 * Codex 连续提问卡片的行为测试。
 *
 * 这里通过真实 ask broker、Lark dispatcher 与卡片回调验证用户可见结果；
 * 仅替换外部飞书发送接口，避免测试依赖网络。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _getPending,
  _resetForTest,
  registerAsk,
  setCardDispatcher,
  setCanTalkChecker,
} from '../src/core/ask-broker.js';
import * as askBroker from '../src/core/ask-broker.js';
import type { AskQuestion } from '../src/core/ask-types.js';
import {
  ASK_SELECT_ACTION,
  createLarkAskCardDispatcher,
  handleAskCardAction,
} from '../src/im/lark/ask-card.js';

const sentCards: Array<{ messageId: string; card: Record<string, any> }> = [];
const updatedCards: Array<{ messageId: string; card: Record<string, any> }> = [];
let activeDispatcher: any;

function question(prompt: string, yes: string, no: string): AskQuestion {
  return {
    prompt,
    multiSelect: false,
    options: [
      { key: yes, label: yes },
      { key: no, label: no },
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

async function selectCurrent(
  flowId: string,
  prompt: string,
  selected: string,
  other: string,
): Promise<string> {
  const result = registerAsk({
    larkAppId: 'cli_ask',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    sessionId: 'sess-1',
    questions: [question(prompt, selected, other)],
    timeoutMs: 10_000,
    flowId,
  } as any);
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
        key: selected,
      },
    },
  });
  await result;
  await flushDispatch();
  return pending.askId;
}

beforeEach(() => {
  sentCards.length = 0;
  updatedCards.length = 0;
  _resetForTest();
  setCanTalkChecker((_app, _chat, openId) => openId === 'ou_owner');
  activeDispatcher = createLarkAskCardDispatcher({
    async replyMessage(_appId, _rootId, content) {
      const messageId = `om_card_${sentCards.length + 1}`;
      sentCards.push({ messageId, card: JSON.parse(content) });
      return messageId;
    },
    async updateMessage(_appId, messageId, content) {
      updatedCards.push({ messageId, card: JSON.parse(content) });
    },
  });
  setCardDispatcher(activeDispatcher);
});

afterEach(() => {
  _resetForTest();
});

describe('Codex 连续提问卡片', () => {
  it('锁定本轮提问对象时，在连续提问卡片中直接 @ 对方', async () => {
    registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: [question('请选择处理方式', '修复', '忽略')],
      timeoutMs: 10_000,
      flowId: 'turn-mention',
      approvers: ['ou_owner'],
    });
    await flushDispatch();

    const answerable = sentCards[0]!.card.elements[0].fields[1].text.content;
    expect(answerable).toContain('本轮提问对象');
    expect(answerable).toContain('<at id=ou_owner></at>');
  });

  it('同一 flow 的第二问复用原卡，并保留高亮且锁定的第一问', async () => {
    const firstPromise = registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: [question('第一问：优先优化什么？', '交互智能', '操作顺手')],
      timeoutMs: 10_000,
      flowId: 'turn-1',
    } as any);
    await flushDispatch();
    expect(sentCards).toHaveLength(1);

    const firstAskId = sentCards[0]!.card.elements
      .flatMap((element: any) => element.actions ?? [])
      .find((action: any) => action.value?.action === ASK_SELECT_ACTION)
      .value.ask_id;
    const firstAsk = _getPending(firstAskId)!;
    const settled = await handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: {
          action: ASK_SELECT_ACTION,
          ask_id: firstAsk.askId,
          nonce: firstAsk.nonce,
          key: '交互智能',
        },
      },
    }) as Record<string, any>;
    await expect(firstPromise).resolves.toMatchObject({
      kind: 'answered',
      answers: [['交互智能']],
    });

    const settledButtons = settled.elements
      .flatMap((element: any) => element.actions ?? [])
      .filter((action: any) => action.tag === 'button');
    expect(JSON.stringify(settled)).toContain('第一问：优先优化什么？');
    expect(settled.header.title.content).toBe('botmux ask');
    expect(settledButtons).toEqual(expect.arrayContaining([
      expect.objectContaining({
        disabled: true,
        type: 'primary',
        text: expect.objectContaining({ content: '✅ 交互智能' }),
      }),
      expect.objectContaining({
        disabled: true,
        type: 'default',
        text: expect.objectContaining({ content: '○ 操作顺手' }),
      }),
    ]));
    expect(JSON.stringify(settled)).toContain('你的选择：交互智能');

    registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: [question('第二问：采用哪种方式？', '动态追问', '单卡多题')],
      timeoutMs: 10_000,
      flowId: 'turn-1',
    } as any);
    await flushDispatch();

    expect(sentCards).toHaveLength(1);
    expect(updatedCards.at(-1)?.messageId).toBe(sentCards[0]!.messageId);
    const updatedText = JSON.stringify(updatedCards.at(-1)?.card);
    expect(updatedText).toContain('第一问：优先优化什么？');
    expect(updatedText).toContain('第二问：采用哪种方式？');
    expect(updatedText).toContain(ASK_SELECT_ACTION);
  });

  it('第六问自动开启下一段卡片，前五问仍保留在上一张卡', async () => {
    for (let index = 1; index <= 5; index++) {
      await selectCurrent('turn-long', `第${index}问`, `选择${index}`, `备选${index}`);
    }
    expect(sentCards).toHaveLength(1);

    const sixth = registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: [question('第6问', '选择6', '备选6')],
      timeoutMs: 10_000,
      flowId: 'turn-long',
    } as any);
    await flushDispatch();

    expect(sentCards).toHaveLength(2);
    expect(JSON.stringify(sentCards[0]!.card)).toContain('第1问');
    expect(JSON.stringify(sentCards[1]!.card)).toContain('第6问');
    const closedFirstSegment = updatedCards
      .filter(card => card.messageId === sentCards[0]!.messageId)
      .at(-1)?.card;
    expect(closedFirstSegment?.header?.template).toBe('green');
    expect(JSON.stringify(closedFirstSegment)).toContain('第5问');
    void sixth;
  });

  it('下一题作答前可撤销最近一步，并让模型收到重新提问信号', async () => {
    await selectCurrent('turn-undo', '第一问', '答案A', '答案B');
    const second = registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: [question('第二问', '继续', '停止')],
      timeoutMs: 10_000,
      flowId: 'turn-undo',
    } as any);
    await flushDispatch();

    const undoButton = latestCard().elements
      .flatMap((element: any) => element.actions ?? [])
      .find((button: any) => button.value?.action === 'ask_undo');
    expect(undoButton).toBeDefined();

    const pending = _getPending(undoButton.value.ask_id)!;
    const response = await handleAskCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: {
          action: 'ask_undo',
          ask_id: pending.askId,
          nonce: pending.nonce,
        },
      },
    }) as Record<string, any>;
    await expect(second).resolves.toMatchObject({ kind: 'answered', action: 'undo' });
    expect(JSON.stringify(response)).not.toContain('第一问');
    expect(JSON.stringify(response)).toContain('正在恢复上一问');
  });

  it('整轮结束后把最后一段卡片切换为完成态并保留全部答案', async () => {
    const askId = await selectCurrent('turn-complete', '最终确认', '确认完成', '继续追问');
    expect(activeDispatcher.completeFlow).toBeTypeOf('function');
    if (typeof activeDispatcher.completeFlow !== 'function') return;

    await activeDispatcher.completeFlow(_getPending(askId));

    const completed = updatedCards.at(-1)?.card;
    expect(completed?.header?.title?.content).toContain('已结束');
    expect(completed?.header?.template).toBe('green');
    expect(JSON.stringify(completed)).toContain('最终确认');
    expect(JSON.stringify(completed)).toContain('确认完成');
  });

  it('broker 可按 flowId 完成最后一段卡片', async () => {
    await selectCurrent('turn-complete-api', '是否完成', '完成', '继续');
    const completeAskFlow = (askBroker as any).completeAskFlow;
    expect(completeAskFlow).toBeTypeOf('function');
    if (typeof completeAskFlow !== 'function') return;

    await expect(completeAskFlow('turn-complete-api', 'sess-other')).resolves.toBe(false);
    await expect(completeAskFlow('turn-complete-api', 'sess-1')).resolves.toBe(true);

    expect(updatedCards.at(-1)?.card?.header?.title?.content).toContain('已结束');
  });

  it('最终完成更新必须等待结算卡片更新结束，避免被旧状态反向覆盖', async () => {
    let releaseSettledPatch: (() => void) | undefined;
    let completedCount = 0;
    setCardDispatcher({
      async send() {
        return { messageId: 'om_race_card' };
      },
      onSettle() {
        return new Promise<void>((resolve) => {
          releaseSettledPatch = resolve;
        });
      },
      async completeFlow() {
        completedCount++;
      },
    });

    const result = registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'sess-1',
      questions: [question('最终状态时序', '完成', '继续')],
      timeoutMs: 10_000,
      flowId: 'turn-complete-race',
    } as any);
    await flushDispatch();
    const askId = (askBroker as any)._allAskIds().at(-1);
    const pending = _getPending(askId)!;
    expect((askBroker as any).tryResolveAsk({
      askId,
      nonce: pending.nonce,
      selected: '完成',
      by: 'ou_owner',
    })).toBe('accepted');
    await result;

    const completion = (askBroker as any).completeAskFlow('turn-complete-race', 'sess-1');
    await flushDispatch();
    expect(completedCount).toBe(0);

    releaseSettledPatch?.();
    await expect(completion).resolves.toBe(true);
    expect(completedCount).toBe(1);
  });
});
