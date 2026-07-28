import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppProgressCard } from '../src/services/codex-app-progress-card.js';
import type { CodexAppProgressCardSessionState } from '../src/types.js';

interface HarnessOptions {
  initial?: CodexAppProgressCardSessionState;
  post?: (cardJson: string, turnId: string, index: number) => Promise<string>;
  patch?: (messageId: string, cardJson: string) => Promise<void>;
  canRepostAfterPatchFailure?: (error: unknown) => boolean;
}

function harness(options: HarnessOptions = {}) {
  const posts: Array<{ cardJson: string; turnId: string }> = [];
  const patches: Array<{ messageId: string; cardJson: string }> = [];
  const states: CodexAppProgressCardSessionState[] = [];
  const card = new CodexAppProgressCard({
    post: async (cardJson, turnId) => {
      posts.push({ cardJson, turnId });
      const index = posts.length;
      return options.post?.(cardJson, turnId, index) ?? `om_card_${index}`;
    },
    patch: async (messageId, cardJson) => {
      patches.push({ messageId, cardJson });
      await options.patch?.(messageId, cardJson);
    },
    canRepostAfterPatchFailure: options.canRepostAfterPatchFailure,
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

  it('第九个内容块创建新卡并把第一页归档', async () => {
    const h = harness();
    await fillFirstPage(h.card);
    await h.card.append('om_turn', '第 8 条进展。');

    expect(h.posts).toHaveLength(2);
    expect(header(h.posts[1].cardJson)).toMatchObject({
      template: 'turquoise',
      title: { content: '处理中 · 长任务（进度 2）' },
    });
    expect(h.card.snapshot()).toMatchObject({
      pageNumber: 2,
      currentEntryCount: 1,
      messageId: 'om_card_2',
      archivedPages: [{
        pageNumber: 1,
        messageId: 'om_card_1',
        archivedSynced: true,
      }],
    });
    const archived = h.patches.find(item => header(item.cardJson).template === 'grey');
    expect(archived?.messageId).toBe('om_card_1');
    expect(header(archived!.cardJson).title.content).toBe('进度 1 · 已归档 · 长任务');
  });

  it('超过字符阈值的完整进展独占新页且不截断', async () => {
    const h = harness();
    const longProgress = '长'.repeat(1780);
    await h.card.accept('om_turn', '长文本');
    await h.card.append('om_turn', longProgress);

    expect(h.posts).toHaveLength(2);
    expect(h.card.snapshot()).toMatchObject({
      pageNumber: 2,
      currentEntryCount: 1,
    });
    expect(bodyText(h.posts[1].cardJson)).toContain(longProgress);
  });

  it('新页 POST 失败后保留分页状态并在下次更新重试', async () => {
    let failSecondPost = true;
    const h = harness({
      post: async (_cardJson, _turnId, index) => {
        if (index === 2 && failSecondPost) throw new Error('post failed');
        return `om_card_${index}`;
      },
    });
    await fillFirstPage(h.card);

    await expect(h.card.append('om_turn', '第 8 条进展。')).rejects.toThrow('post failed');
    expect(h.card.snapshot()).toMatchObject({
      pageNumber: 2,
      currentEntryCount: 1,
      archivedPages: [{ pageNumber: 1, messageId: 'om_card_1' }],
    });
    expect(h.card.snapshot()?.messageId).toBeUndefined();

    failSecondPost = false;
    await h.card.append('om_turn', '第 9 条进展。');
    expect(h.card.snapshot()).toMatchObject({
      pageNumber: 2,
      currentEntryCount: 2,
      archivedPages: [{ archivedSynced: true }],
    });
    expect(h.card.snapshot()?.content).toContain('第 8 条进展。');
    expect(h.card.snapshot()?.content).toContain('第 9 条进展。');
  });

  it('归档 PATCH 失败不隐藏新页并可在后续更新中恢复', async () => {
    let failArchive = true;
    const h = harness({
      patch: async (_messageId, cardJson) => {
        if (header(cardJson).template === 'grey' && failArchive) {
          throw new Error('archive failed');
        }
      },
    });
    await fillFirstPage(h.card);

    await expect(h.card.append('om_turn', '第 8 条进展。')).rejects.toThrow('archive failed');
    expect(h.posts).toHaveLength(2);
    expect(h.card.snapshot()).toMatchObject({
      pageNumber: 2,
      messageId: 'om_card_2',
      archivedPages: [{ pageNumber: 1, messageId: 'om_card_1' }],
    });
    expect(h.card.snapshot()?.archivedPages?.[0].archivedSynced).toBeUndefined();

    failArchive = false;
    await h.card.append('om_turn', '第 9 条进展。');
    expect(h.card.snapshot()).toMatchObject({
      archivedPages: [{ archivedSynced: true }],
    });
  });

  it('旧归档卡被撤回时不补发并继续当前页', async () => {
    const withdrawn = new Error('withdrawn');
    const h = harness({
      patch: async (_messageId, cardJson) => {
        if (header(cardJson).template === 'grey') throw withdrawn;
      },
      canRepostAfterPatchFailure: error => error === withdrawn,
    });
    await fillFirstPage(h.card);
    await h.card.append('om_turn', '第 8 条进展。');

    expect(h.posts).toHaveLength(2);
    expect(h.card.snapshot()).toMatchObject({
      pageNumber: 2,
      messageId: 'om_card_2',
      archivedPages: [{ archivedSynced: true }],
    });
  });

  it('终态只把最新页更新为绿色', async () => {
    const h = harness();
    await fillFirstPage(h.card);
    await h.card.append('om_turn', '第 8 条进展。');
    await h.card.settle('om_turn', 'completed');

    const latest = h.patches.filter(item => item.messageId === 'om_card_2').at(-1);
    expect(header(latest!.cardJson)).toMatchObject({
      template: 'green',
      title: { content: '已完成 · 长任务（进度 2）' },
    });
    const archived = h.patches.filter(item => item.messageId === 'om_card_1').at(-1);
    expect(header(archived!.cardJson).template).toBe('grey');
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
      .toBe('处理中 · 旧任务（进度 1）');
  });
});
