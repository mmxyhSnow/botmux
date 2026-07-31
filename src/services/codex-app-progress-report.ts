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
  const content = matched?.[2] ?? entry;
  const connector = index < total - 1 ? '<b></b>' : '';
  return `<li><div class="timeline-time"><strong>${escapeHtml(time)}</strong><span>记录 ${String(index + 1).padStart(2, '0')}</span></div><div class="timeline-marker"><i></i>${connector}</div><div class="timeline-copy"><p>${escapeHtml(content).replace(/\n/g, '<br>')}</p></div></li>`;
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
    :root{color-scheme:light;--page-bg:#ebe8df;--ink:#1c211d;--muted:#68706a;--paper:#fffdf7;--surface:#f4f1e8;--border:#d8d5cc;--accent:#e05a38;--accent-soft:#f8dfd5;--success:#1d7b55;font:15px/1.6 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
    *{box-sizing:border-box}body{margin:0;background:var(--page-bg);color:var(--ink);-webkit-font-smoothing:antialiased}main{max-width:1240px;margin:0 auto;padding:28px 24px 64px}
    .report{overflow:hidden;background:var(--paper);border:1px solid var(--border);border-radius:22px;box-shadow:0 28px 76px rgba(35,37,31,.13)}
    .report-header{min-height:224px;padding:40px 48px 36px;display:flex;align-items:flex-end;justify-content:space-between;gap:32px;border-bottom:1px solid var(--border);position:relative}
    .report-header:before{content:"";position:absolute;top:0;left:48px;width:82px;height:5px;background:var(--accent)}
    .status-line{display:flex;align-items:center;gap:9px;color:var(--muted);font:700 10px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.1em}.status-dot{width:7px;height:7px;border-radius:50%;background:var(--success);box-shadow:0 0 0 5px color-mix(in srgb,var(--success) 14%,transparent)}.status-separator{opacity:.35}
    .report-heading h1{max-width:820px;margin:22px 0 16px;font-size:clamp(36px,4vw,60px);line-height:1;letter-spacing:-.048em}.meta,.muted{color:var(--muted)}.report-heading>.meta{margin:0;font-size:14px}
    .report-index{display:flex;flex-direction:column;align-items:flex-end;white-space:nowrap}.report-index span,.report-index small{color:var(--muted);font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.1em}.report-index strong{margin:5px 0;font:700 19px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace}
    .report-layout{display:grid;grid-template-columns:minmax(300px,.82fr) minmax(500px,1.5fr)}.summary-panel,.conclusion-panel,.evidence-panel,.timeline-panel{padding:40px 44px 46px}.summary-panel,.evidence-panel{background:var(--surface);border-right:1px solid var(--border)}.summary-panel,.conclusion-panel{border-bottom:1px solid var(--border)}
    .section-heading{display:flex;align-items:flex-start;gap:13px;margin-bottom:30px}.section-heading>span{padding-top:4px;color:var(--accent);font:800 10px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace}.section-heading p{margin:0 0 2px;color:var(--muted);font:700 9px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.14em}.section-heading h2{margin:0;font-size:22px;line-height:1.15;letter-spacing:-.03em}
    .metric-grid{display:grid;grid-template-columns:1fr 1fr;gap:17px 14px}.metric{min-width:0;padding-top:11px;border-top:1px solid var(--border)}.metric span{display:block;color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.08em}.metric strong{display:block;margin:7px 0 3px;font-size:17px;line-height:1.25;overflow-wrap:anywhere}.metric small{color:var(--muted);font:9px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
    .progress-track{height:5px;margin:28px 0 24px;overflow:hidden;background:color-mix(in srgb,var(--border) 80%,transparent)}.progress-track span{display:block;height:100%;background:var(--accent)}.next-step{padding:14px 16px;border-left:3px solid var(--accent);background:color-mix(in srgb,var(--accent-soft) 68%,transparent)}.next-step span,.alert strong{color:var(--muted);font-size:10px;font-weight:750;letter-spacing:.08em}.next-step p,.alert p{margin:6px 0 0;line-height:1.55}.alert{margin-top:14px;padding:14px 16px;border:1px solid #e7b84b;background:#fff8dd}
    .final-response{font-size:14px}.final-response>p:first-child{margin-top:0;font-size:clamp(22px,2.1vw,31px);font-weight:680;line-height:1.28;letter-spacing:-.035em}.final-response p,.final-response ul,.final-response ol,.final-response pre,.final-response table,.final-response blockquote{margin:0 0 13px}.final-response>:last-child{margin-bottom:0}.final-response a{color:#1456f0;overflow-wrap:anywhere}.final-response pre{padding:12px;overflow:auto;background:#f2f3f5;border-radius:8px}.final-response table{display:block;max-width:100%;overflow:auto;border-collapse:collapse}.final-response th,.final-response td{padding:6px 10px;border:1px solid #dee0e3;text-align:left}.final-response blockquote{padding-left:12px;border-left:3px solid var(--border);color:var(--muted)}
    .list-block{margin-top:26px;padding-top:18px;border-top:1px solid var(--border)}.list-block h3{margin:0 0 11px;font-size:11px;letter-spacing:.08em}.list-block ul{margin:0;padding:0;list-style:none}.list-block li{margin:0 0 8px;padding-left:15px;position:relative}.list-block li:before{content:"";position:absolute;top:.72em;left:0;width:5px;height:5px;border-radius:50%;background:var(--accent)}.list-block a{color:#1456f0;overflow-wrap:anywhere}
    .conclusion-panel>.list-block{padding:16px 18px;border:0;border-radius:10px;background:var(--ink);color:var(--paper)}.conclusion-panel>.list-block h3{color:rgba(255,253,247,.62)}.conclusion-panel>.list-block li{padding-left:0}.conclusion-panel>.list-block li:before{display:none}.conclusion-panel>.list-block a{color:#fff;text-decoration-color:rgba(255,255,255,.45);text-underline-offset:3px}
    .evidence-panel .list-block:first-of-type{margin-top:0;padding-top:0;border-top:0}.evidence-panel .list-block li{padding:10px 12px 10px 27px;border:1px solid var(--border);background:var(--paper)}.evidence-panel .list-block li:before{top:1.28em;left:12px;background:var(--success)}
    .timeline{margin:0;padding:0;list-style:none}.timeline li{display:grid;grid-template-columns:66px 22px minmax(0,1fr);min-height:94px}.timeline-time{display:flex;flex-direction:column;padding-top:2px}.timeline-time strong{font:700 12px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace}.timeline-time span{margin-top:4px;color:var(--muted);font-size:9px}.timeline-marker{display:flex;align-items:center;flex-direction:column;padding-top:5px}.timeline-marker i{z-index:1;width:9px;height:9px;border:2px solid var(--accent);border-radius:50%;background:var(--paper)}.timeline-marker b{width:1px;flex:1;background:var(--border)}.timeline-copy{padding:0 0 24px 14px}.timeline-copy p{margin:0;color:var(--muted);font-size:12px;line-height:1.6}
    @media(max-width:900px){.report-layout{grid-template-columns:1fr}.summary-panel,.evidence-panel{border-right:0}.conclusion-panel,.evidence-panel{border-bottom:1px solid var(--border)}}
    @media(max-width:640px){main{padding:12px 10px 40px}.report{border-radius:16px}.report-header{min-height:0;padding:34px 22px 27px;align-items:flex-start;flex-direction:column}.report-header:before{left:22px}.report-heading h1{font-size:36px;line-height:1.08}.report-index{width:100%;padding-top:16px;border-top:1px solid var(--border);align-items:flex-start}.summary-panel,.conclusion-panel,.evidence-panel,.timeline-panel{padding:29px 22px 34px}.metric-grid{grid-template-columns:1fr}.timeline li{grid-template-columns:53px 18px minmax(0,1fr)}.timeline-copy{padding-left:10px}.final-response>p:first-child{font-size:22px}}
  </style>
</head>
<body>
<main>
  <article class="report">
    <header class="report-header">
      <div class="report-heading">
        <div class="status-line"><span class="status-dot"></span><span>${phaseLabel(state)}</span><span class="status-separator">/</span><span>BOTMUX TASK ARCHIVE</span></div>
        <h1>${escapeHtml(state.title)}</h1>
        <p class="meta">用时 ${elapsedMinutes(state)} 分钟 · ${REPORT_TIME_FORMATTER.format(new Date(endedAtMs))} ${endedText}</p>
      </div>
      <div class="report-index"><span>任务报告</span><strong>${REPORT_DATE_FORMATTER.format(new Date(endedAtMs))}</strong><small>${state.phase === 'running' ? '持续更新' : '已归档'}</small></div>
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
        ${listBlock('已完成', overview?.completed, '暂无已完成项')}
        ${listBlock('验证证据', overview?.evidence, '未记录独立验证证据')}
        ${listBlock('剩余风险', overview?.risks, '无已知剩余风险')}
      </section>
      <section class="timeline-panel">
        ${sectionHeading('04', 'FULL TRACE', '完整时间线')}
        ${historyHtml}
      </section>
    </div>
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
