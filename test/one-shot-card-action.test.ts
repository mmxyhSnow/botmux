/**
 * 一次性卡片按钮公共策略测试：默认消费、同组置灰、重复动作白名单与旧卡兼容。
 * Run: pnpm vitest run test/one-shot-card-action.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import {
  OneShotCardActionGuard,
  cardFromMessageDetail,
  freezeOneShotActionGroup,
  oneShotActionGroup,
} from '../src/im/lark/one-shot-card-action.js';

const finalActionsCard = {
  schema: '2.0',
  body: {
    elements: [{
      tag: 'column_set',
      columns: [
        {
          tag: 'column',
          elements: [{
            tag: 'button',
            text: { tag: 'plain_text', content: '生成补报预览' },
            type: 'primary',
            behaviors: [{
              type: 'callback',
              value: {
                action: 'final_reply_quick_action',
                label: '生成补报预览',
                prompt: '请生成补报预览。',
              },
            }],
          }],
        },
        {
          tag: 'column',
          elements: [{
            tag: 'button',
            text: { tag: 'plain_text', content: '修复并补报' },
            type: 'default',
            behaviors: [{
              type: 'callback',
              value: {
                action: 'final_reply_quick_action',
                label: '修复并补报',
                prompt: '请修复并补报。',
              },
            }],
          }],
        },
      ],
    }],
  },
};

const clickedValue = {
  action: 'final_reply_quick_action',
  label: '修复并补报',
  prompt: '请修复并补报。',
};

describe('one-shot card action policy', () => {
  it('unknown callback actions default to one-shot while registered controls remain repeatable', () => {
    expect(oneShotActionGroup(clickedValue)).toBe('final_reply_quick_action');
    expect(oneShotActionGroup({ action: 'open_local_terminal' })).toBeUndefined();
  });

  it('freezes every JSON 2.0 button in the clicked action group', () => {
    const result = freezeOneShotActionGroup(finalActionsCard, clickedValue);
    const columns = (result!.card.body as any).elements[0].columns;

    expect(columns[0].elements[0]).toMatchObject({ disabled: true, type: 'default' });
    expect(columns[1].elements[0]).toMatchObject({ disabled: true, type: 'default' });
    expect(columns[0].elements[0].text.content).toBe('生成补报预览');
    expect(columns[1].elements[0].text.content).toBe('✅ 修复并补报');
    expect((finalActionsCard.body.elements[0].columns[0].elements[0] as any).disabled).toBeUndefined();
  });

  it('freezes and checks a stored card after Feishu strips callback behaviors', () => {
    const storedCard = {
      schema: '2.0',
      body: {
        elements: [
          {
            tag: 'column_set',
            columns: [
              {
                tag: 'column',
                elements: [{
                  tag: 'button',
                  text: { tag: 'plain_text', content: '生成补报预览' },
                  type: 'primary',
                }],
              },
              {
                tag: 'column',
                elements: [{
                  tag: 'button',
                  text: { tag: 'plain_text', content: '修复并补报' },
                  type: 'default',
                }],
              },
            ],
          },
          {
            tag: 'column_set',
            columns: [{
              tag: 'column',
              elements: [{
                tag: 'button',
                text: { tag: 'plain_text', content: '查看完整过程' },
                type: 'default',
                multi_url: { url: 'https://example.com/report' },
              }],
            }],
          },
        ],
      },
    };

    const result = freezeOneShotActionGroup(storedCard, clickedValue);
    const elements = (result!.card.body as any).elements;
    const choices = elements[0].columns;
    const report = elements[1].columns[0].elements[0];

    expect(result?.changed).toBe(true);
    expect(choices[0].elements[0]).toMatchObject({
      disabled: true,
      type: 'default',
      text: { content: '生成补报预览' },
    });
    expect(choices[1].elements[0]).toMatchObject({
      disabled: true,
      type: 'default',
      text: { content: '✅ 修复并补报' },
    });
    expect(report).not.toHaveProperty('disabled');
  });

  it('unwraps user_dsl message content before freezing historical cards', () => {
    const detail = {
      items: [{
        msg_type: 'interactive',
        body: { content: JSON.stringify({ user_dsl: JSON.stringify(finalActionsCard) }) },
      }],
    };

    expect(cardFromMessageDetail(detail)).toEqual(finalActionsCard);
  });

  it('converts a successful toast to a frozen card and blocks the same group afterwards', async () => {
    const guard = new OneShotCardActionGuard();
    const loadCard = vi.fn(async () => ({
      items: [{
        msg_type: 'interactive',
        body: { content: JSON.stringify(finalActionsCard) },
      }],
    }));

    const result = await guard.finalize({
      larkAppId: 'app-a',
      messageId: 'om-card',
      actionTag: 'button',
      actionValue: clickedValue,
      shapedResult: { toast: { type: 'success', content: '已提交' } },
      loadCard,
    });

    const columns = result.card.data.body.elements[0].columns;
    expect(columns[0].elements[0].disabled).toBe(true);
    expect(columns[1].elements[0].disabled).toBe(true);
    expect(result.toast).toBeUndefined();
    expect(guard.isCompleted('app-a', 'om-card', 'button', clickedValue)).toBe(true);
  });

  it('does not consume failures, stateful card responses, or non-button callbacks', async () => {
    const guard = new OneShotCardActionGuard();
    const loadCard = vi.fn(async () => ({ items: [] }));
    const warning = { toast: { type: 'warning', content: '请重试' } };
    const card = { card: { type: 'raw', data: { schema: '2.0' } } };

    expect(await guard.finalize({
      larkAppId: 'app-a', messageId: 'om-warning', actionTag: 'button',
      actionValue: clickedValue, shapedResult: warning, loadCard,
    })).toBe(warning);
    expect(await guard.finalize({
      larkAppId: 'app-a', messageId: 'om-card-result', actionTag: 'button',
      actionValue: clickedValue, shapedResult: card, loadCard,
    })).toBe(card);
    expect(await guard.finalize({
      larkAppId: 'app-a', messageId: 'om-select', actionTag: 'select_static',
      actionValue: clickedValue, shapedResult: {}, loadCard,
    })).toEqual({});

    expect(loadCard).not.toHaveBeenCalled();
    expect(guard.isCompleted('app-a', 'om-warning', 'button', clickedValue)).toBe(false);
  });
});
