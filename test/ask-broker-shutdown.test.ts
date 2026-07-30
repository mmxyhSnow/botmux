/**
 * ASK broker 重启收口回归测试。
 *
 * 验证 daemon 下线前会等待待答卡片切成失效态，避免群里残留仍可点击的死按钮。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetForTest,
  invalidateAllAndWait,
  registerAsk,
  setCardDispatcher,
} from '../src/core/ask-broker.js';
import { createLarkAskCardDispatcher } from '../src/im/lark/ask-card.js';

beforeEach(() => {
  _resetForTest();
});

afterEach(() => {
  _resetForTest();
});

describe('ASK broker 优雅重启', () => {
  it('等待失效卡片回写完成后才结束 pending ASK 收口', async () => {
    let releasePatch: (() => void) | undefined;
    const patchedCards: string[] = [];
    setCardDispatcher(createLarkAskCardDispatcher({
      async replyMessage() {
        return 'om_ask_restart';
      },
      async updateMessage(_appId, _messageId, content) {
        await new Promise<void>(resolve => {
          releasePatch = resolve;
        });
        patchedCards.push(content);
      },
    }));

    const result = registerAsk({
      larkAppId: 'cli_ask',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'session-restart',
      questions: [{
        prompt: '是否继续？',
        options: [
          { key: 'yes', label: '继续' },
          { key: 'no', label: '停止' },
        ],
        multiSelect: false,
      }],
      timeoutMs: 10_000,
    });
    await Promise.resolve();
    await Promise.resolve();

    let finished = false;
    const closing = invalidateAllAndWait('daemon restarting').then((count: number) => {
      finished = true;
      return count;
    });
    await Promise.resolve();
    expect(finished).toBe(false);

    releasePatch?.();
    await expect(closing).resolves.toBe(1);
    await expect(result).resolves.toMatchObject({
      kind: 'invalidated',
      reason: 'daemon restarting',
    });
    expect(patchedCards).toHaveLength(1);
    expect(patchedCards[0]).toContain('已失效');
    expect(patchedCards[0]).not.toContain('ask_select');
  });
});
