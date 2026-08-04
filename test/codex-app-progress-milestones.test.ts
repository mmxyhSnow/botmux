/**
 * 摘要里程碑推导与 4–6 条选择的单元回归。
 * 关键契约：标题来自结构化差异（不用「过程记录 N」）；选择用语义 key 去重，
 * 强制保留交付/外部失败/终态，不做机械首末。
 */
import { describe, expect, it } from 'vitest';
import type { CodexAppProgressMilestone } from '../src/types.js';
import {
  deriveProgressMilestone,
  deriveTerminalMilestone,
  selectSummaryMilestones,
} from '../src/services/codex-app-progress-milestones.js';

describe('摘要里程碑推导', () => {
  it('首个进展用阶段语义标题，而不是过程记录 N', () => {
    const milestone = deriveProgressMilestone({
      previous: undefined,
      next: { stage: '锁定基线', current: '读取分支', completed: [], next: '回灌' },
      index: 1,
    });
    expect(milestone.title).toBe('阶段：锁定基线');
    expect(milestone.kind).toBe('stage');
    expect(milestone.title).not.toMatch(/过程记录/);
  });

  it('交付、外部失败、终态被标记为关键里程碑', () => {
    const delivery = deriveProgressMilestone({
      previous: { stage: 'A', current: 'x', completed: [], next: 'y' },
      next: {
        stage: 'A', current: 'x', completed: [], next: 'y',
        delivery: ['MR 8293313'],
      },
      index: 3,
    });
    expect(delivery).toMatchObject({ kind: 'delivery', critical: true });
    expect(delivery.title).toContain('MR 8293313');

    const failure = deriveProgressMilestone({
      previous: {
        stage: 'A', current: 'x', completed: [], next: 'y',
        external: [{ label: 'HAR', status: 'running' }],
      },
      next: {
        stage: 'A', current: 'x', completed: [], next: 'y',
        external: [{ label: 'HAR', status: 'Failed' }],
      },
      index: 5,
    });
    expect(failure).toMatchObject({ kind: 'external', critical: true });
    expect(failure.title).toContain('失败');

    const terminal = deriveTerminalMilestone({
      overview: {
        stage: '完成', current: 'done', completed: [], next: '无',
        external: [{ label: 'HAR', status: 'Failed' }],
      },
      phase: 'completed',
      index: 6,
    });
    expect(terminal).toMatchObject({ kind: 'terminal', critical: true });
    expect(terminal.title).toContain('外部任务存在失败');
  });

  it('Markdown 链接压成可读文本并截断超长标题', () => {
    const milestone = deriveProgressMilestone({
      previous: { stage: 'A', current: 'x', completed: [], next: 'y' },
      next: {
        stage: 'A', current: 'x', completed: [], next: 'y',
        delivery: ['[BITS MR 8293313](https://bits.example/detail/8293313)'],
      },
      index: 2,
    });
    expect(milestone.title).toBe('交付 BITS MR 8293313');
    expect(milestone.title).not.toContain('https://');
  });
});

describe('摘要里程碑选择', () => {
  it('少于上限时原样返回并按索引排序', () => {
    const milestones: CodexAppProgressMilestone[] = [
      { index: 1, title: '阶段：定位', kind: 'stage' },
      { index: 3, title: '完成回灌', kind: 'progress' },
      { index: 5, title: '本轮已完成', kind: 'terminal', critical: true },
    ];
    expect(selectSummaryMilestones(milestones).map(m => m.index)).toEqual([1, 3, 5]);
  });

  it('用语义 key 折叠重复阶段噪音', () => {
    const milestones: CodexAppProgressMilestone[] = [
      { index: 1, title: '阶段：定位', kind: 'stage' },
      { index: 2, title: '阶段：定位', kind: 'stage' },
      { index: 3, title: '阶段：定位', kind: 'stage' },
    ];
    const selected = selectSummaryMilestones(milestones);
    expect(selected).toHaveLength(1);
    expect(selected[0].index).toBe(3);
  });

  it('超过上限时保留交付与失败等关键节点，不机械首末', () => {
    const milestones: CodexAppProgressMilestone[] = [
      { index: 1, title: '阶段：锁定基线', kind: 'stage' },
      { index: 2, title: '阶段：回灌', kind: 'stage' },
      { index: 3, title: '完成 7 个提交', kind: 'progress' },
      { index: 4, title: '交付 MR 8293313', kind: 'delivery', critical: true },
      { index: 5, title: '阶段：触发 HAR', kind: 'stage' },
      { index: 6, title: '阶段：轮询', kind: 'stage' },
      { index: 7, title: '外部任务失败：HAR Failed', kind: 'external', critical: true },
      { index: 8, title: '阶段：复核', kind: 'stage' },
      { index: 9, title: '本轮结束，外部任务存在失败', kind: 'terminal', critical: true },
    ];
    const selected = selectSummaryMilestones(milestones);
    const kinds = selected.map(m => m.kind);
    expect(selected.length).toBeGreaterThanOrEqual(4);
    expect(selected.length).toBeLessThanOrEqual(6);
    // 关键节点必须全部在内。
    expect(kinds).toContain('delivery');
    expect(kinds).toContain('external');
    expect(kinds).toContain('terminal');
    // 终态天然是最后一条。
    expect(selected.at(-1)?.kind).toBe('terminal');
    // 不是机械的仅首条+末条：交付和失败这两个中段关键节点都在。
    expect(selected.map(m => m.index)).toEqual(
      expect.arrayContaining([4, 7, 9]),
    );
  });
});
