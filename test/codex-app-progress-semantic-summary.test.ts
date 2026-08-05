/**
 * 运行中语义摘要的生成、合并刷新与失败保留契约。
 * 测试注入模型结果，不启动真实 Codex，也不访问飞书或网络。
 */
import { describe, expect, it, vi } from 'vitest';
import { CodexAppProgressCard } from '../src/services/codex-app-progress-card.js';
import {
  buildCodexAppProgressSemanticSummaryPrompt,
  parseCodexAppProgressSemanticSummary,
} from '../src/services/codex-app-progress-semantic-summary.js';
import { renderCodexAppProgressTimeline } from '../src/services/codex-app-progress-report-timeline.js';
import type {
  CodexAppProgressCardSessionState,
  CodexAppProgressSemanticSummaryItem,
} from '../src/types.js';

const FIRST_SUMMARY: CodexAppProgressSemanticSummaryItem[] = [{
  title: '根因已锁定',
  summary: '完整日志共同表明摘要只是复用了原始过程文本。',
  sourceEntryIndexes: [0, 1],
}];

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function reportState(): CodexAppProgressCardSessionState {
  return {
    phase: 'running',
    activeTurnId: 'om_turn',
    acceptedTurnIds: ['om_turn'],
    pendingTurns: [],
    title: '语义摘要',
    content: '[10:00:00] 读取第一组日志。\n\n[10:01:00] 根因已经确认。',
    currentEntryCount: 2,
    semanticSummary: {
      status: 'ready',
      items: FIRST_SUMMARY,
      sourceEntryCount: 2,
    },
  };
}

describe('Codex App 运行中语义摘要', () => {
  it('模型输入包含完整时间线与权威看板，输出索引必须真实存在', () => {
    const state = Object.assign(reportState(), {
      overview: {
        stage: '定位', current: '根因确认', completed: ['完成定位'], next: '修复',
      },
    });
    const prompt = buildCodexAppProgressSemanticSummaryPrompt(state);
    expect(prompt).toContain('读取第一组日志');
    expect(prompt).toContain('根因已经确认');
    expect(prompt).toContain('完成定位');

    const valid = JSON.stringify({ items: FIRST_SUMMARY });
    expect(parseCodexAppProgressSemanticSummary(valid, 2)).toEqual(FIRST_SUMMARY);
    expect(parseCodexAppProgressSemanticSummary(
      JSON.stringify({ items: [{ ...FIRST_SUMMARY[0], sourceEntryIndexes: [2] }] }),
      2,
    )).toBeUndefined();
  });

  it('生成期间的新进展合并为一次补跑，主进展写入不等待模型', async () => {
    const first = deferred<CodexAppProgressSemanticSummaryItem[] | undefined>();
    const second = deferred<CodexAppProgressSemanticSummaryItem[] | undefined>();
    const summarize = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const card = new CodexAppProgressCard({
      post: vi.fn(async () => 'om_card'),
      patch: vi.fn(async () => {}),
      persist: vi.fn(),
      publishReport: vi.fn(),
      summarize,
    });

    await card.accept('om_turn', '后台合并');
    await card.append('om_turn', '第一条进展。');
    await card.append('om_turn', '第二条进展。');
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(card.snapshot()?.content).toContain('第二条进展');

    first.resolve(FIRST_SUMMARY);
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(2));
    expect(card.snapshot()?.semanticSummary?.status).toBe('updating');
    expect(card.snapshot()?.semanticSummary?.items).toEqual(FIRST_SUMMARY);

    const latest = [{
      title: '修复已经验证',
      summary: '两轮进展已合并为最新的综合结论。',
      sourceEntryIndexes: [1, 2],
    }];
    second.resolve(latest);
    await vi.waitFor(() => expect(card.snapshot()?.semanticSummary?.status).toBe('ready'));
    expect(card.snapshot()?.semanticSummary?.items).toEqual(latest);
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it('刷新失败保留最近一次成功摘要，不回退到原文筛选', async () => {
    const summarize = vi.fn()
      .mockResolvedValueOnce(FIRST_SUMMARY)
      .mockRejectedValueOnce(new Error('模型暂时不可用'));
    const card = new CodexAppProgressCard({
      post: vi.fn(async () => 'om_card'),
      patch: vi.fn(async () => {}),
      persist: vi.fn(),
      publishReport: vi.fn(),
      summarize,
    });

    await card.accept('om_turn', '失败保留');
    await card.append('om_turn', '第一条进展。');
    await vi.waitFor(() => expect(card.snapshot()?.semanticSummary?.status).toBe('ready'));
    await card.append('om_turn', '第二条进展。');
    await vi.waitFor(() => expect(card.snapshot()?.semanticSummary?.status).toBe('failed'));
    expect(card.snapshot()?.semanticSummary?.items).toEqual(FIRST_SUMMARY);
    expect(card.snapshot()?.semanticSummary?.sourceEntryCount).toBe(2);
  });

  it('摘要视图渲染综合结论，全部视图仍保留原始时间线', () => {
    const html = renderCodexAppProgressTimeline(reportState(), '<h2>完整时间线</h2>');
    expect(html).toContain('timeline-semantic-event');
    expect(html).toContain('根因已锁定');
    expect(html).toContain('完整日志共同表明');
    expect(html).toContain('timeline-complete');
    expect(html).toContain('读取第一组日志');
    expect(html).toContain('根因已经确认');
    expect(html).toContain('展示摘要 <span>1</span>');
  });
});
