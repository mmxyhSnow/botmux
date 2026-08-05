/**
 * Codex App 完整过程 HTML 的输出契约。
 * 用例确保群卡压缩后，完整证据仍能通过受保护的静态报告稳定回看。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      '- [开发提交 `61012639`](https://code.example/commit)，已合入 `custom/dev`：`d7ee16f1`。',
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

    const state = Object.assign(completedState(), { summaryEntryIndexes: [1, 2] });
    const report = writeCodexAppProgressReport(state, { dataDir });
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
    expect(html).toContain('<li><a href="https://code.example/commit" target="_blank" rel="noreferrer noopener">开发提交 <code>61012639</code></a>，已合入 <code>custom/dev</code>：<code>d7ee16f1</code>。</li>');
    expect(html).toContain('.final-response li{position:relative;padding:14px 0 14px 36px;');
    expect(html).toContain('.final-response li:before{position:absolute;top:16px;left:0;width:28px;');
    expect(html).not.toContain('.final-response li{display:grid;grid-template-columns:28px minmax(0,1fr)');
    expect(html).not.toContain('botmux-actions');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('第一条完整证据');
    expect(html).toContain('第二条完整证据');
    expect(html).toContain('<strong>17:10</strong>');
    expect(html).toContain('<h3>过程记录 01</h3>');
    expect(html).toContain('id="timeline-mode-summary"');
    expect(html).toContain('id="timeline-mode-all"');
    expect(html).toContain('for="timeline-mode-summary">展示摘要 <span>2</span>');
    expect(html).toContain('for="timeline-mode-all">展示所有 <span>3</span>');
    expect(html).toContain('id="timeline-mode-summary" name="timeline-mode" type="radio" checked');
    expect(html).toContain('timeline-item timeline-detail-event');
    expect(html).toContain('timeline-item timeline-summary-event');
    expect(html).toContain('#timeline-mode-summary:checked~.timeline-complete{display:none}');
    expect(html).toContain('#timeline-mode-all:checked~.timeline-semantic{display:none}');
    expect(html).toMatch(
      /<strong>17:28<\/strong><span>记录 03<\/span>[\s\S]*本轮已完成[\s\S]*<strong>17:12<\/strong><span>记录 02<\/span>[\s\S]*第二条完整证据[\s\S]*<strong>17:10<\/strong><span>记录 01<\/span>[\s\S]*第一条完整证据/,
    );
    expect(html).not.toContain('cdn.tailwindcss.com');
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html.indexOf('<h2>最终结论</h2>')).toBeLessThan(
      html.indexOf('>产物与链接<'),
    );
  });

  it('旧状态缺少摘要索引时不隐藏任何历史记录', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-progress-report-legacy-state-'));
    roots.push(dataDir);

    const report = writeCodexAppProgressReport(completedState(), { dataDir });
    const html = readFileSync(report.filePath, 'utf8');

    expect(html).toContain('for="timeline-mode-summary">展示摘要 <span>3</span>');
    expect(html).toContain('timeline-semantic');
    expect(html).toContain('timeline-complete');
    expect(html).toContain('timeline-item timeline-detail-event');
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

  it('读取历史报告时把混合行内内容恢复为单一正文流', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-progress-report-legacy-'));
    roots.push(dataDir);
    const reportId = '0123456789abcdef0123456789abcdef';
    const reportDir = join(dataDir, 'progress-reports');
    const filePath = join(reportDir, `${reportId}.html`);
    const legacyHtml = '<style>.final-response li{display:grid;grid-template-columns:28px minmax(0,1fr);gap:8px;padding:14px 0;border-bottom:1px solid var(--border);color:var(--muted)}.final-response li:before{counter-increment:outcome;content:counter(outcome,decimal-leading-zero);padding-top:2px;color:#858a9a;font:700 9px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}</style>';
    mkdirSync(reportDir);
    writeFileSync(filePath, legacyHtml);

    expect(resolveCodexAppProgressReportRequest(
      `/progress-reports/${reportId}.html`,
      dataDir,
    )).toBe(filePath);
    const normalized = readFileSync(filePath, 'utf8');

    expect(normalized).toContain('.final-response li{position:relative;padding:14px 0 14px 36px;');
    expect(normalized).toContain('.final-response li:before{position:absolute;top:16px;left:0;width:28px;');
    expect(normalized).not.toContain('display:grid;grid-template-columns:28px');
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
