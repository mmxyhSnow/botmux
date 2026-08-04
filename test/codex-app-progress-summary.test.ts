/**
 * Codex App 摘要时间线的状态投影回归。
 * 用例确保过程消息仍完整保存，而摘要只收录结构化重点变化和终态，
 * 并携带业务语义里程碑（分支/提交/MR/HAR），区分 AI 本轮结束与外部任务终态。
 */
import { describe, expect, it, vi } from 'vitest';
import { CodexAppProgressCard } from '../src/services/codex-app-progress-card.js';
import { renderCodexAppProgressReport } from '../src/services/codex-app-progress-report.js';

/** 创建不依赖飞书网络的最小进度卡环境。 */
function summaryHarness(): CodexAppProgressCard {
  return new CodexAppProgressCard({
    post: vi.fn(async () => 'om_summary'),
    patch: vi.fn(async () => {}),
    persist: vi.fn(),
  });
}

function marker(overview: Record<string, unknown>): string {
  return `<!--botmux-progress:${JSON.stringify(overview)}-->`;
}

describe('Codex App 摘要时间线', () => {
  it('首个结构化进展进入摘要且正文不保留内部标记', async () => {
    const card = summaryHarness();
    await card.accept('om_turn', '摘要事件');
    await card.append(
      'om_turn',
      '开始定位。\n<!--botmux-progress:'
      + '{"stage":"定位","current":"读取日志","completed":[],"next":"确认根因"}'
      + '-->',
    );

    expect(card.snapshot()?.summaryEntryIndexes).toEqual([1]);
    expect(card.snapshot()?.content).toContain('开始定位。');
    expect(card.snapshot()?.content).not.toContain('botmux-progress');
  });

  it('只标记阶段、完成证据和终态变化', async () => {
    const card = summaryHarness();
    await card.accept('om_turn', '摘要事件');
    await card.append(
      'om_turn',
      '开始定位。\n<!--botmux-progress:'
      + '{"stage":"定位","current":"读取日志","completed":[],"next":"确认根因"}'
      + '-->',
    );
    await card.append(
      'om_turn',
      '继续检查。\n<!--botmux-progress:'
      + '{"stage":"定位","current":"检查第二组日志","completed":[],"next":"确认根因"}'
      + '-->',
    );
    await card.append(
      'om_turn',
      '根因已确认。\n<!--botmux-progress:'
      + '{"stage":"定位","current":"根因已确认","completed":["完成根因定位"],'
      + '"next":"验证修复","evidence":["错误日志已复现"]}'
      + '-->',
    );
    await card.append('om_turn', '准备运行验证。');
    await card.settle('om_turn', 'completed');

    expect(card.snapshot()?.summaryEntryIndexes).toEqual([1, 3, 5]);
  });

  it('摘要里程碑携带业务语义标题，不用过程记录 N', async () => {
    const card = summaryHarness();
    await card.accept('om_turn', '华为短剧同步与HAR升级');
    await card.append('om_turn', `锁定基线。\n${marker({
      stage: '锁定 bugfix/fix_shortplay_detail 基线',
      current: '读取增量', completed: [], next: '回灌',
    })}`);
    await card.append('om_turn', `回灌完成。\n${marker({
      stage: '回灌', current: '完成 7 个华为提交', completed: ['回灌 7 个华为提交'],
      next: '推送',
    })}`);
    await card.append('om_turn', `已推送并建 MR。\n${marker({
      stage: '推送', current: '创建 MR', completed: ['回灌 7 个华为提交'],
      next: '触发 HAR', delivery: ['MR 8293313'],
    })}`);

    const milestones = card.snapshot()?.summaryMilestones ?? [];
    const titles = milestones.map(m => m.title);
    expect(titles.some(t => t.includes('bugfix/fix_shortplay_detail'))).toBe(true);
    expect(titles.some(t => t.includes('MR 8293313'))).toBe(true);
    expect(titles.every(t => !t.includes('过程记录'))).toBe(true);
    // 交付里程碑必须是关键节点。
    expect(milestones.find(m => m.kind === 'delivery')?.critical).toBe(true);
  });

  it('验收案例：生成时 MR/HAR 运行中，摘要不谎报成功', async () => {
    const card = summaryHarness();
    await card.accept('om_turn', '华为短剧同步与HAR升级');
    await card.append('om_turn', `触发 HAR。\n${marker({
      stage: '触发 HAR', current: 'HAR 已触发', completed: ['回灌 7 个华为提交'],
      next: '等待终态', delivery: ['MR 8293313'],
      external: [
        { label: 'MR 8293313', status: 'running' },
        { label: 'HAR 1.0.6-alpha.2 / job 816911007', status: 'Upgrading' },
      ],
    })}`);
    await card.settle('om_turn', 'completed');

    const snapshot = card.snapshot()!;
    // 外部仍在进行 → 终态文案不能是「本轮已完成」。
    expect(snapshot.content).toContain('外部任务仍在进行');
    expect(snapshot.content).not.toContain('本轮已完成');

    const html = renderCodexAppProgressReport(snapshot);
    expect(html).toContain('外部任务仍在进行');
    expect(html).not.toContain('外部任务存在失败');
  });

  it('验收案例：后续状态更新为 HAR Failed，刷新后摘要体现失败', async () => {
    const card = summaryHarness();
    await card.accept('om_turn', '华为短剧同步与HAR升级');
    await card.append('om_turn', `触发 HAR。\n${marker({
      stage: '触发 HAR', current: 'HAR 已触发', completed: ['回灌 7 个华为提交'],
      next: '等待终态', delivery: ['MR 8293313'],
      external: [
        { label: 'MR 8293313', status: 'running' },
        { label: 'HAR 1.0.6-alpha.2 / job 816911007', status: 'Upgrading' },
      ],
    })}`);

    // 生成时的静态报告：HAR 尚未失败，只报「仍在进行」。
    const runningHtml = renderCodexAppProgressReport(card.snapshot()!);
    expect(runningHtml).toContain('外部任务仍在进行');
    expect(runningHtml).not.toContain('外部任务存在失败');

    // 后续状态回读：HAR 变为 Failed。
    await card.append('om_turn', `HAR 构建失败。\n${marker({
      stage: '回读终态', current: 'HAR 构建失败', completed: ['回灌 7 个华为提交'],
      next: '排查失败', delivery: ['MR 8293313'],
      external: [
        { label: 'MR 8293313', status: 'running' },
        { label: 'HAR 1.0.6-alpha.2 / job 816911007', status: 'Failed' },
      ],
    })}`);
    await card.settle('om_turn', 'completed');

    const snapshot = card.snapshot()!;
    // 外部状态翻转必须进入摘要，且携带失败语义里程碑。
    const failureMilestone = snapshot.summaryMilestones
      ?.find(m => m.kind === 'external' && m.title.includes('失败'));
    expect(failureMilestone?.critical).toBe(true);

    // 刷新后的静态报告：体现外部失败，不再是「仍在进行」。
    const failedHtml = renderCodexAppProgressReport(snapshot);
    expect(failedHtml).toContain('外部任务存在失败');
    expect(failedHtml).toContain('816911007');
    expect(failedHtml).not.toContain('本轮已完成');
    // 完整过程仍保留全部记录。
    expect(failedHtml).toContain('展示所有');
  });

  it('legacy 无 external 字段时终态文案是 AI 本轮执行已结束', async () => {
    const card = summaryHarness();
    await card.accept('om_turn', '普通任务');
    await card.append('om_turn', `完成修复。\n${marker({
      stage: '完成', current: '修复已应用', completed: ['应用修复'], next: '无',
    })}`);
    await card.settle('om_turn', 'completed');

    const content = card.snapshot()?.content ?? '';
    expect(content).toContain('AI 本轮执行已结束（未记录外部任务状态）');
    expect(content).not.toContain('本轮已完成');
  });
});
