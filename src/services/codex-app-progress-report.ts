/**
 * Codex App 完整过程 HTML 的生成与安全路径解析。
 * 报告写入 Botmux 数据目录，由 Dashboard 的现有令牌鉴权后提供访问。
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexAppProgressCardSessionState } from '../types.js';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { splitProgressCardEntries } from './codex-app-progress-pagination.js';

export interface CodexAppProgressReportWriteOptions {
  dataDir?: string;
}

export interface CodexAppProgressReportFile {
  reportId: string;
  filePath: string;
}

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

function listSection(title: string, items: string[] | undefined, empty: string): string {
  const content = items?.length
    ? `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : `<p class="muted">${escapeHtml(empty)}</p>`;
  return `<section><h2>${escapeHtml(title)}</h2>${content}</section>`;
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
  const history = splitProgressCardEntries(state.content);
  const historyHtml = history.length
    ? `<ol class="timeline">${history.map(item =>
        `<li>${escapeHtml(item).replace(/\n/g, '<br>')}</li>`).join('')}</ol>`
    : '<p class="muted">暂无过程记录</p>';
  const blocker = overview?.blocker
    ? `<section class="alert"><h2>阻塞</h2><p>${escapeHtml(overview.blocker)}</p></section>`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(state.title)} · 完整过程</title>
  <style>
    :root{color-scheme:light dark;font:16px/1.6 system-ui,-apple-system,sans-serif}
    body{margin:0;background:#f5f7fa;color:#1f2329}main{max-width:880px;margin:0 auto;padding:32px 20px 64px}
    header,section{background:#fff;border:1px solid #e5e6eb;border-radius:12px;padding:20px;margin:0 0 16px}
    h1{font-size:24px;margin:10px 0 4px}h2{font-size:16px;margin:0 0 10px}
    p,ul,ol{margin:0}.badge{display:inline-block;padding:3px 10px;border-radius:999px;background:#d9f7ef;color:#06745b;font-weight:600}
    .meta,.muted{color:#646a73}.summary{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .summary div{min-width:0}.summary strong{display:block;margin-bottom:4px}.alert{border-color:#f7ba1e;background:#fffbe8}
    .timeline{padding-left:24px}.timeline li{padding:0 0 14px 8px;white-space:normal}.timeline li:last-child{padding-bottom:0}
    @media(max-width:640px){main{padding:16px 12px 40px}.summary{grid-template-columns:1fr}header,section{padding:16px}}
  </style>
</head>
<body>
<main>
  <header>
    <span class="badge">${phaseLabel(state)}</span>
    <h1>${escapeHtml(state.title)}</h1>
    <p class="meta">用时 ${elapsedMinutes(state)} 分钟 · ${REPORT_TIME_FORMATTER.format(new Date(endedAtMs))} ${endedText}</p>
  </header>
  <section class="summary">
    <div><strong>阶段</strong>${escapeHtml(overview?.stage ?? phaseLabel(state))}</div>
    <div><strong>进度</strong>${escapeHtml(progress)}</div>
    <div><strong>${state.phase === 'running' ? '当前' : '结果'}</strong>${escapeHtml(overview?.current ?? phaseLabel(state))}</div>
    <div><strong>下一步</strong>${escapeHtml(overview?.next ?? '无')}</div>
  </section>
  ${blocker}
  ${listSection('已完成', overview?.completed, '暂无已完成项')}
  ${listSection('验证证据', overview?.evidence, '未记录独立验证证据')}
  ${listSection('交付物', overview?.delivery, '无外部交付')}
  ${listSection('剩余风险', overview?.risks, '无已知剩余风险')}
  <section><h2>完整时间线</h2>${historyHtml}</section>
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
