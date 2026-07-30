import { describe, expect, it } from 'vitest';
import {
  CodexAppProgressThrottler,
  codexAppProgressCardTitle,
} from '../src/services/codex-app-progress.js';

describe('Codex App 真实进展提取', () => {
  it('只发送完整句子并保持增量', () => {
    const progress = new CodexAppProgressThrottler({ minIntervalMs: 0 });
    expect(progress.drainSnapshots({
      turnId: 'om_1',
      text: '正在检查',
      startedAtMs: 1,
      nowMs: 2,
    })).toEqual([]);
    expect(progress.drainSnapshots({
      turnId: 'om_1',
      text: '正在检查配置。接下来核对代码。',
      startedAtMs: 1,
      nowMs: 3,
    }).map(item => item.content)).toEqual([
      '正在检查配置。',
      '接下来核对代码。',
    ]);
    expect(progress.drainSnapshots({
      turnId: 'om_1',
      text: '正在检查配置。接下来核对代码。',
      startedAtMs: 1,
      nowMs: 4,
    })).toEqual([]);
  });

  it('steer 后从新基线继续，不重复旧进展', () => {
    const progress = new CodexAppProgressThrottler({ minIntervalMs: 0 });
    progress.drainSnapshots({
      turnId: 'om_1',
      text: '旧进展已经完成。',
      startedAtMs: 1,
      nowMs: 2,
    });
    progress.resetTo('旧进展已经完成。');
    expect(progress.drainSnapshots({
      turnId: 'om_2',
      text: '旧进展已经完成。补充要求已经纳入。',
      startedAtMs: 1,
      nowMs: 3,
    }).map(item => item.content)).toEqual(['补充要求已经纳入。']);
  });

  it('不会把临时版本号小数点当成句号', () => {
    const progress = new CodexAppProgressThrottler({ minIntervalMs: 0 });
    expect(progress.drainSnapshots({
      text: '当前版本是 3.',
      startedAtMs: 1,
      nowMs: 2,
    })).toEqual([]);
    expect(progress.drainSnapshots({
      text: '当前版本是 3.6.0，已经核验。',
      startedAtMs: 1,
      nowMs: 3,
    }).map(item => item.content)).toEqual(['当前版本是 3.6.0，已经核验。']);
  });

  it('完整结构化进度标记无需额外句号也会作为独立增量发送', () => {
    const progress = new CodexAppProgressThrottler({ minIntervalMs: 0 });
    const marker = '<!--botmux-progress:'
      + '{"stage":"验证","current":"运行回归","completed":[],"next":"构建"}'
      + '-->';
    expect(progress.drainSnapshots({
      turnId: 'om_1',
      text: `代码已经修改。${marker}`,
      startedAtMs: 1,
      nowMs: 2,
    }).map(item => item.content)).toEqual([
      '代码已经修改。',
      marker,
    ]);
  });

  it('标题移除附件占位并按中文视觉宽度截断', () => {
    expect(codexAppProgressCardTitle('[图片 1] 帮我检查 botmux 部署')).toBe('帮我检查 botmux 部署');
    expect(codexAppProgressCardTitle('这是一段需要被截断的很长很长很长很长的用户问题', 10))
      .toBe('这是一段需要被截断…');
  });
});
