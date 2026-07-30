/**
 * ASK 卡片提问对象通知回归测试。
 *
 * 覆盖普通卡片的真实渲染结果，防止锁定对象的 open_id 再次退化为泛化文案。
 */
import { describe, expect, it } from 'vitest';

import type { PendingAsk } from '../src/core/ask-types.js';
import { buildAskCard } from '../src/im/lark/ask-card.js';

function lockedAsk(): PendingAsk {
  return {
    askId: 'ask-mention',
    nonce: 'nonce-mention',
    larkAppId: 'cli_ask',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    sessionId: 'sess-mention',
    questions: [{
      prompt: '请选择处理方式',
      options: [
        { key: 'fix', label: '修复' },
        { key: 'skip', label: '忽略' },
      ],
      multiSelect: false,
    }],
    approvers: ['ou_owner'],
    createdAt: 1_000,
    deadlineAt: 301_000,
    settled: false,
  };
}

describe('ASK 卡片提问对象通知', () => {
  it('锁定本轮提问对象时，在普通 ASK 卡片中直接 @ 对方', () => {
    const card = JSON.parse(buildAskCard(lockedAsk()));
    const answerable = card.elements[0].fields[1].text.content;

    expect(answerable).toContain('本轮提问对象');
    expect(answerable).toContain('<at id=ou_owner></at>');
    expect(answerable).not.toContain('本群可对话成员');
  });
});
