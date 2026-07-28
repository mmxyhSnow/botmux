/** 单张进度卡允许展示的最多内容块数量。 */
export const PROGRESS_CARD_PAGE_MAX_ENTRIES = 8;

/** 单张进度卡允许展示的最多字符数量。 */
export const PROGRESS_CARD_PAGE_MAX_CHARS = 1800;

export interface ProgressCardPageBoundaryInput {
  currentContent: string;
  currentEntryCount: number;
  nextEntry: string;
}

const TIMESTAMPED_ENTRY_BOUNDARY = /\n\n(?=\[\d{2}:\d{2}:\d{2}\]\s)/;

/** 从持久化文本恢复内容块数量，兼容没有时间戳的旧单页状态。 */
export function countProgressCardEntries(content: string): number {
  const normalized = content.trim();
  return normalized ? normalized.split(TIMESTAMPED_ENTRY_BOUNDARY).length : 0;
}

/**
 * 判断下一条完整内容是否应进入新页。
 * 空页始终接收整条内容，确保超长单条不会被截断或反复换页。
 */
export function shouldStartProgressCardPage(input: ProgressCardPageBoundaryInput): boolean {
  if (!input.currentContent) return false;
  if (input.currentEntryCount >= PROGRESS_CARD_PAGE_MAX_ENTRIES) return true;
  return `${input.currentContent}\n\n${input.nextEntry}`.length > PROGRESS_CARD_PAGE_MAX_CHARS;
}
