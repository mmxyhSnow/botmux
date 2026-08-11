/**
 * Codex App 流式进度标记从分句、结构化清洗到完整报告的端到端回归。
 * 契约：标记可跨 delta 到达，但报告只能保留完整业务句子和结构化看板结果。
 */
import { describe, expect, it, vi } from 'vitest';
import { CodexAppProgressThrottler } from '../src/services/codex-app-progress.js';
import { CodexAppProgressCard } from '../src/services/codex-app-progress-card.js';
import { renderCodexAppProgressReport } from '../src/services/codex-app-progress-report.js';

describe('Codex App 流式进度标记报告', () => {
  it('标记在 <! 处分片时不向完整时间线写入碎片或残余 JSON', async () => {
    const progress = new CodexAppProgressThrottler({ minIntervalMs: 0 });
    const card = new CodexAppProgressCard({
      post: vi.fn(async () => 'om_progress'),
      patch: vi.fn(async () => {}),
      persist: vi.fn(),
    });
    const marker = '<!--botmux-progress:'
      + '{"stage":"验证","current":"运行回归","completed":[],"next":"构建"}'
      + '-->';
    await card.accept('om_turn', '修复时间线碎片');

    const snapshots = [
      ...progress.drainSnapshots({
        turnId: 'om_turn',
        text: '代码已经修改。\n<!',
        startedAtMs: 1,
        nowMs: 2,
      }),
      ...progress.drainSnapshots({
        turnId: 'om_turn',
        text: `代码已经修改。\n${marker}继续检查。`,
        startedAtMs: 1,
        nowMs: 3,
      }),
    ];
    for (const snapshot of snapshots) await card.append('om_turn', snapshot.content);

    const html = renderCodexAppProgressReport(card.snapshot()!);
    expect(html).toContain('代码已经修改。');
    expect(html).toContain('继续检查。');
    expect(html).not.toContain('&lt;!');
    expect(html).not.toContain('botmux-progress');
    expect(card.snapshot()?.overview).toMatchObject({
      stage: '验证', current: '运行回归', completed: [], next: '构建',
    });
  });
});
