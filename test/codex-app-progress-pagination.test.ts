import { describe, expect, it } from 'vitest';
import {
  countProgressCardEntries,
  shouldStartProgressCardPage,
} from '../src/services/codex-app-progress-pagination.js';

describe('Codex App 进度卡分页', () => {
  it('第九个内容块开始新页', () => {
    expect(shouldStartProgressCardPage({
      currentContent: Array(8).fill('[19:00:00] 进展。').join('\n\n'),
      currentEntryCount: 8,
      nextEntry: '[19:01:00] 下一条。',
    })).toBe(true);
  });

  it('新增内容导致页面超过 1800 字时开始新页', () => {
    expect(shouldStartProgressCardPage({
      currentContent: `[19:00:00] ${'长'.repeat(1780)}`,
      currentEntryCount: 1,
      nextEntry: '[19:01:00] 下一条。',
    })).toBe(true);
  });

  it('单个超长内容在空页中保持完整', () => {
    expect(shouldStartProgressCardPage({
      currentContent: '',
      currentEntryCount: 0,
      nextEntry: `[19:00:00] ${'长'.repeat(2000)}`,
    })).toBe(false);
  });

  it('未达到任一阈值时留在当前页', () => {
    expect(shouldStartProgressCardPage({
      currentContent: '[19:00:00] 开始。',
      currentEntryCount: 1,
      nextEntry: '[19:01:00] 继续。',
    })).toBe(false);
  });

  it('只把带时间戳的新内容边界计为新内容块', () => {
    expect(countProgressCardEntries(
      '[19:00:00] 第一段。\n\n同一条进展的补充。\n\n[19:01:00] 第二段。',
    )).toBe(2);
    expect(countProgressCardEntries('旧版无时间戳内容。')).toBe(1);
    expect(countProgressCardEntries('')).toBe(0);
  });
});
