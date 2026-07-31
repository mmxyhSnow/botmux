/**
 * Codex App 完整过程 HTML 的生成与安全路径解析。
 * 报告写入 Botmux 数据目录，由 Dashboard 的现有令牌鉴权后提供访问。
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import type { CodexAppProgressCardSessionState } from '../types.js';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { splitProgressCardEntries } from './codex-app-progress-pagination.js';
import { extractFinalReplyActions } from './final-reply-actions.js';

export interface CodexAppProgressReportWriteOptions {
  dataDir?: string;
}

export interface CodexAppProgressReportFile {
  reportId: string;
  filePath: string;
}

/**
 * 最终回复来自模型 Markdown。禁用原始 HTML 和图片自动加载，只保留安全文本、
 * 常用格式与显式链接，避免完整过程页成为脚本或外部资源注入入口。
 */
const REPORT_MARKDOWN = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});
REPORT_MARKDOWN.disable('image');
const defaultLinkOpen = REPORT_MARKDOWN.renderer.rules.link_open;
REPORT_MARKDOWN.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noreferrer noopener');
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, index, options, env, self)
    : self.renderToken(tokens, index, options);
};

/** 为同一逻辑任务生成稳定标识，运行中可覆盖更新，终态后自然冻结。 */
function progressReportId(state: CodexAppProgressCardSessionState): string {
  return createHash('sha256')
    .update(`${state.sessionId ?? 'session'}:${state.startedAtMs ?? 0}`)
    .digest('hex')
    .slice(0, 32);
}

/** 把内部稳定标识压缩成便于回顾和口头沟通的报告编号。 */
function progressReportCode(state: CodexAppProgressCardSessionState): string {
  return `BM-${progressReportId(state).slice(0, 6).toUpperCase()}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const REPORT_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const REPORT_DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 统一使用紧凑日期，避免不同 Node 版本输出空格或斜杠差异。 */
function reportDate(timestampMs: number): string {
  return REPORT_DATE_FORMATTER.format(new Date(timestampMs)).replaceAll('/', '.');
}

function phaseLabel(state: CodexAppProgressCardSessionState): string {
  if (state.phase === 'running') return '进行中';
  if (state.phase === 'completed') return '已完成';
  if (state.phase === 'failed') return '失败';
  return '已中断';
}

function elapsedMinutes(state: CodexAppProgressCardSessionState): number {
  if (!state.startedAtMs || !state.updatedAtMs || state.updatedAtMs <= state.startedAtMs) return 0;
  return Math.max(1, Math.floor((state.updatedAtMs - state.startedAtMs) / 60_000));
}

/** 渲染面板内的紧凑信息块，链接仍交给受限 Markdown 渲染器处理。 */
function listBlock(
  title: string,
  items: string[] | undefined,
  empty: string,
  renderLinks = false,
): string {
  const content = items?.length
    ? `<ul>${items.map(item =>
        `<li>${renderLinks ? REPORT_MARKDOWN.renderInline(item) : escapeHtml(item)}</li>`).join('')}</ul>`
    : `<p class="muted">${escapeHtml(empty)}</p>`;
  return `<div class="list-block"><h3>${escapeHtml(title)}</h3>${content}</div>`;
}

/** 把已完成项和验证证据并排呈现为可快速扫读的证明卡片。 */
function proofGrid(
  completed: string[] | undefined,
  evidence: string[] | undefined,
): string {
  const cards = [
    ...(completed ?? []).map((item, index) => ({
      label: `完成 ${String(index + 1).padStart(2, '0')}`,
      item,
      status: '已完成',
    })),
    ...(evidence ?? []).map((item, index) => ({
      label: `验证 ${String(index + 1).padStart(2, '0')}`,
      item,
      status: '已记录',
    })),
  ];
  if (cards.length === 0) return '<p class="muted">未记录独立验证证据</p>';
  return `<div class="proof-grid">${cards.map(card => `<div class="proof-card"><span>${card.label}</span><strong>${escapeHtml(card.item)}</strong><small><i></i>${card.status}</small></div>`).join('')}</div>`;
}

/** 统一生成编号标题，保证静态报告各区的阅读层级一致。 */
function sectionHeading(index: string, eyebrow: string, title: string): string {
  return `<div class="section-heading"><span>${index}</span><div><p>${eyebrow}</p><h2>${title}</h2></div></div>`;
}

/** 最终回复只展示用户正文，内部快捷操作协议由飞书卡片单独消费。 */
function finalResponseSection(
  finalResponse: string | undefined,
  delivery: string[] | undefined,
): string {
  const content = extractFinalReplyActions(finalResponse ?? '').content.trim();
  const body = content
    ? REPORT_MARKDOWN.render(content)
    : '<p class="muted">未归档最终回复</p>';
  return `<section class="conclusion-panel">${sectionHeading('02', 'THE OUTCOME', '最终结论')}<div class="final-response">${body}</div>${listBlock('产物与链接', delivery, '无外部交付', true)}</section>`;
}

/** 把历史记录的时间戳拆成独立刻度，正文保持原样且继续转义。 */
function timelineItem(entry: string, index: number, total: number): string {
  const matched = /^\[(\d{2}:\d{2}):\d{2}\]\s*([\s\S]*)$/.exec(entry);
  const time = matched?.[1] ?? '--:--';
  const content = (matched?.[2] ?? entry).trim();
  const titled = /^([^：:\n/]{2,12})[：:]\s*([\s\S]+)$/.exec(content);
  const title = titled?.[1] ?? `过程记录 ${String(index + 1).padStart(2, '0')}`;
  const copy = titled?.[2] ?? content;
  const connector = index < total - 1 ? '<b></b>' : '';
  return `<li><div class="timeline-time"><strong>${escapeHtml(time)}</strong><span>记录 ${String(index + 1).padStart(2, '0')}</span></div><div class="timeline-marker"><i></i>${connector}</div><div class="timeline-copy"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(copy).replace(/\n/g, '<br>')}</p></div></li>`;
}

/** 将当前持久化投影渲染成不依赖脚本和外部资源的单文件 HTML。 */
export function renderCodexAppProgressReport(
  state: CodexAppProgressCardSessionState,
): string {
  const overview = state.overview;
  const endedAtMs = state.updatedAtMs ?? Date.now();
  const endedText = state.phase === 'running' ? '更新' : state.phase === 'completed' ? '完成' : '结束';
  const progress = overview?.total
    ? `${overview.completed.length}/${overview.total}`
    : `${overview?.completed.length ?? 0} 项`;
  const progressPercent = overview?.total
    ? Math.min(100, Math.round((overview.completed.length / overview.total) * 100))
    : 0;
  const history = splitProgressCardEntries(state.content);
  const historyHtml = history.length
    ? `<ol class="timeline">${history.map((item, index) =>
        timelineItem(item, index, history.length)).join('')}</ol>`
    : '<p class="muted">暂无过程记录</p>';
  const blocker = overview?.blocker
    ? `<aside class="alert"><strong>当前阻塞</strong><p>${escapeHtml(overview.blocker)}</p></aside>`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(state.title)} · 完整过程</title>
  <style>
    :root{color-scheme:light;--page-bg:#f1f1f1;--ink:#1a1c1c;--muted:#616574;--paper:#fff;--surface:#f8f8f8;--border:#e1e3e9;--accent:#0758e8;--accent-soft:#fde9e4;--success:#138a3d;--danger:#c9362b;font:15px/1.6 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
    *{box-sizing:border-box}body{margin:0;background:var(--page-bg);color:var(--ink);-webkit-font-smoothing:antialiased}main{max-width:1248px;margin:0 auto;padding:48px 24px 64px}.muted{color:var(--muted)}
    .report{overflow:hidden;background:var(--paper);box-shadow:0 10px 34px rgba(25,31,40,.07)}
    .report-header{min-height:230px;padding:46px 48px 42px;display:flex;align-items:flex-start;justify-content:space-between;gap:40px;border-bottom:1px solid var(--border)}
    .status-line{display:flex;align-items:center;gap:8px;color:#858a9a;font:700 10px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.12em}.status-dot{width:7px;height:7px;border-radius:50%;background:var(--success)}.phase-running .status-dot{background:var(--accent)}.phase-failed .status-dot{background:var(--danger)}.phase-interrupted .status-dot{background:#858a9a}.status-separator{opacity:.45}
    .report-heading h1{max-width:780px;margin:24px 0 18px;font-size:clamp(38px,6vw,48px);line-height:1.08;letter-spacing:-.042em}.report-deck{max-width:720px;margin:0;color:var(--muted);font-size:17px;line-height:1.55}.report-meta{margin:10px 0 0;color:#8b8f9b;font-size:11px}
    .report-index{display:flex;min-width:120px;flex-direction:column;align-items:flex-end;white-space:nowrap;text-align:right}.report-index span,.report-index small{color:#858a9a;font:700 10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.08em}.report-index strong{margin:6px 0 2px;font-size:26px;line-height:1.15;letter-spacing:-.04em}
    .report-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr)}.summary-panel{grid-column:1;grid-row:1}.conclusion-panel{grid-column:2;grid-row:1}.evidence-panel{grid-column:1;grid-row:2}.timeline-panel{grid-column:2;grid-row:2}.summary-panel,.conclusion-panel,.evidence-panel,.timeline-panel{padding:46px 48px 52px}.summary-panel,.evidence-panel{background:var(--surface);border-right:1px solid var(--border)}.summary-panel,.conclusion-panel{border-bottom:1px solid var(--border)}
    .section-heading{display:flex;align-items:flex-start;gap:14px;margin-bottom:34px}.section-heading>span{padding-top:3px;color:var(--accent);font:800 10px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace}.section-heading p{margin:0 0 5px;color:#858a9a;font:700 10px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.12em}.section-heading h2{margin:0;font-size:23px;line-height:1.15;letter-spacing:-.03em}
    .metric-grid{display:grid;grid-template-columns:1fr 1fr;gap:28px 18px}.metric{min-width:0}.metric span{display:block;color:#858a9a;font-size:10px;font-weight:700;letter-spacing:.06em}.metric strong{display:block;margin:5px 0 1px;font-size:17px;line-height:1.3;overflow-wrap:anywhere}.metric small{color:#858a9a;font:9px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
    .progress-track{height:3px;margin:30px 0 26px;overflow:hidden;background:#e5e7ec}.progress-track span{display:block;height:100%;background:var(--accent)}.next-step{padding:17px 20px;border-left:4px solid #93b2f5;background:var(--accent-soft)}.next-step span,.alert strong{color:#7b9ee9;font-size:10px;font-weight:800;letter-spacing:.08em}.next-step p,.alert p{margin:7px 0 0;line-height:1.55}.alert{margin-top:14px;padding:15px 18px;border-left:4px solid #e7b84b;background:#fff5d8}.alert strong{color:#8d6a10}
    .final-response{font-size:14px}.final-response>p:first-child{margin-top:0;font-size:clamp(24px,3.8vw,32px);font-weight:720;line-height:1.28;letter-spacing:-.035em;color:var(--ink)}.final-response p,.final-response ul,.final-response ol,.final-response pre,.final-response table,.final-response blockquote{margin:0 0 18px}.final-response>:last-child{margin-bottom:0}.final-response a{color:var(--accent);overflow-wrap:anywhere}.final-response ul,.final-response ol{padding:0;list-style:none;counter-reset:outcome}.final-response li{display:grid;grid-template-columns:28px minmax(0,1fr);gap:8px;padding:14px 0;border-bottom:1px solid var(--border);color:var(--muted)}.final-response li:first-child{border-top:1px solid var(--border)}.final-response li:before{counter-increment:outcome;content:counter(outcome,decimal-leading-zero);padding-top:2px;color:#858a9a;font:700 9px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}.final-response pre{padding:14px;overflow:auto;background:#f2f3f5}.final-response code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.final-response table{display:block;max-width:100%;overflow:auto;border-collapse:collapse}.final-response th,.final-response td{padding:7px 10px;border:1px solid var(--border);text-align:left}.final-response blockquote{padding-left:14px;border-left:3px solid var(--border);color:var(--muted)}
    .list-block{margin-top:30px;padding-top:20px;border-top:1px solid var(--border)}.list-block h3{margin:0 0 12px;color:#676b78;font-size:10px;letter-spacing:.08em}.list-block ul{margin:0;padding:0;list-style:none}.list-block li{margin:0 0 8px;padding-left:15px;position:relative}.list-block li:before{content:"";position:absolute;top:.72em;left:0;width:5px;height:5px;border-radius:50%;background:var(--accent)}.list-block a{color:var(--accent);overflow-wrap:anywhere}
    .conclusion-panel>.list-block{padding:20px 22px;border:0;background:#1a1c1c;color:#fff}.conclusion-panel>.list-block h3{color:#858a9a}.conclusion-panel>.list-block li{padding-left:0}.conclusion-panel>.list-block li:before{display:none}.conclusion-panel>.list-block a{color:#fff;text-decoration-color:#777;text-underline-offset:4px}
    .proof-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.proof-card{min-width:0;padding:16px;background:#fff;border:1px solid var(--border)}.proof-card>span{display:block;color:#858a9a;font-size:9px;font-weight:800;letter-spacing:.07em}.proof-card>strong{display:block;margin:9px 0 13px;font:700 13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.proof-card>small{display:flex;align-items:center;gap:6px;color:var(--success);font-size:9px;font-weight:800}.proof-card>small i{width:5px;height:5px;border-radius:50%;background:var(--success)}.evidence-panel>.list-block{margin-top:32px}.evidence-panel>.list-block li{padding-left:14px;color:var(--muted);font-size:12px}
    .timeline{margin:0;padding:0;list-style:none}.timeline li{display:grid;grid-template-columns:74px 32px minmax(0,1fr);min-height:104px}.timeline-time{display:flex;align-items:flex-end;flex-direction:column;padding-top:1px}.timeline-time strong{font:750 14px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace}.timeline-time span{margin-top:4px;color:#858a9a;font-size:9px;font-weight:700}.timeline-marker{display:flex;align-items:center;flex-direction:column;padding-top:5px}.timeline-marker i{z-index:1;width:8px;height:8px;border:2px solid var(--accent);border-radius:50%;background:var(--paper)}.timeline-marker b{width:1px;flex:1;background:var(--border)}.timeline-copy{padding:0 0 28px 12px}.timeline-copy h3{margin:0 0 5px;font-size:15px;line-height:1.35}.timeline-copy p{margin:0;color:var(--muted);font-size:12px;line-height:1.65}
    .report-footer{display:flex;justify-content:space-between;gap:24px;padding:25px 30px;border-top:1px solid var(--border);color:#858a9a;font:700 9px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.1em}.footer-note{margin-left:auto;text-align:right}
    @media(max-width:760px){main{padding:12px 10px 36px}.report-header{min-height:0;padding:34px 24px 30px;flex-direction:column;gap:24px}.report-heading h1{font-size:34px}.report-deck{font-size:15px}.report-index{width:100%;padding-top:18px;border-top:1px solid var(--border);align-items:flex-start;text-align:left}.report-layout{grid-template-columns:1fr}.summary-panel,.conclusion-panel,.evidence-panel,.timeline-panel{grid-column:auto;grid-row:auto;padding:34px 24px 40px;border-right:0;border-bottom:1px solid var(--border)}.summary-panel,.evidence-panel{background:#fafafa}.report-footer{flex-wrap:wrap}.footer-note{width:100%;margin-left:0;text-align:left}}
    @media(max-width:440px){.metric-grid,.proof-grid{grid-template-columns:1fr}.timeline li{grid-template-columns:56px 20px minmax(0,1fr)}.timeline-copy{padding-left:9px}.final-response>p:first-child{font-size:23px}.report-index strong{font-size:23px}}
    @media print{body{background:#fff}main{max-width:none;padding:0}.report{box-shadow:none}.report-footer{break-before:avoid}}
  </style>
</head>
<body>
<main>
  <article class="report phase-${state.phase}">
    <header class="report-header">
      <div class="report-heading">
        <div class="status-line"><span class="status-dot"></span><span>${phaseLabel(state)}</span><span class="status-separator">/</span><span>BOTMUX TASK ARCHIVE</span></div>
        <h1>${escapeHtml(state.title)}</h1>
        <p class="report-deck">完整保留任务结论、验证证据、交付产物与执行过程。</p>
        <p class="report-meta">用时 ${elapsedMinutes(state)} 分钟 · ${REPORT_TIME_FORMATTER.format(new Date(endedAtMs))} ${endedText}</p>
      </div>
      <div class="report-index"><span>任务编号</span><strong class="task-code">${progressReportCode(state)}</strong><small>${reportDate(endedAtMs)}</small></div>
    </header>
    <div class="report-layout">
      <section class="summary-panel">
        ${sectionHeading('01', 'OVERVIEW', '任务摘要')}
        <div class="metric-grid">
          <div class="metric"><span>阶段</span><strong>${escapeHtml(overview?.stage ?? phaseLabel(state))}</strong><small>STAGE</small></div>
          <div class="metric"><span>进度</span><strong>${escapeHtml(progress)}</strong><small>${progressPercent}%</small></div>
          <div class="metric"><span>${state.phase === 'running' ? '当前' : '结果'}</span><strong>${escapeHtml(overview?.current ?? phaseLabel(state))}</strong><small>OUTCOME</small></div>
          <div class="metric"><span>用时</span><strong>${elapsedMinutes(state)} 分钟</strong><small>${REPORT_TIME_FORMATTER.format(new Date(endedAtMs))}</small></div>
        </div>
        <div class="progress-track" aria-label="任务进度 ${progressPercent}%"><span style="width:${progressPercent}%"></span></div>
        <div class="next-step"><span>下一步</span><p>${escapeHtml(overview?.next ?? '无')}</p></div>
        ${blocker}
      </section>
      ${finalResponseSection(state.finalResponse, overview?.delivery)}
      <section class="evidence-panel">
        ${sectionHeading('03', 'PROOF', '验证与交付')}
        ${proofGrid(overview?.completed, overview?.evidence)}
        ${listBlock('剩余风险', overview?.risks, '无已知剩余风险')}
      </section>
      <section class="timeline-panel">
        ${sectionHeading('04', 'FULL TRACE', '完整时间线')}
        ${historyHtml}
      </section>
    </div>
    <footer class="report-footer"><span>BOTMUX / PROGRESS REPORT</span><span class="footer-note">报告内容取自真实任务，页面用于完整回顾。</span><span>00—04</span></footer>
  </article>
</main>
</body>
</html>`;
}

/** 原子覆盖同一任务报告；运行中持续更新，终态后因状态不再同步而保持冻结。 */
export function writeCodexAppProgressReport(
  state: CodexAppProgressCardSessionState,
  options: CodexAppProgressReportWriteOptions = {},
): CodexAppProgressReportFile {
  const dataDir = options.dataDir ?? resolveBotmuxDataDir();
  const reportId = progressReportId(state);
  const reportDir = join(dataDir, 'progress-reports');
  const filePath = join(reportDir, `${reportId}.html`);
  mkdirSync(reportDir, { recursive: true });
  atomicWriteFileSync(filePath, renderCodexAppProgressReport(state));
  return { reportId, filePath };
}

/** 仅接受固定十六进制标识，避免用户输入逃逸报告目录。 */
export function resolveCodexAppProgressReportRequest(
  pathname: string,
  dataDir = resolveBotmuxDataDir(),
): string | undefined {
  const match = pathname.match(/^\/progress-reports\/([a-f0-9]{32})\.html$/);
  return match ? join(dataDir, 'progress-reports', `${match[1]}.html`) : undefined;
}

/** 在保留 Dashboard 令牌查询参数的同时，把入口切到当前报告。 */
export function buildCodexAppProgressReportUrl(
  dashboardUrl: string,
  reportId: string,
): string | undefined {
  if (!/^[a-f0-9]{32}$/.test(reportId)) return undefined;
  try {
    const url = new URL(dashboardUrl);
    url.pathname = `/progress-reports/${reportId}.html`;
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}
