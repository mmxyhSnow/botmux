import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CodexAppProgressCard,
  renderCodexAppProgressCard,
} from '../src/services/codex-app-progress-card.js';
import type { CodexAppProgressCardSessionState } from '../src/types.js';

function harness(initial?: CodexAppProgressCardSessionState) {
  const posts: Array<{ cardJson: string; turnId: string }> = [];
  const patches: Array<{ messageId: string; cardJson: string }> = [];
  const states: CodexAppProgressCardSessionState[] = [];
  let postIndex = 0;
  const card = new CodexAppProgressCard({
    post: vi.fn(async (cardJson, turnId) => {
      posts.push({ cardJson, turnId });
      return `om_card_${++postIndex}`;
    }),
    patch: vi.fn(async (messageId, cardJson) => {
      patches.push({ messageId, cardJson });
    }),
    persist: state => states.push(state),
  }, initial);
  return { card, posts, patches, states };
}

describe('Codex App 即时进度卡', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T11:11:58.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('收到消息后先持久化 running，再立即创建一张卡', async () => {
    const h = harness();
    await h.card.accept('om_turn_1', '检查部署情况');

    expect(h.states[0]).toMatchObject({
      phase: 'running',
      activeTurnId: 'om_turn_1',
      content: '[19:11:58] 已收到，开始处理。',
    });
    expect(h.states[0]).not.toHaveProperty('messageId');
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].turnId).toBe('om_turn_1');
    expect(h.card.snapshot()?.messageId).toBe('om_card_1');
  });

  it('真实进展和接受的 steer 都更新同一张卡', async () => {
    const h = harness();
    await h.card.accept('om_turn_1', '长任务');
    await h.card.accept('om_steer', '补充要求');
    await h.card.steerAccepted('om_steer');
    await h.card.append('om_steer', '源码差异已经定位。');
    await h.card.append('om_steer', '源码差异已经定位。');

    expect(h.posts).toHaveLength(1);
    expect(h.patches).toHaveLength(2);
    expect(h.card.snapshot()).toMatchObject({
      acceptedTurnIds: ['om_turn_1', 'om_steer'],
      pendingTurns: [],
      content: '[19:11:58] 已收到，开始处理。\n\n[19:11:58] 源码差异已经定位。',
    });
  });

  it('首条、真实进展和终态分别记录北京时间', async () => {
    const h = harness();
    await h.card.accept('om_turn', '时间测试');
    vi.setSystemTime(new Date('2026-07-28T11:12:07.000Z'));
    await h.card.append('om_turn', '源码差异已经定位。');
    vi.setSystemTime(new Date('2026-07-28T11:13:09.000Z'));
    await h.card.settle('om_turn', 'completed');

    expect(h.card.snapshot()?.content).toBe(
      '[19:11:58] 已收到，开始处理。'
      + '\n\n[19:12:07] 源码差异已经定位。'
      + '\n\n[19:13:09] 本轮已完成。',
    );
  });

  it('恢复旧状态后只给新增内容记录时间', async () => {
    const h = harness({
      phase: 'running',
      activeTurnId: 'om_turn',
      acceptedTurnIds: ['om_turn'],
      pendingTurns: [],
      title: '旧任务',
      content: '已收到，开始处理。',
      messageId: 'om_existing',
    });
    await h.card.append('om_turn', '新进展。');

    expect(h.card.snapshot()?.content).toBe(
      '已收到，开始处理。\n\n[19:11:58] 新进展。',
    );
  });

  it('steer 被拒并排队后，在 turn/start 创建新卡', async () => {
    const h = harness();
    await h.card.accept('om_turn_1', '第一项');
    await h.card.accept('om_turn_2', '第二项');
    await h.card.turnStarted('om_turn_2');

    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]).toMatchObject({ turnId: 'om_turn_2' });
    expect(h.card.snapshot()).toMatchObject({
      phase: 'running',
      activeTurnId: 'om_turn_2',
      title: '第二项',
      acceptedTurnIds: ['om_turn_2'],
    });
  });

  it('POST 失败不丢状态，后续真实进展会重试创建', async () => {
    const states: CodexAppProgressCardSessionState[] = [];
    let attempt = 0;
    const card = new CodexAppProgressCard({
      post: vi.fn(async () => {
        attempt++;
        if (attempt === 1) throw new Error('temporary');
        return 'om_recovered';
      }),
      patch: vi.fn(async () => {}),
      persist: state => states.push(state),
    });

    await expect(card.accept('om_turn', '恢复测试')).rejects.toThrow('temporary');
    expect(card.snapshot()?.messageId).toBeUndefined();
    await card.append('om_turn', '网络已经恢复。');
    expect(card.snapshot()?.messageId).toBe('om_recovered');
    expect(states.at(-1)?.content).toContain('网络已经恢复。');
  });

  it('原卡被撤回时最多补发一次', async () => {
    const withdrawn = new Error('withdrawn');
    let postIndex = 0;
    const patch = vi.fn(async () => {
      throw withdrawn;
    });
    const card = new CodexAppProgressCard({
      post: vi.fn(async () => `om_card_${++postIndex}`),
      patch,
      canRepostAfterPatchFailure: error => error === withdrawn,
      persist: vi.fn(),
    });

    await card.accept('om_turn', '撤回测试');
    await card.append('om_turn', '第一次更新。');
    expect(card.snapshot()).toMatchObject({
      messageId: 'om_card_2',
      repostedAfterWithdraw: true,
    });
    await expect(card.append('om_turn', '第二次更新。')).rejects.toThrow('withdrawn');
    expect(postIndex).toBe(2);
  });

  it('终态更新原卡片并保留最终答案的新消息通道', async () => {
    const h = harness();
    await h.card.accept('om_turn', '完成测试');
    await h.card.settle('om_turn', 'completed');

    expect(h.posts).toHaveLength(1);
    expect(h.card.snapshot()).toMatchObject({ phase: 'completed' });
    expect(h.card.snapshot()?.content).toContain('本轮已完成');
    expect(JSON.parse(h.patches.at(-1)!.cardJson).header).toMatchObject({
      template: 'green',
      title: { content: '已完成 · 完成测试' },
    });
  });

  it('渲染器使用官方 markdown body 并映射失败色', () => {
    const rendered = JSON.parse(renderCodexAppProgressCard({
      phase: 'failed',
      activeTurnId: 'om_turn',
      acceptedTurnIds: ['om_turn'],
      pendingTurns: [],
      title: '构建任务',
      content: '**构建失败。**',
    }));
    expect(rendered.header.template).toBe('red');
    expect(rendered.body.elements[0]).toMatchObject({ tag: 'markdown' });
  });

  it('第一屏展示阶段看板、时间信息和最近三条证据', () => {
    const rendered = JSON.parse(renderCodexAppProgressCard({
      phase: 'running',
      activeTurnId: 'om_turn',
      acceptedTurnIds: ['om_turn'],
      pendingTurns: [],
      sessionId: 'sess-progress',
      title: '优化进度卡',
      content: [
        '[19:00:00] 第一条。',
        '[19:01:00] 第二条。',
        '[19:02:00] 第三条。',
        '[19:03:00] 第四条。',
      ].join('\n\n'),
      startedAtMs: new Date('2026-07-28T11:00:00.000Z').getTime(),
      updatedAtMs: new Date('2026-07-28T11:03:00.000Z').getTime(),
      overview: {
        stage: '验证',
        current: '运行回归测试',
        completed: ['回答态区分已完成'],
        next: '构建并部署',
      },
    } as any, { nowMs: new Date('2026-07-28T11:05:00.000Z').getTime() }));

    const text = JSON.stringify(rendered);
    expect(rendered.header.title.content).toBe('处理中 · 优化进度卡');
    expect(text).toContain('当前阶段');
    expect(text).toContain('验证');
    expect(text).toContain('正在处理');
    expect(text).toContain('运行回归测试');
    expect(text).toContain('已完成');
    expect(text).toContain('回答态区分已完成');
    expect(text).toContain('下一步');
    expect(text).toContain('构建并部署');
    expect(text).toContain('暂无真实阻塞');
    expect(text).toContain('已运行 5 分钟');
    expect(text).not.toContain('第一条');
    expect(text).toContain('第二条');
    expect(text).toContain('第四条');
    expect(text).toContain('codex_progress_toggle_details');
    expect(text).toContain('codex_progress_history_open');
  });

  it('显式进度标记更新短标题和看板字段，但不把标记写进时间线', async () => {
    const h = harness();
    await h.card.accept('om_turn', '原始需求很长很长');
    await h.card.append(
      'om_turn',
      '回答态已经完成。'
      + '\n<!--botmux-progress:'
      + '{"title":"优化进度卡","stage":"验证","current":"运行回归",'
      + '"completed":["回答态"],"next":"构建部署","blocker":null}'
      + '-->',
    );

    expect(h.card.snapshot()).toMatchObject({
      title: '优化进度卡',
      overview: {
        stage: '验证',
        current: '运行回归',
        completed: ['回答态'],
        next: '构建部署',
      },
    });
    expect(h.card.snapshot()?.content).toContain('回答态已经完成。');
    expect(h.card.snapshot()?.content).not.toContain('botmux-progress');
  });

  it('完成态留下精简验收摘要而不是只提示查看最新回复', async () => {
    const h = harness();
    await h.card.accept('om_turn', '完成态');
    await h.card.append(
      'om_turn',
      '验证和部署已经完成。'
      + '\n<!--botmux-progress:'
      + '{"title":"优化进度卡","stage":"完成","current":"功能已上线",'
      + '"completed":["123 项测试通过"],"next":"无",'
      + '"evidence":["正式构建通过"],"delivery":["Youc 已重启"],'
      + '"risks":["远端推送缺少凭据"],"blocker":null}'
      + '-->',
    );
    await h.card.settle('om_turn', 'completed');

    const completed = JSON.parse(h.patches.at(-1)!.cardJson);
    const text = JSON.stringify(completed);
    expect(completed.header.template).toBe('green');
    expect(text).toContain('验收摘要');
    expect(text).toContain('功能已上线');
    expect(text).toContain('正式构建通过');
    expect(text).toContain('Youc 已重启');
    expect(text).toContain('远端推送缺少凭据');
    expect(text).not.toContain('最终结果见最新回复');
  });
});
