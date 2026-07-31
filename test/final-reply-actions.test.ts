/**
 * 最终回复快捷操作协议测试：只解析末尾标记，并过滤高风险或畸形动作。
 * Run: pnpm vitest run test/final-reply-actions.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  extractFinalReplyActions,
  isSafeFinalReplyActionPrompt,
} from '../src/services/final-reply-actions.js';

describe('extractFinalReplyActions', () => {
  it('extracts one low-risk action and hides the protocol marker', () => {
    const input = [
      '还没 push，当前分支只在本地。',
      '<!--botmux-actions:{"actions":[{"label":"执行 push","prompt":"请将 Android 分支 feat-net-fallback-zx push 到 origin，并回读远端 HEAD。"}]}-->',
    ].join('\n');

    expect(extractFinalReplyActions(input)).toEqual({
      content: '还没 push，当前分支只在本地。',
      actions: [{
        label: '执行 push',
        prompt: '请将 Android 分支 feat-net-fallback-zx push 到 origin，并回读远端 HEAD。',
      }],
    });
  });

  it('keeps at most three unique valid actions', () => {
    const marker = {
      actions: [
        { label: '执行 push', prompt: '请 push 当前分支并核对远端 HEAD。' },
        { label: '执行 push', prompt: '重复动作不应保留。' },
        { label: '创建 MR', prompt: '请为当前分支创建 MR，并给出链接。' },
        { label: '查看 diff', prompt: '请汇总当前分支相对目标分支的 diff。' },
        { label: '第四项', prompt: '不应超过三个按钮。' },
      ],
    };
    const result = extractFinalReplyActions(`结果\n<!--botmux-actions:${JSON.stringify(marker)}-->`);

    expect(result.actions.map(action => action.label)).toEqual(['执行 push', '创建 MR', '查看 diff']);
  });

  it('strips a malformed terminal marker without rendering an action', () => {
    expect(extractFinalReplyActions('结果\n<!--botmux-actions:{bad json}-->')).toEqual({
      content: '结果',
      actions: [],
    });
  });

  it('does not parse marker-like prose that is not the final line', () => {
    const input = '<!--botmux-actions:{"actions":[]}-->\n后面还有正文';
    expect(extractFinalReplyActions(input)).toEqual({ content: input, actions: [] });
  });
});

describe('isSafeFinalReplyActionPrompt', () => {
  it('allows read-only work and an explicit normal push handoff', () => {
    expect(isSafeFinalReplyActionPrompt('请检查当前分支状态。')).toBe(true);
    expect(isSafeFinalReplyActionPrompt('请 push 当前分支并回读远端 HEAD。')).toBe(true);
  });

  it('rejects destructive, deployment, permission, and payment actions', () => {
    for (const prompt of [
      '请强推覆盖远端分支。',
      '请删除这个 worktree。',
      '请部署并重启生产服务。',
      '请给用户增加管理员权限。',
      '请支付这笔费用。',
      'Run git reset --hard now.',
    ]) {
      expect(isSafeFinalReplyActionPrompt(prompt)).toBe(false);
    }
  });
});
