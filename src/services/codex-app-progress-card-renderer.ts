/**
 * Codex App 进度卡的纯渲染层。
 * 只负责把当前页或归档页投影为飞书卡片 JSON，不读写会话状态。
 */
import { buildCardBodyElements } from '../im/lark/md-card.js';
import type {
  CodexAppProgressCardPhase,
  CodexAppProgressCardSessionState,
} from '../types.js';
import {
  computeExternalOutcome,
  externalJobLines,
  externalTerminalHeadline,
} from './codex-app-progress-external.js';
import { splitProgressCardEntries } from './codex-app-progress-pagination.js';

export interface CodexAppProgressCardRenderOptions {
  content?: string;
  pageNumber?: number;
  archived?: boolean;
  nowMs?: number;
  reportUrl?: string;
}

const DEFAULT_RECENT_ENTRIES = 1;
const HISTORY_PAGE_SIZE = 6;
const PROGRESS_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function titlePrefix(phase: CodexAppProgressCardPhase): string {
  if (phase === 'running') return '处理中';
  if (phase === 'completed') return '已完成';
  if (phase === 'failed') return '处理失败';
  return '已中断';
}

function cardTemplate(phase: CodexAppProgressCardPhase): string {
  if (phase === 'running') return 'turquoise';
  if (phase === 'completed') return 'green';
  if (phase === 'failed') return 'red';
  return 'grey';
}

function markdown(content: string): Record<string, unknown> {
  return { tag: 'markdown', content };
}

function elapsedMinutes(startedAtMs: number | undefined, nowMs: number): number {
  if (!startedAtMs || nowMs <= startedAtMs) return 0;
  return Math.max(1, Math.floor((nowMs - startedAtMs) / 60_000));
}

function updatedText(updatedAtMs: number | undefined, nowMs: number): string {
  if (!updatedAtMs || nowMs <= updatedAtMs) return '刚刚更新';
  const minutes = Math.floor((nowMs - updatedAtMs) / 60_000);
  return minutes < 1 ? '刚刚更新' : `${minutes} 分钟前更新`;
}

function fullHistoryEntries(state: CodexAppProgressCardSessionState): string[] {
  const archived = (state.archivedPages ?? []).flatMap(page =>
    splitProgressCardEntries(page.content));
  return [...archived, ...splitProgressCardEntries(state.content)];
}

function overviewMarkdown(state: CodexAppProgressCardSessionState): string {
  const overview = state.overview;
  if (!overview) {
    return '**当前** 等待新的明确进展';
  }
  const externalDetail = externalJobLines(overview.external);
  return [
    `阶段 ${overview.stage}　·　进度 ${
      overview.total ? `${overview.completed.length}/${overview.total}` : `${overview.completed.length} 项`
    }`,
    `**当前** ${overview.current}`,
    `**下一步** ${overview.next}`,
    externalDetail.length > 0
      ? `**外部** ${summaryItems(externalDetail, '')}`
      : undefined,
    overview.blocker
      ? `**⚠️ 需要处理** ${overview.blocker}`
      : undefined,
  ].filter(Boolean).join('\n');
}

function summaryItems(items: string[], empty: string): string {
  if (items.length === 0) return empty;
  const visible = items.slice(0, 2).join('；');
  return items.length > 2 ? `${visible}；另 ${items.length - 2} 项` : visible;
}

function completionMarkdown(state: CodexAppProgressCardSessionState, nowMs: number): string {
  const overview = state.overview;
  const conclusion = overview?.current ?? titlePrefix(state.phase);
  const validation = overview?.evidence?.length
    ? overview.evidence
    : overview?.completed ?? [];
  const delivery = overview?.delivery ?? [];
  const risks = overview?.risks?.length
    ? overview.risks
    : overview?.blocker
      ? [overview.blocker]
      : [];
  const endedAtMs = state.updatedAtMs ?? nowMs;
  const endedLabel = state.phase === 'completed' ? '完成' : '结束';
  // 终态首行严格区分「AI 本轮执行结束」与「外部任务终态」；完成阶段依结构化状态改写。
  const externalOutcome = computeExternalOutcome(overview?.external);
  const headline = state.phase === 'completed'
    ? externalTerminalHeadline(externalOutcome)
    : state.phase === 'failed'
      ? '本轮处理失败。'
      : '本轮已中断。';
  const externalDetail = externalJobLines(overview?.external);
  return [
    `用时 ${elapsedMinutes(state.startedAtMs, endedAtMs)} 分钟`
      + `　·　${PROGRESS_TIME_FORMATTER.format(new Date(endedAtMs))} ${endedLabel}`,
    `**结论** ${headline}`,
    `**结果** ${conclusion}`,
    `**验证** ${summaryItems(validation, '未记录独立验证证据')}`,
    `**交付** ${summaryItems(delivery, '无外部交付')}`,
    externalDetail.length > 0 ? `**外部** ${summaryItems(externalDetail, '')}` : undefined,
    risks.length > 0 ? `**风险** ${summaryItems(risks, '')}` : undefined,
  ].filter(Boolean).join('\n');
}

/** 使用 JSON 2.0 的分栏和 behaviors 渲染回调按钮，避免旧 action 容器被飞书拒绝。 */
function viewActionColumns(
  state: CodexAppProgressCardSessionState,
  entryCount: number,
  reportUrl?: string,
): Record<string, unknown> | undefined {
  if (!state.sessionId || entryCount === 0) return undefined;
  const behavior = reportUrl
    ? {
        type: 'open_url',
        default_url: reportUrl,
        pc_url: reportUrl,
        android_url: reportUrl,
        ios_url: reportUrl,
      }
    : {
        type: 'callback',
        value: {
          action: 'codex_progress_history_open',
          session_id: state.sessionId,
          page: '1',
        },
      };
  const columns: Array<Record<string, unknown>> = [{
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: '查看完整过程' },
      type: 'default',
      behaviors: [behavior],
    }],
  }];
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns,
  };
}

/** 使用阶段看板渲染当前任务主卡；旧归档调用仍保持兼容。 */
export function renderCodexAppProgressCard(
  state: CodexAppProgressCardSessionState,
  options: CodexAppProgressCardRenderOptions = {},
): string {
  const pageNumber = options.pageNumber ?? state.pageNumber ?? 1;
  const title = options.archived
    ? `进度 ${pageNumber} · 已归档 · ${state.title}`
    : `${titlePrefix(state.phase)} · ${state.title}`;
  const nowMs = options.nowMs ?? Date.now();
  const history = options.content
    ? splitProgressCardEntries(options.content)
    : fullHistoryEntries(state);
  const recent = history.slice(-DEFAULT_RECENT_ENTRIES);
  const elements: Array<Record<string, unknown>> = [];
  if (options.archived) {
    elements.push(...buildCardBodyElements(options.content ?? state.content));
  } else {
    const summary = state.phase === 'running'
      ? [
          `⏱️ 已运行 ${elapsedMinutes(state.startedAtMs, nowMs)} 分钟`
            + `　·　🕘 ${updatedText(state.updatedAtMs, nowMs)}`,
          overviewMarkdown(state),
          recent.length > 0 ? `**最新** ${recent[0]}` : undefined,
        ].filter(Boolean).join('\n\n')
      : completionMarkdown(state, nowMs);
    elements.push(markdown(summary));
    const actions = viewActionColumns(state, history.length, options.reportUrl);
    if (actions) elements.push(actions);
  }
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: options.archived
        ? 'grey'
        : state.phase === 'running' && state.overview?.blocker
          ? 'orange'
          : cardTemplate(state.phase),
      title: {
        tag: 'plain_text',
        content: title,
      },
    },
    body: {
      direction: 'vertical',
      elements,
    },
  });
}

/** 构造按需发送的飞书分页历史卡；每页固定六条完整证据。 */
export function renderCodexAppProgressHistoryCard(
  state: CodexAppProgressCardSessionState,
  requestedPage = 1,
): string {
  const history = fullHistoryEntries(state);
  const totalPages = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE));
  const page = Math.min(totalPages, Math.max(1, Math.trunc(requestedPage) || 1));
  const start = (page - 1) * HISTORY_PAGE_SIZE;
  const elements: Array<Record<string, unknown>> = [
    markdown(history.slice(start, start + HISTORY_PAGE_SIZE).join('\n\n') || '暂无历史记录'),
  ];
  if (state.sessionId && totalPages > 1) {
    const columns: Array<Record<string, unknown>> = [];
    if (page > 1) {
      columns.push({
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '上一页' },
          type: 'default',
          behaviors: [{
            type: 'callback',
            value: {
              action: 'codex_progress_history_page',
              session_id: state.sessionId,
              page: String(page - 1),
            },
          }],
        }],
      });
    }
    if (page < totalPages) {
      columns.push({
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '下一页' },
          type: 'primary',
          behaviors: [{
            type: 'callback',
            value: {
              action: 'codex_progress_history_page',
              session_id: state.sessionId,
              page: String(page + 1),
            },
          }],
        }],
      });
    }
    elements.push({
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_spacing: '8px',
      columns,
    });
  }
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: 'grey',
      title: {
        tag: 'plain_text',
        content: `进度历史 ${page}/${totalPages} · ${state.title}`,
      },
    },
    body: { direction: 'vertical', elements },
  });
}
