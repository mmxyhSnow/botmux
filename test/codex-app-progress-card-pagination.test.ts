import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppProgressCard } from '../src/services/codex-app-progress-card.js';
import * as progressRenderer from '../src/services/codex-app-progress-card-renderer.js';
import type { CodexAppProgressCardSessionState } from '../src/types.js';

interface HarnessOptions {
  initial?: CodexAppProgressCardSessionState;
}

function harness(options: HarnessOptions = {}) {
  const posts: Array<{ cardJson: string; turnId: string }> = [];
  const patches: Array<{ messageId: string; cardJson: string }> = [];
  const states: CodexAppProgressCardSessionState[] = [];
  const card = new CodexAppProgressCard({
    post: async (cardJson, turnId) => {
      posts.push({ cardJson, turnId });
      const index = posts.length;
      return `om_card_${index}`;
    },
    patch: async (messageId, cardJson) => {
      patches.push({ messageId, cardJson });
    },
    persist: state => states.push(state),
  }, options.initial);
  return { card, posts, patches, states };
}

function header(cardJson: string) {
  return JSON.parse(cardJson).header as {
    template: string;
    title: { content: string };
  };
}

function bodyText(cardJson: string): string {
  const card = JSON.parse(cardJson);
  return card.body.elements
    .map((element: { content?: string }) => element.content ?? '')
    .join('\n');
}

async function fillFirstPage(card: CodexAppProgressCard): Promise<void> {
  await card.accept('om_turn', '长任务');
  for (let index = 1; index <= 7; index++) {
    await card.append('om_turn', `第 ${index} 条进展。`);
  }
}

describe('Codex App 进度卡多页状态机', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('超过旧字符阈值的完整进展仍保留在同一张主卡且不截断', async () => {
    const h = harness();
    const longProgress = '长'.repeat(1780);
    await h.card.accept('om_turn', '长文本');
    await h.card.append('om_turn', longProgress);

    expect(h.posts).toHaveLength(1);
    expect(h.card.snapshot()).toMatchObject({
      pageNumber: 1,
      currentEntryCount: 2,
      messageId: 'om_card_1',
    });
    expect(bodyText(h.patches.at(-1)!.cardJson)).toContain(longProgress);
  });

  it('终态把唯一主卡更新为绿色', async () => {
    const h = harness();
    await fillFirstPage(h.card);
    await h.card.append('om_turn', '第 8 条进展。');
    await h.card.settle('om_turn', 'completed');

    const latest = h.patches.filter(item => item.messageId === 'om_card_1').at(-1);
    expect(header(latest!.cardJson)).toMatchObject({
      template: 'green',
      title: { content: '已完成 · 长任务' },
    });
    expect(h.posts).toHaveLength(1);
  });

  it('旧单页状态恢复后从第一页继续', async () => {
    const h = harness({
      initial: {
        phase: 'running',
        activeTurnId: 'om_turn',
        acceptedTurnIds: ['om_turn'],
        pendingTurns: [],
        messageId: 'om_existing',
        title: '旧任务',
        content: '[19:00:00] 已收到，开始处理。',
      },
    });
    await h.card.append('om_turn', '继续处理。');

    expect(h.card.snapshot()).toMatchObject({
      pageNumber: 1,
      currentEntryCount: 2,
      messageId: 'om_existing',
    });
    expect(header(h.patches.at(-1)!.cardJson).title.content)
      .toBe('处理中 · 旧任务');
  });

  it('长任务始终复用一张主卡，不再自动发送归档卡', async () => {
    const h = harness();
    await fillFirstPage(h.card);
    await h.card.append('om_turn', '第 8 条进展。');
    await h.card.append('om_turn', '第 9 条进展。');

    expect(h.posts).toHaveLength(1);
    expect(h.card.snapshot()).toMatchObject({
      pageNumber: 1,
      currentEntryCount: 10,
      archivedPages: [],
    });
    expect(h.card.snapshot()?.content).toContain('第 9 条进展。');
  });

  it('按需历史卡在飞书内分页并保留页面导航', () => {
    const renderHistory = (progressRenderer as any).renderCodexAppProgressHistoryCard;
    expect(renderHistory).toBeTypeOf('function');
    if (typeof renderHistory !== 'function') return;

    const state = {
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
    } as any;
    const card = JSON.parse(renderHistory(state, 2));
    const text = JSON.stringify(card);

    expect(card.header.title.content).toContain('历史 2/3');
    expect(text).toContain('第 7 条进展');
    expect(text).toContain('第 12 条进展');
    expect(text).not.toContain('第 6 条进展');
    expect(text).not.toContain('第 13 条进展');
    expect(text).toContain('codex_progress_history_page');
  });
});
