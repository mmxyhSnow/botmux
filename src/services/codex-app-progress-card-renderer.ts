/**
 * Codex App 进度卡的纯渲染层。
 * 只负责把当前页或归档页投影为飞书卡片 JSON，不读写会话状态。
 */
import { buildCardBodyElements } from '../im/lark/md-card.js';
import type {
  CodexAppProgressCardPhase,
  CodexAppProgressCardSessionState,
} from '../types.js';

export interface CodexAppProgressCardRenderOptions {
  content?: string;
  pageNumber?: number;
  archived?: boolean;
}

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

/** 使用官方 markdown 渲染链生成当前页或归档页的飞书卡片。 */
export function renderCodexAppProgressCard(
  state: CodexAppProgressCardSessionState,
  options: CodexAppProgressCardRenderOptions = {},
): string {
  const pageNumber = options.pageNumber ?? state.pageNumber ?? 1;
  const title = options.archived
    ? `进度 ${pageNumber} · 已归档 · ${state.title}`
    : `${titlePrefix(state.phase)} · ${state.title}（进度 ${pageNumber}）`;
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: options.archived ? 'grey' : cardTemplate(state.phase),
      title: {
        tag: 'plain_text',
        content: title,
      },
    },
    body: {
      direction: 'vertical',
      elements: buildCardBodyElements(options.content ?? state.content),
    },
  });
}
