/**
 * Codex App 结构化进度标记解析。
 *
 * AI 在普通 commentary 末尾附带 HTML 注释标记；本模块验证字段并从用户可见
 * 时间线中移除标记。非法标记只按普通文本剥离，不得污染持久化看板。
 */
import type {
  CodexAppProgressExternalJob,
  CodexAppProgressOverview,
} from '../types.js';

export interface ParsedCodexAppProgress {
  content: string;
  title?: string;
  overview?: CodexAppProgressOverview;
}

const PROGRESS_MARKER = /<!--botmux-progress:([\s\S]*?)-->/g;
const MAX_TITLE_CHARS = 40;
const MAX_FIELD_CHARS = 240;
const MAX_STATUS_CHARS = 40;
const MAX_LIST_ITEMS = 12;
const MAX_TOTAL_ITEMS = 999;

function boundedString(value: unknown, max = MAX_FIELD_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return undefined;
  return trimmed;
}

function boundedList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return undefined;
  const items: string[] = [];
  for (const item of value) {
    const normalized = boundedString(item);
    if (!normalized) return undefined;
    items.push(normalized);
  }
  return items;
}

/** 校验外部作业列表；每项必须同时给出可读标识和结构化状态，缺一即整体拒绝。 */
function boundedExternalList(
  value: unknown,
): CodexAppProgressExternalJob[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return undefined;
  const items: CodexAppProgressExternalJob[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const record = entry as Record<string, unknown>;
    const label = boundedString(record.label);
    const status = boundedString(record.status, MAX_STATUS_CHARS);
    if (!label || !status) return undefined;
    items.push({ label, status });
  }
  return items;
}

/** 校验一份 AI 进度对象；核心阶段字段必须同时存在，避免半结构状态。 */
function parseOverview(value: unknown): {
  title?: string;
  overview: CodexAppProgressOverview;
} | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const stage = boundedString(input.stage, 40);
  const current = boundedString(input.current);
  const next = boundedString(input.next);
  const completed = boundedList(input.completed);
  if (!stage || !current || !next || !completed) return undefined;
  const total = input.total === undefined
    ? undefined
    : typeof input.total === 'number'
      && Number.isInteger(input.total)
      && input.total > 0
      && input.total >= completed.length
      && input.total <= MAX_TOTAL_ITEMS
      ? input.total
      : undefined;
  if (input.total !== undefined && total === undefined) return undefined;
  const blocker = input.blocker === null || input.blocker === undefined
    ? undefined
    : boundedString(input.blocker);
  if (input.blocker !== null && input.blocker !== undefined && !blocker) return undefined;
  const evidence = input.evidence === undefined ? undefined : boundedList(input.evidence);
  const delivery = input.delivery === undefined ? undefined : boundedList(input.delivery);
  const risks = input.risks === undefined ? undefined : boundedList(input.risks);
  const external = input.external === undefined ? undefined : boundedExternalList(input.external);
  if (
    (input.evidence !== undefined && !evidence)
    || (input.delivery !== undefined && !delivery)
    || (input.risks !== undefined && !risks)
    || (input.external !== undefined && !external)
  ) return undefined;
  return {
    ...(boundedString(input.title, MAX_TITLE_CHARS)
      ? { title: boundedString(input.title, MAX_TITLE_CHARS) }
      : {}),
    overview: {
      stage,
      current,
      completed,
      ...(total !== undefined ? { total } : {}),
      next,
      ...(blocker ? { blocker } : {}),
      ...(evidence ? { evidence } : {}),
      ...(delivery ? { delivery } : {}),
      ...(risks ? { risks } : {}),
      ...(external ? { external } : {}),
    },
  };
}

/** 提取最后一个合法标记；正文始终移除所有进度标记。 */
export function parseCodexAppProgress(content: string): ParsedCodexAppProgress {
  let parsed: ReturnType<typeof parseOverview>;
  for (const match of content.matchAll(PROGRESS_MARKER)) {
    try {
      const candidate = parseOverview(JSON.parse(match[1] ?? ''));
      if (candidate) parsed = candidate;
    } catch {
      // 非法 JSON 不得中断普通进度投影。
    }
  }
  const clean = content.replace(PROGRESS_MARKER, '').trim();
  return {
    content: clean,
    ...(parsed?.title ? { title: parsed.title } : {}),
    ...(parsed?.overview ? { overview: parsed.overview } : {}),
  };
}
