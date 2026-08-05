/**
 * Codex App 完整过程页的时间线筛选与静态 HTML 渲染。
 * 使用原生单选框和 CSS 切换摘要/全部，页面不执行脚本。
 */
import type {
  CodexAppProgressCardSessionState,
  CodexAppProgressSemanticSummaryItem,
} from '../types.js';
import { selectSummaryMilestones } from './codex-app-progress-milestones.js';
import { splitProgressCardEntries } from './codex-app-progress-pagination.js';

export const PROGRESS_REPORT_TIMELINE_STYLE = [
  '.timeline-mode-input{position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none}',
  '.timeline-heading-row{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:34px}.timeline-heading-row>.section-heading{margin-bottom:0}',
  '.timeline-toggle{display:flex;flex:0 0 auto;padding:3px;border:1px solid var(--border);background:var(--surface)}.timeline-toggle label{padding:6px 10px;color:#737784;font-size:10px;font-weight:750;line-height:1.2;cursor:pointer;white-space:nowrap}.timeline-toggle label span{margin-left:3px;font:700 9px/1 ui-monospace,SFMono-Regular,Consolas,monospace}',
  '#timeline-mode-summary:checked~.timeline-heading-row label[for="timeline-mode-summary"],#timeline-mode-all:checked~.timeline-heading-row label[for="timeline-mode-all"]{background:var(--ink);color:#fff}',
  '#timeline-mode-summary:focus-visible~.timeline-heading-row label[for="timeline-mode-summary"],#timeline-mode-all:focus-visible~.timeline-heading-row label[for="timeline-mode-all"]{outline:2px solid var(--accent);outline-offset:2px}',
  '#timeline-mode-summary:checked~.timeline-complete{display:none}#timeline-mode-all:checked~.timeline-semantic{display:none}',
  '#timeline-mode-all:checked~.timeline-summary-status,#timeline-mode-all:checked~.timeline-summary-empty{display:none}',
  '.timeline-summary-status{margin:-20px 0 24px;color:#858a9a;font-size:10px}.timeline-summary-status strong{color:var(--ink)}',
  '.timeline-summary-empty{margin:-20px 0 24px}',
  '.timeline{margin:0;padding:0;list-style:none}.timeline li{display:grid;grid-template-columns:74px 32px minmax(0,1fr);min-height:104px}.timeline-time{display:flex;align-items:flex-end;flex-direction:column;padding-top:1px}.timeline-time strong{font:750 14px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace}.timeline-time span{margin-top:4px;color:#858a9a;font-size:9px;font-weight:700}.timeline-marker{display:flex;align-items:center;flex-direction:column;padding-top:5px}.timeline-marker i{z-index:1;width:8px;height:8px;border:2px solid var(--accent);border-radius:50%;background:var(--paper)}.timeline-marker b{width:1px;flex:1;background:var(--border)}.timeline-copy{padding:0 0 28px 12px}.timeline-copy h3{margin:0 0 5px;font-size:15px;line-height:1.35}.timeline-copy p{margin:0;color:var(--muted);font-size:12px;line-height:1.65}',
  '@media(max-width:440px){.timeline-heading-row{align-items:stretch;flex-direction:column}.timeline-toggle{align-self:flex-start}.timeline li{grid-template-columns:56px 20px minmax(0,1fr)}.timeline-copy{padding-left:9px}}',
  '@media print{.timeline-mode-input,.timeline-toggle,.timeline-summary-empty,.timeline-summary-status,.timeline-semantic{display:none!important}.timeline-complete{display:block!important}}',
].join('');

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 从综合事件引用的最后一条原始记录提取代表时间，正文始终使用模型新生成的结论。 */
function semanticTimelineItem(
  item: CodexAppProgressSemanticSummaryItem,
  summaryIndex: number,
  history: string[],
  hasNext: boolean,
): string {
  const validIndexes = item.sourceEntryIndexes
    .filter(index => index >= 0 && index < history.length);
  const representativeIndex = validIndexes.length ? Math.max(...validIndexes) : undefined;
  const representative = representativeIndex === undefined ? '' : history[representativeIndex];
  const matched = /^\[(\d{2}:\d{2}):\d{2}\]\s*/.exec(representative);
  const connector = hasNext ? '<b></b>' : '';
  const covered = validIndexes.length > 0 ? ` · 覆盖 ${validIndexes.length} 条` : '';
  return `<li class="timeline-item timeline-semantic-event"><div class="timeline-time"><strong>${matched?.[1] ?? '--:--'}</strong><span>综合 ${String(summaryIndex + 1).padStart(2, '0')}${covered}</span></div><div class="timeline-marker"><i></i>${connector}</div><div class="timeline-copy"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.summary).replace(/\n/g, '<br>')}</p></div></li>`;
}

/** 渲染语义摘要的新鲜度；刷新和失败都保留最近一次成功内容。 */
function semanticSummaryStatus(state: CodexAppProgressCardSessionState, historyCount: number): string {
  const summary = state.semanticSummary;
  if (!summary) return '';
  const coverage = summary.items.length
    ? `当前结果覆盖 ${summary.sourceEntryCount}/${historyCount} 条完整记录。`
    : '';
  if (summary.status === 'updating') {
    return `<p class="timeline-summary-status"><strong>正在更新语义摘要。</strong>${coverage}</p>`;
  }
  if (summary.status === 'failed') {
    return `<p class="timeline-summary-status"><strong>本次更新失败，继续展示上次结果。</strong>${coverage}</p>`;
  }
  return `<p class="timeline-summary-status">语义摘要已覆盖 ${summary.sourceEntryCount}/${historyCount} 条完整记录。</p>`;
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
  const semanticItems = state.semanticSummary?.items;
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
  const summaryCount = semanticItems ? semanticItems.length : summaryIndexes.size;
  const controls = [
    '<input class="timeline-mode-input" id="timeline-mode-summary" name="timeline-mode" type="radio" checked>',
    '<input class="timeline-mode-input" id="timeline-mode-all" name="timeline-mode" type="radio">',
    `<div class="timeline-heading-row">${headingHtml}<div class="timeline-toggle" role="group" aria-label="时间线展示范围"><label for="timeline-mode-summary">展示摘要 <span>${summaryCount}</span></label><label for="timeline-mode-all">展示所有 <span>${history.length}</span></label></div></div>`,
  ].join('');
  if (newestFirstHistory.length === 0) return `${controls}<p class="muted">暂无过程记录</p>`;
  const semanticEmpty = state.semanticSummary && semanticItems?.length === 0
    ? `<p class="muted timeline-summary-empty">${state.semanticSummary.status === 'failed'
      ? '首次语义摘要生成失败，请切换“展示所有”查看完整过程。'
      : '正在生成首次语义摘要，可先切换“展示所有”查看完整过程。'}</p>`
    : '';
  const legacyEmpty = !state.semanticSummary && summaryIndexes.size === 0
    ? '<p class="muted timeline-summary-empty">暂无重点事件，可切换“展示所有”查看完整过程。</p>'
    : '';
  const completeItems = newestFirstHistory.map(({ entry, recordIndex }, index) => timelineItem(
    entry,
    recordIndex,
    index < newestFirstHistory.length - 1,
    false,
    false,
    undefined,
  )).join('');
  const semanticTimeline = semanticItems
    ? [...semanticItems].reverse().map((item, index, reversed) => semanticTimelineItem(
        item,
        semanticItems.length - index - 1,
        history,
        index < reversed.length - 1,
      )).join('')
    : newestFirstHistory.filter(({ recordIndex }) => summaryIndexes.has(recordIndex))
      .map(({ entry, recordIndex }, index, selectedHistory) => timelineItem(
        entry,
        recordIndex,
        index < selectedHistory.length - 1,
        true,
        recordIndex === summaryLastIndex,
        titleByIndex.get(recordIndex),
      )).join('');
  return `${controls}${semanticSummaryStatus(state, history.length)}${semanticEmpty}${legacyEmpty}<ol class="timeline timeline-semantic">${semanticTimeline}</ol><ol class="timeline timeline-complete">${completeItems}</ol>`;
}
