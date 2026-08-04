/**
 * Codex App 摘要时间线的状态投影回归。
 * 用例确保过程消息仍完整保存，而摘要只收录结构化重点变化和终态。
 */
import { describe, expect, it, vi } from 'vitest';
import { CodexAppProgressCard } from '../src/services/codex-app-progress-card.js';

/** 创建不依赖飞书网络的最小进度卡环境。 */
function summaryHarness(): CodexAppProgressCard {
  return new CodexAppProgressCard({
    post: vi.fn(async () => 'om_summary'),
    patch: vi.fn(async () => {}),
    persist: vi.fn(),
  });
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
});
