/**
 * 校验 Codex App 进度卡的飞书 JSON 2.0 交互结构。
 * 用例来源于线上飞书拒绝旧 action 容器的 HTTP 400 回归。
 */
import { describe, expect, it } from 'vitest';
import { renderCodexAppProgressCard } from '../src/services/codex-app-progress-card.js';
import { renderCodexAppProgressHistoryCard } from '../src/services/codex-app-progress-card-renderer.js';

describe('Codex App 进度卡 JSON 2.0 结构', () => {
  it('主卡使用 behaviors 按钮且不生成旧 action 容器', () => {
    const rendered = JSON.parse(renderCodexAppProgressCard({
      phase: 'running',
      activeTurnId: 'om_turn',
      acceptedTurnIds: ['om_turn'],
      pendingTurns: [],
      sessionId: 'sess-progress',
      title: '兼容性验证',
      content: '[19:00:00] 已收到，开始处理。',
    } as any));

    expect(rendered.schema).toBe('2.0');
    expect(rendered.body.elements).not.toContainEqual(
      expect.objectContaining({ tag: 'action' }),
    );
    const columns = rendered.body.elements.find(
      (element: { tag?: string }) => element.tag === 'column_set',
    )?.columns;
    expect(columns).toHaveLength(1);
    expect(columns[0].elements[0]).toMatchObject({
      tag: 'button',
      behaviors: [{
        type: 'callback',
        value: {
          action: 'codex_progress_history_open',
          session_id: 'sess-progress',
          page: '1',
        },
      }],
    });
    expect(columns[0].elements[0]).not.toHaveProperty('value');
  });

  it('历史分页使用 behaviors 按钮且保留前后页参数', () => {
    const card = JSON.parse(renderCodexAppProgressHistoryCard({
      phase: 'running',
      activeTurnId: 'om_turn',
      acceptedTurnIds: ['om_turn'],
      pendingTurns: [],
      sessionId: 'sess-history',
      title: '长任务',
      content: Array.from(
        { length: 13 },
        (_, index) => `[19:${String(index).padStart(2, '0')}:00] 第 ${index + 1} 条进展。`,
      ).join('\n\n'),
    } as any, 2));

    expect(card.body.elements).not.toContainEqual(
      expect.objectContaining({ tag: 'action' }),
    );
    const columns = card.body.elements.find(
      (element: { tag?: string }) => element.tag === 'column_set',
    )?.columns;
    expect(columns).toHaveLength(2);
    expect(columns[0].elements[0]).toMatchObject({
      behaviors: [{
        type: 'callback',
        value: {
          action: 'codex_progress_history_page',
          session_id: 'sess-history',
          page: '1',
        },
      }],
    });
    expect(columns[1].elements[0]).toMatchObject({
      behaviors: [{
        type: 'callback',
        value: {
          action: 'codex_progress_history_page',
          session_id: 'sess-history',
          page: '3',
        },
      }],
    });
  });
});
