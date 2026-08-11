/** Codex App 可对外同步的一条 assistant 进展。 */
export interface CodexAppProgressSnapshot {
  turnId?: string;
  content: string;
  startedAtMs: number;
  updatedAtMs: number;
}

export interface CodexAppProgressInput {
  turnId?: string;
  text: string;
  startedAtMs: number;
  nowMs: number;
}

export interface CodexAppProgressOptions {
  minIntervalMs?: number;
  maxSnapshotsPerDrain?: number;
}

function normalizeProgressText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function isSentenceEnd(text: string, index: number): boolean {
  const current = text[index];
  if ('。！？!?…'.includes(current)) return true;
  if (current !== '.') return false;
  const previous = text[index - 1];
  const next = text[index + 1];
  if (previous && /\d/.test(previous) && next === undefined) return false;
  return next === undefined || /\s/.test(next);
}

function nextCompleteSentence(text: string): { content: string; consumed: number } | undefined {
  const leadingWhitespace = text.match(/^\s*/)?.[0].length ?? 0;
  const markerStart = '<!--botmux-progress:';
  const remaining = text.slice(leadingWhitespace);
  // 流式 delta 可能暂时只到达 `<!`；必须等待前缀完整，不能把其中的 `!` 当成句末。
  if (markerStart.startsWith(remaining)) return undefined;
  if (remaining.startsWith(markerStart)) {
    const markerEnd = text.indexOf('-->', leadingWhitespace + markerStart.length);
    if (markerEnd >= 0) {
      const consumed = markerEnd + 3;
      return {
        content: text.slice(leadingWhitespace, consumed),
        consumed,
      };
    }
    return undefined;
  }
  for (let index = 0; index < text.length; index++) {
    if (!isSentenceEnd(text, index)) continue;
    let end = index + 1;
    while (end < text.length && /[…”’」』）】》]/.test(text[end])) end++;
    const content = text.slice(0, end).replace(/\n{2,}/g, '\n').trim();
    return content ? { content, consumed: end } : undefined;
  }
  return undefined;
}

/**
 * 从累计的 commentary 文本中只提取完整的新句子。
 * resetTo 用于 steer：既有文本成为新基线，不会在补充要求后重复发送。
 */
export class CodexAppProgressThrottler {
  private emittedUntil = 0;
  private emittedPrefix = '';
  private lastSentAtMs = 0;
  private readonly minIntervalMs: number;
  private readonly maxSnapshotsPerDrain: number;

  constructor(options: CodexAppProgressOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 1_000;
    this.maxSnapshotsPerDrain = options.maxSnapshotsPerDrain ?? 8;
  }

  resetTo(text = ''): void {
    const normalized = normalizeProgressText(text);
    this.emittedUntil = normalized.length;
    this.emittedPrefix = normalized;
    this.lastSentAtMs = 0;
  }

  drainSnapshots(input: CodexAppProgressInput): CodexAppProgressSnapshot[] {
    const normalized = normalizeProgressText(input.text);
    if (
      this.emittedUntil > normalized.length
      || (this.emittedPrefix && !normalized.startsWith(this.emittedPrefix))
    ) {
      this.resetTo();
    }
    if (
      this.lastSentAtMs > 0
      && input.nowMs - this.lastSentAtMs < this.minIntervalMs
    ) return [];

    const snapshots: CodexAppProgressSnapshot[] = [];
    while (snapshots.length < this.maxSnapshotsPerDrain) {
      const sentence = nextCompleteSentence(normalized.slice(this.emittedUntil));
      if (!sentence) break;
      this.emittedUntil += sentence.consumed;
      this.emittedPrefix = normalized.slice(0, this.emittedUntil);
      snapshots.push({
        turnId: input.turnId,
        content: sentence.content,
        startedAtMs: input.startedAtMs,
        updatedAtMs: input.nowMs,
      });
    }
    if (snapshots.length > 0) this.lastSentAtMs = input.nowMs;
    return snapshots;
  }
}

function titleWidth(value: string): number {
  let width = 0;
  for (const character of Array.from(value)) {
    width += /\p{Script=Han}/u.test(character) ? 1 : 0.5;
  }
  return width;
}

/** 从真实用户输入生成稳定、无附件占位的状态卡摘要。 */
export function codexAppProgressCardTitle(question: string | undefined, maxWidth = 25): string {
  const normalized = (question ?? '')
    .replace(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/i, '$1')
    .replace(/\\([\[\]])/g, '$1')
    .replace(/\[(?:图片|文件)\s*\d+\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '当前任务';
  if (titleWidth(normalized) <= maxWidth) return normalized;

  const contentLimit = Math.max(1, maxWidth - 1);
  let width = 0;
  const kept: string[] = [];
  for (const character of Array.from(normalized)) {
    const next = /\p{Script=Han}/u.test(character) ? 1 : 0.5;
    if (width + next > contentLimit) break;
    kept.push(character);
    width += next;
  }
  return `${kept.join('')}…`;
}
