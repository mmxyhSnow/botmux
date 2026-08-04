/**
 * botmux-progress 结构化标记里 external 字段的解析与校验回归。
 * 契约：external 必须是 {label,status} 的数组；任一项缺字段或超界则整段标记作废，
 * 不得污染看板，也不得把非法输入当成外部成功。
 */
import { describe, expect, it } from 'vitest';
import { parseCodexAppProgress } from '../src/services/codex-app-progress-structure.js';

function marker(overview: Record<string, unknown>): string {
  return `进展。<!--botmux-progress:${JSON.stringify(overview)}-->`;
}

describe('botmux-progress external 字段解析', () => {
  it('解析合法 external 并从正文剥离标记', () => {
    const parsed = parseCodexAppProgress(marker({
      stage: '触发 HAR', current: 'HAR 已触发', completed: [], next: '等待终态',
      external: [
        { label: 'MR 8293313', status: 'running' },
        { label: 'HAR 1.0.6-alpha.2 / job 816911007', status: 'Failed' },
      ],
    }));
    expect(parsed.content).toBe('进展。');
    expect(parsed.overview?.external).toEqual([
      { label: 'MR 8293313', status: 'running' },
      { label: 'HAR 1.0.6-alpha.2 / job 816911007', status: 'Failed' },
    ]);
  });

  it('缺少 label 或 status 的 external 使整段标记作废', () => {
    const missingStatus = parseCodexAppProgress(marker({
      stage: 'A', current: 'x', completed: [], next: 'y',
      external: [{ label: 'MR 8293313' }],
    }));
    expect(missingStatus.overview).toBeUndefined();

    const missingLabel = parseCodexAppProgress(marker({
      stage: 'A', current: 'x', completed: [], next: 'y',
      external: [{ status: 'running' }],
    }));
    expect(missingLabel.overview).toBeUndefined();
  });

  it('external 非数组或元素非对象时作废', () => {
    expect(parseCodexAppProgress(marker({
      stage: 'A', current: 'x', completed: [], next: 'y',
      external: 'running',
    })).overview).toBeUndefined();
    expect(parseCodexAppProgress(marker({
      stage: 'A', current: 'x', completed: [], next: 'y',
      external: ['MR 8293313'],
    })).overview).toBeUndefined();
  });

  it('缺省 external 时仍解析出 overview，向后兼容旧标记', () => {
    const parsed = parseCodexAppProgress(marker({
      stage: '完成', current: '修复已应用', completed: ['应用修复'], next: '无',
    }));
    expect(parsed.overview).toBeDefined();
    expect(parsed.overview?.external).toBeUndefined();
  });
});
