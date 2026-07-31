/**
 * Codex App 完整过程 HTML 的输出契约。
 * 用例确保群卡压缩后，完整证据仍能通过受保护的静态报告稳定回看。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCodexAppProgressReportUrl,
  resolveCodexAppProgressReportRequest,
  writeCodexAppProgressReport,
} from '../src/services/codex-app-progress-report.js';
import type { CodexAppProgressCardSessionState } from '../src/types.js';

const roots: string[] = [];

function completedState(): CodexAppProgressCardSessionState {
  return {
    phase: 'completed',
    activeTurnId: 'om_turn',
    acceptedTurnIds: ['om_turn'],
    pendingTurns: [],
    sessionId: 'session-sensitive-id',
    title: '修复 <Botmux> & Dashboard',
    content: [
      '[17:10:00] 第一条完整证据。',
      '[17:12:00] 第二条完整证据。',
      '[17:28:00] 本轮已完成。',
    ].join('\n\n'),
    startedAtMs: new Date('2026-07-30T09:10:00.000Z').getTime(),
    updatedAtMs: new Date('2026-07-30T09:28:00.000Z').getTime(),
    overview: {
      stage: '完成',
      current: '安全更新链路已上线',
      completed: ['版本解析', '同步脚本'],
      total: 2,
      next: '无',
      evidence: ['12 项测试通过'],
      delivery: ['[产物链接](https://code.example/artifact)'],
      risks: ['等待外部观察'],
    },
    finalResponse: [
      '中文场景选择 **humanizer-zh**。',
      '',
      '[完整评估](https://docs.example/report)',
      '',
      '<script>alert("unsafe")</script>',
      '',
      '<!--botmux-actions:{"actions":[{"label":"部署","prompt":"部署并重启","authorization":"explicit"}]}-->',
    ].join('\n'),
  };
}

describe('Codex App 完整过程 HTML', () => {
  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  });

  it('写入包含完整时间线和终态验收信息的转义 HTML', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-progress-report-'));
    roots.push(dataDir);

    const report = writeCodexAppProgressReport(completedState(), { dataDir });
    const html = readFileSync(report.filePath, 'utf8');

    expect(report.reportId).toMatch(/^[a-f0-9]{32}$/);
    expect(html).toContain('<article class="report phase-completed">');
    expect(html).toContain('class="summary-panel"');
    expect(html).toContain('class="conclusion-panel"');
    expect(html).toContain('class="evidence-panel"');
    expect(html).toContain('class="timeline-panel"');
    expect(html).toContain('class="proof-grid"');
    expect(html).toContain('class="report-footer"');
    expect(html).toContain('grid-template-columns:minmax(0,1fr) minmax(0,2fr)');
    expect(html).toContain('font-size:clamp(38px,6vw,48px)');
    expect(html).toMatch(/<strong class="task-code">BM-[A-F0-9]{6}<\/strong>/);
    expect(html).toContain('修复 &lt;Botmux&gt; &amp; Dashboard');
    expect(html).toContain('用时 18 分钟');
    expect(html).toContain('17:28 完成');
    expect(html).toContain('安全更新链路已上线');
    expect(html).toContain('12 项测试通过');
    expect(html).toContain('产物与链接');
    expect(html).toContain('href="https://code.example/artifact"');
    expect(html).toContain('>产物链接</a>');
    expect(html).toContain('等待外部观察');
    expect(html).toContain('<h2>最终结论</h2>');
    expect(html).toContain('中文场景选择 <strong>humanizer-zh</strong>');
    expect(html).toContain('href="https://docs.example/report"');
    expect(html).toContain('>完整评估</a>');
    expect(html).not.toContain('botmux-actions');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('第一条完整证据');
    expect(html).toContain('第二条完整证据');
    expect(html).toContain('<strong>17:10</strong>');
    expect(html).toContain('<h3>过程记录 01</h3>');
    expect(html).not.toContain('cdn.tailwindcss.com');
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html.indexOf('<h2>最终结论</h2>')).toBeLessThan(
      html.indexOf('>产物与链接<'),
    );
  });

  it('只把固定格式的报告路由映射到数据目录', () => {
    const dataDir = '/tmp/botmux-data';
    const reportId = '0123456789abcdef0123456789abcdef';

    expect(resolveCodexAppProgressReportRequest(
      `/progress-reports/${reportId}.html`,
      dataDir,
    )).toBe(join(dataDir, 'progress-reports', `${reportId}.html`));
    expect(resolveCodexAppProgressReportRequest(
      '/progress-reports/../../sessions.json',
      dataDir,
    )).toBeUndefined();
  });

  it('保留 Dashboard 鉴权参数并替换为报告路径', () => {
    const reportId = '0123456789abcdef0123456789abcdef';
    expect(buildCodexAppProgressReportUrl(
      'https://m-youc.example/?t=dashboard-token',
      reportId,
    )).toBe(
      `https://m-youc.example/progress-reports/${reportId}.html?t=dashboard-token`,
    );
  });
});
