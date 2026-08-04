/**
 * Codex App 完整过程页的时间线筛选与静态 HTML 渲染。
 * 使用原生单选框和 CSS 切换摘要/全部，页面不执行脚本。
 */
import type { CodexAppProgressCardSessionState } from '../types.js';
import { selectSummaryMilestones } from './codex-app-progress-milestones.js';
import { splitProgressCardEntries } from './codex-app-progress-pagination.js';

export const PROGRESS_REPORT_TIMELINE_STYLE = [
  '.timeline-mode-input{position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none}',
  '.timeline-heading-row{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:34px}.timeline-heading-row>.section-heading{margin-bottom:0}',
  '.timeline-toggle{display:flex;flex:0 0 auto;padding:3px;border:1px solid var(--border);background:var(--surface)}.timeline-toggle label{padding:6px 10px;color:#737784;font-size:10px;font-weight:750;line-height:1.2;cursor:pointer;white-space:nowrap}.timeline-toggle label span{margin-left:3px;font:700 9px/1 ui-monospace,SFMono-Regular,Consolas,monospace}',
  '#timeline-mode-summary:checked~.timeline-heading-row label[for="timeline-mode-summary"],#timeline-mode-all:checked~.timeline-heading-row label[for="timeline-mode-all"]{background:var(--ink);color:#fff}',
  '#timeline-mode-summary:focus-visible~.timeline-heading-row label[for="timeline-mode-summary"],#timeline-mode-all:focus-visible~.timeline-heading-row label[for="timeline-mode-all"]{outline:2px solid var(--accent);outline-offset:2px}',
  '#timeline-mode-summary:checked~.timeline .timeline-detail-event{display:none}',
  '#timeline-mode-summary:checked~.timeline .timeline-summary-last .timeline-marker b{display:none}',
  '.timeline-summary-empty{display:none}#timeline-mode-summary:checked~.timeline-summary-empty{display:block}',
  '.timeline{margin:0;padding:0;list-style:none}.timeline li{display:grid;grid-template-columns:74px 32px minmax(0,1fr);min-height:104px}.timeline-time{display:flex;align-items:flex-end;flex-direction:column;padding-top:1px}.timeline-time strong{font:750 14px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace}.timeline-time span{margin-top:4px;color:#858a9a;font-size:9px;font-weight:700}.timeline-marker{display:flex;align-items:center;flex-direction:column;padding-top:5px}.timeline-marker i{z-index:1;width:8px;height:8px;border:2px solid var(--accent);border-radius:50%;background:var(--paper)}.timeline-marker b{width:1px;flex:1;background:var(--border)}.timeline-copy{padding:0 0 28px 12px}.timeline-copy h3{margin:0 0 5px;font-size:15px;line-height:1.35}.timeline-copy p{margin:0;color:var(--muted);font-size:12px;line-height:1.65}',
  '@media(max-width:440px){.timeline-heading-row{align-items:stretch;flex-direction:column}.timeline-toggle{align-self:flex-start}.timeline li{grid-template-columns:56px 20px minmax(0,1fr)}.timeline-copy{padding-left:9px}}',
  '@media print{.timeline-mode-input,.timeline-toggle,.timeline-summary-empty{display:none!important}.timeline .timeline-detail-event{display:grid!important}.timeline .timeline-summary-last .timeline-marker b{display:block!important}}',
].join('');

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 把一条原始记录渲染为带摘要分类的时间线节点。 */
function timelineItem(
  entry: string,
  recordIndex: number,
  hasNext: boolean,
  summaryEvent: boolean,
  summaryLast: boolean,
  summaryTitle: string | undefined,
): string {
  const matched = /^\[(\d{2}:\d{2}):\d{2}\]\s*([\s\S]*)$/.exec(entry);
  const time = matched?.[1] ?? '--:--';
  const content = (matched?.[2] ?? entry).trim();
  const titled = /^([^：:\n/]{2,12})[：:]\s*([\s\S]+)$/.exec(content);
  // 摘要节点优先使用结构化里程碑标题；仅在缺失里程碑（旧状态）时才回退推断，
  // 且绝不用「过程记录 N」作为摘要标题。
  const inferredTitle = titled?.[1] ?? `过程记录 ${String(recordIndex + 1).padStart(2, '0')}`;
  const title = summaryEvent && summaryTitle ? summaryTitle : inferredTitle;
  const copy = titled?.[2] ?? content;
  const classes = [
    'timeline-item',
    summaryEvent ? 'timeline-summary-event' : 'timeline-detail-event',
    summaryLast ? 'timeline-summary-last' : '',
  ].filter(Boolean).join(' ');
  const connector = hasNext ? '<b></b>' : '';
  return `<li class="${classes}"><div class="timeline-time"><strong>${escapeHtml(time)}</strong><span>记录 ${String(recordIndex + 1).padStart(2, '0')}</span></div><div class="timeline-marker"><i></i>${connector}</div><div class="timeline-copy"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(copy).replace(/\n/g, '<br>')}</p></div></li>`;
}

/** 渲染默认摘要、可切全部的完整时间线；旧状态缺少索引时保守展示全部。 */
export function renderCodexAppProgressTimeline(
  state: CodexAppProgressCardSessionState,
  headingHtml: string,
): string {
  const history = splitProgressCardEntries(state.content);
  // 优先用结构化里程碑：语义标题 + 4–6 条选择（保留交付/失败/终态，折叠阶段噪音）。
  // 里程碑缺失（旧状态）时回退到既有的索引集合，仍展示全部或既登记的重点索引。
  const milestones = state.summaryMilestones
    ?.filter(milestone => milestone.index >= 0 && milestone.index < history.length);
  const selected = milestones && milestones.length > 0
    ? selectSummaryMilestones(milestones)
    : undefined;
  const titleByIndex = new Map(selected?.map(item => [item.index, item.title]));
  const validSummaryIndexes = selected
    ? selected.map(item => item.index)
    : state.summaryEntryIndexes === undefined
      ? history.map((_, index) => index)
      : state.summaryEntryIndexes.filter(index => index >= 0 && index < history.length);
  const summaryIndexes = new Set(validSummaryIndexes);
  const summaryLastIndex = validSummaryIndexes.length
    ? Math.min(...validSummaryIndexes)
    : undefined;
  const newestFirstHistory = history
    .map((entry, recordIndex) => ({ entry, recordIndex }))
    .reverse();
  const controls = [
    '<input class="timeline-mode-input" id="timeline-mode-summary" name="timeline-mode" type="radio" checked>',
    '<input class="timeline-mode-input" id="timeline-mode-all" name="timeline-mode" type="radio">',
    `<div class="timeline-heading-row">${headingHtml}<div class="timeline-toggle" role="group" aria-label="时间线展示范围"><label for="timeline-mode-summary">展示摘要 <span>${summaryIndexes.size}</span></label><label for="timeline-mode-all">展示所有 <span>${history.length}</span></label></div></div>`,
  ].join('');
  if (newestFirstHistory.length === 0) return `${controls}<p class="muted">暂无过程记录</p>`;
  const empty = summaryIndexes.size === 0
    ? '<p class="muted timeline-summary-empty">暂无重点事件，可切换“展示所有”查看完整过程。</p>'
    : '';
  const items = newestFirstHistory.map(({ entry, recordIndex }, index) => timelineItem(
    entry,
    recordIndex,
    index < newestFirstHistory.length - 1,
    summaryIndexes.has(recordIndex),
    recordIndex === summaryLastIndex,
    titleByIndex.get(recordIndex),
  )).join('');
  return `${controls}${empty}<ol class="timeline">${items}</ol>`;
}
