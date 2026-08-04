/**
 * 外部作业状态归类与终态文案的单元回归。
 * 关键契约：只消费结构化 status，词表未命中一律 unknown，绝不乐观当成功；
 * 终态文案严格区分「AI 本轮执行结束」与「外部任务终态」。
 */
import { describe, expect, it } from 'vitest';
import {
  classifyExternalJobStatus,
  computeExternalOutcome,
  externalJobLines,
  externalTerminalHeadline,
} from '../src/services/codex-app-progress-external.js';

describe('外部作业状态归类', () => {
  it('把常见状态词映射为确定态', () => {
    expect(classifyExternalJobStatus('running')).toBe('pending');
    expect(classifyExternalJobStatus('Upgrading')).toBe('pending');
    expect(classifyExternalJobStatus('queued')).toBe('pending');
    expect(classifyExternalJobStatus('Failed')).toBe('failed');
    expect(classifyExternalJobStatus('build error')).toBe('failed');
    expect(classifyExternalJobStatus('success')).toBe('success');
    expect(classifyExternalJobStatus('merged')).toBe('success');
  });

  it('词表未命中的状态归为 unknown，而不是猜成成功', () => {
    expect(classifyExternalJobStatus('曜曜曜')).toBe('unknown');
    expect(classifyExternalJobStatus('')).toBe('unknown');
    expect(classifyExternalJobStatus('42')).toBe('unknown');
  });

  it('整体结论按严重度聚合：失败 > 进行中 > 未确认 > 成功', () => {
    expect(computeExternalOutcome(undefined)).toBe('none');
    expect(computeExternalOutcome([])).toBe('unknown');
    expect(computeExternalOutcome([
      { label: 'MR', status: 'running' },
      { label: 'HAR', status: 'Failed' },
    ])).toBe('failed');
    expect(computeExternalOutcome([
      { label: 'MR', status: 'running' },
      { label: 'HAR', status: 'success' },
    ])).toBe('pending');
    expect(computeExternalOutcome([
      { label: 'MR', status: '未知词' },
      { label: 'HAR', status: 'success' },
    ])).toBe('unknown');
    expect(computeExternalOutcome([
      { label: 'MR', status: 'merged' },
      { label: 'HAR', status: 'success' },
    ])).toBe('success');
  });

  it('终态文案区分五种外部结论', () => {
    expect(externalTerminalHeadline('none')).toBe('AI 本轮执行已结束（未记录外部任务状态）。');
    expect(externalTerminalHeadline('success')).toBe('本轮已完成，外部任务均已成功。');
    expect(externalTerminalHeadline('failed')).toBe('AI 执行动作已结束，外部任务存在失败。');
    expect(externalTerminalHeadline('pending')).toBe('AI 执行动作已结束，外部任务仍在进行。');
    expect(externalTerminalHeadline('unknown')).toBe('AI 执行动作已结束，外部状态未确认。');
  });

  it('逐条明细拼成 label：status', () => {
    expect(externalJobLines([
      { label: 'MR 8293313', status: 'running' },
      { label: 'HAR 1.0.6-alpha.2 / job 816911007', status: 'Failed' },
    ])).toEqual([
      'MR 8293313：running',
      'HAR 1.0.6-alpha.2 / job 816911007：Failed',
    ]);
    expect(externalJobLines(undefined)).toEqual([]);
  });
});
