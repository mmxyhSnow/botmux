/**
 * Codex App 进度卡的纯渲染层。
 * 只负责把当前页或归档页投影为飞书卡片 JSON，不读写会话状态。
 */
import { buildCardBodyElements } from '../im/lark/md-card.js';
import type {
  CodexAppProgressCardPhase,
  CodexAppProgressCardSessionState,
} from '../types.js';
import { splitProgressCardEntries } from './codex-app-progress-pagination.js';

export interface CodexAppProgressCardRenderOptions {
  content?: string;
  pageNumber?: number;
  archived?: boolean;
  nowMs?: number;
}

const DEFAULT_RECENT_ENTRIES = 3;
const EXPANDED_RECENT_ENTRIES = 8;
const HISTORY_PAGE_SIZE = 6;

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
    return '**当前阶段**\n正在处理\n\n**正在处理**\n等待新的明确进展';
  }
  const completed = overview.completed.length > 0
    ? overview.completed.map(item => `- ✅ ${item}`).join('\n')
    : '- 暂无';
  return [
    `**当前阶段**\n${overview.stage}`,
    `**正在处理**\n${overview.current}`,
    `**已完成**\n${completed}`,
    `**下一步**\n${overview.next}`,
    overview.blocker
      ? `**需要你处理**\n⚠️ ${overview.blocker}`
      : '**阻塞状态**\n✅ 暂无真实阻塞',
  ].join('\n\n');
}

function completionMarkdown(state: CodexAppProgressCardSessionState): string {
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
  const lines = (items: string[], empty: string) =>
    items.length > 0 ? items.map(item => `- ${item}`).join('\n') : `- ${empty}`;
  return [
    '**验收摘要**',
    `**最终结论**\n${conclusion}`,
    `**关键验证**\n${lines(validation, '未记录独立验证证据')}`,
    `**提交与部署**\n${lines(delivery, '无外部交付')}`,
    `**剩余风险**\n${lines(risks, '无已知剩余风险')}`,
  ].join('\n\n');
}

/** 使用 JSON 2.0 的分栏和 behaviors 渲染回调按钮，避免旧 action 容器被飞书拒绝。 */
function viewActionColumns(
  state: CodexAppProgressCardSessionState,
  entryCount: number,
): Record<string, unknown> | undefined {
  if (!state.sessionId || entryCount === 0) return undefined;
  const columns: Array<Record<string, unknown>> = [];
  if (entryCount > DEFAULT_RECENT_ENTRIES) {
    columns.push({
      tag: 'column',
      width: 'auto',
      elements: [{
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: state.detailsExpanded ? '收起进展' : '展开更多',
        },
        type: 'default',
        behaviors: [{
          type: 'callback',
          value: {
            action: 'codex_progress_toggle_details',
            session_id: state.sessionId,
            expanded: state.detailsExpanded ? '0' : '1',
          },
        }],
      }],
    });
  }
  columns.push({
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: '查看完整历史' },
      type: 'default',
      behaviors: [{
        type: 'callback',
        value: {
          action: 'codex_progress_history_open',
          session_id: state.sessionId,
          page: '1',
        },
      }],
    }],
  });
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
  const recentLimit = state.detailsExpanded
    ? EXPANDED_RECENT_ENTRIES
    : DEFAULT_RECENT_ENTRIES;
  const recent = history.slice(-recentLimit);
  const elements: Array<Record<string, unknown>> = [];
  if (options.archived) {
    elements.push(...buildCardBodyElements(options.content ?? state.content));
  } else {
    elements.push(markdown(
      `⏱️ 已运行 ${elapsedMinutes(state.startedAtMs, nowMs)} 分钟`
      + `　·　🕘 ${updatedText(state.updatedAtMs, nowMs)}`,
    ));
    elements.push({ tag: 'hr' });
    elements.push(markdown(
      state.phase === 'running' ? overviewMarkdown(state) : completionMarkdown(state),
    ));
    if (recent.length > 0) {
      elements.push({ tag: 'hr' });
      elements.push(markdown(
        `**最近进展${state.detailsExpanded ? '（已展开）' : ''}**\n`
        + recent.join('\n\n'),
      ));
    }
    const actions = viewActionColumns(state, history.length);
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
