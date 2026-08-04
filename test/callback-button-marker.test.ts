/**
 * 卡片发送出口标记测试：所有回调按钮携带可见文案，跳转按钮保持纯链接语义。
 * Run: pnpm vitest run test/callback-button-marker.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  BOTMUX_CALLBACK_LABEL_KEY,
  BOTMUX_CALLBACK_MARKER_KEY,
  stampBotmuxCallbackMarkers,
} from '../src/im/lark/callback-button-marker.js';

describe('callback button egress markers', () => {
  it('stamps legacy and JSON 2.0 callback labels while leaving jump buttons untouched', () => {
    const card = JSON.stringify({
      body: { elements: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '关闭会话' },
          value: { action: 'close' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '执行修复' },
          behaviors: [{ type: 'callback', value: { action: 'future_fix' } }],
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '查看报告' },
          multi_url: { url: 'https://example.com/report' },
        },
      ] },
    });

    const [legacy, current, jump] = JSON.parse(stampBotmuxCallbackMarkers(card)).body.elements;

    expect(legacy.value).toMatchObject({
      [BOTMUX_CALLBACK_MARKER_KEY]: 1,
      [BOTMUX_CALLBACK_LABEL_KEY]: '关闭会话',
    });
    expect(current.behaviors[0].value).toMatchObject({
      [BOTMUX_CALLBACK_MARKER_KEY]: 1,
      [BOTMUX_CALLBACK_LABEL_KEY]: '执行修复',
    });
    expect(jump).not.toHaveProperty('value');
  });
});
