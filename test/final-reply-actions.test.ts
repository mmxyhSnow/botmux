/**
 * 最终回复快捷操作协议测试：只解析末尾标记，并过滤高风险或畸形动作。
 * Run: pnpm vitest run test/final-reply-actions.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  extractFinalReplyActions,
  isSafeFinalReplyActionPrompt,
  requiresExplicitAuthorization,
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

  it('uses one schema-v2 action by default and composes its complete contract', () => {
    const marker = {
      version: 2,
      actions: [
        {
          label: '清理无效代码',
          target: '清理 useLiteV2Style 相关无效代码',
          scope: '仅处理已确认的声明和引用，不做其它重构',
          acceptance: '完成定向静态检查并汇报差异和结果',
        },
        {
          label: '查看引用',
          target: '查看 useLiteV2Style 的全部引用',
          scope: '仅做只读检索',
          acceptance: '列出引用位置并说明是否仍然生效',
        },
      ],
    };

    expect(extractFinalReplyActions(`结论\n<!--botmux-actions:${JSON.stringify(marker)}-->`))
      .toEqual({
        content: '结论',
        actions: [{
          label: '清理无效代码',
          prompt: [
            '目标：清理 useLiteV2Style 相关无效代码',
            '范围：仅处理已确认的声明和引用，不做其它重构',
            '验收：完成定向静态检查并汇报差异和结果',
          ].join('\n'),
        }],
      });
  });

  it('keeps up to three schema-v2 actions only for explicit alternatives', () => {
    const action = (label: string) => ({
      label,
      target: `采用${label}`,
      scope: '仅处理当前问题',
      acceptance: '给出验证结果',
    });
    const marker = {
      version: 2,
      relationship: 'alternatives',
      actions: [action('方案一'), action('方案二'), action('方案三'), action('方案四')],
    };

    const result = extractFinalReplyActions(`请选择\n<!--botmux-actions:${JSON.stringify(marker)}-->`);

    expect(result.actions.map(item => item.label)).toEqual(['方案一', '方案二', '方案三']);
  });

  it('rejects schema-v2 actions with an incomplete target, scope, or acceptance contract', () => {
    const marker = {
      version: 2,
      relationship: 'alternatives',
      actions: [
        { label: '缺少验收', target: '处理问题', scope: '当前模块' },
        { label: '完整动作', target: '定位问题', scope: '当前模块', acceptance: '给出根因证据' },
      ],
    };

    expect(extractFinalReplyActions(`结果\n<!--botmux-actions:${JSON.stringify(marker)}-->`).actions)
      .toEqual([{
        label: '完整动作',
        prompt: '目标：定位问题\n范围：当前模块\n验收：给出根因证据',
      }]);
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

  it('allows merge, deployment, and restart only as explicit authorization actions', () => {
    const prompt = '请先核对目标分支和运行态，再合入 custom/prod、构建并重启服务完成验收。';
    expect(isSafeFinalReplyActionPrompt(prompt)).toBe(false);
    expect(isSafeFinalReplyActionPrompt(prompt, 'explicit')).toBe(true);

    const marker = {
      actions: [{
        label: '合入并部署',
        prompt,
        authorization: 'explicit',
      }],
    };
    expect(extractFinalReplyActions(`待上线\n<!--botmux-actions:${JSON.stringify(marker)}-->`))
      .toEqual({
        content: '待上线',
        actions: [{
          label: '合入并部署',
          prompt,
          authorization: 'explicit',
        }],
      });
  });

  it('rejects destructive, permission, and payment actions even with explicit authorization', () => {
    for (const prompt of [
      '请强推覆盖远端分支。',
      '请删除这个 worktree。',
      '请给用户增加管理员权限。',
      '请支付这笔费用。',
      'Run git reset --hard now.',
    ]) {
      expect(isSafeFinalReplyActionPrompt(prompt)).toBe(false);
      expect(isSafeFinalReplyActionPrompt(prompt, 'explicit')).toBe(false);
    }
  });

  it('rejects custom release freeze from generic task-thread quick actions', () => {
    const prompt = '请冻结 3.7.1-custom.3，并回读 release 标签；不要推进生产或部署。';
    expect(isSafeFinalReplyActionPrompt(prompt, 'explicit')).toBe(false);
    const marker = { actions: [{ label: '冻结 3.7.1-custom.3', prompt, authorization: 'explicit' }] };
    expect(extractFinalReplyActions(`已合入\n<!--botmux-actions:${JSON.stringify(marker)}-->`).actions).toEqual([]);
    expect(isSafeFinalReplyActionPrompt('请冻结当前待发版 `3.7.1-custom.3`。', 'explicit')).toBe(false);
  });

  it('treats negated merge/deploy/restart as ordinary actions, not state changes', () => {
    // 回归：Youc 曾在 push-only 动作里写“暂不合入 custom/dev，不部署或重启”，
    // 旧的朴素子串匹配把“合入/部署/重启”当成状态变更，导致无授权按钮被整条静默丢弃。
    const negatedPrompts = [
      '完成定向测试、pnpm build、提交并 push 独立开发分支；暂不合入 custom/dev，不部署或重启。',
      '完成定向测试和构建；不加入 custom/dev，不冻结、部署或重启。',
      '本次仅提交，不发布、不上线。',
      '先不合入，等 review 后再说。',
      'Completed tests; do not merge or deploy or restart for now.',
    ];
    for (const prompt of negatedPrompts) {
      expect(requiresExplicitAuthorization(prompt)).toBe(false);
      // 无授权也能放行，说明否定语境不再要求 explicit。
      expect(isSafeFinalReplyActionPrompt(prompt)).toBe(true);
    }

    // 真实回归：v2 修复动作即使明确排除整组发版操作，也必须保留为可渲染按钮。
    const repairMarker = {
      version: 2,
      actions: [{
        label: '修复两处卡片问题',
        target: '修复待发版卡片展示及推荐操作误过滤问题',
        scope: '仅修改相关源码和测试；不加入 custom/dev，不冻结、部署或重启',
        acceptance: '定向测试和构建通过，最终回复能展示修复按钮',
      }],
    };
    expect(extractFinalReplyActions(`结论\n<!--botmux-actions:${JSON.stringify(repairMarker)}-->`).actions)
      .toEqual([{
        label: '修复两处卡片问题',
        prompt: [
          '目标：修复待发版卡片展示及推荐操作误过滤问题',
          '范围：仅修改相关源码和测试；不加入 custom/dev，不冻结、部署或重启',
          '验收：定向测试和构建通过，最终回复能展示修复按钮',
        ].join('\n'),
      }]);

    // 端到端：Youc 原始标记（不带 authorization）现在应渲染出按钮。
    const youcPrompt = negatedPrompts[0];
    const marker = { actions: [{ label: '按方案实现', prompt: youcPrompt }] };
    expect(extractFinalReplyActions(`本轮尚未修改、合入或部署。\n<!--botmux-actions:${JSON.stringify(marker)}-->`))
      .toEqual({
        content: '本轮尚未修改、合入或部署。',
        actions: [{ label: '按方案实现', prompt: youcPrompt }],
      });
  });

  it('still requires explicit authorization when any keyword is affirmative', () => {
    // 同一 prompt 里混有否定与肯定：只要有一处肯定的状态变更，就必须显式授权。
    const affirmativePrompts = [
      '提交并 push；确认无误后合入并部署。',
      '无需合入即可部署到测试环境。', // 否定“合入”但肯定“部署”
      'Please merge to prod and restart.',
      '先不部署，但现在就合入 custom/dev。', // 否定“部署”但肯定“合入”
    ];
    for (const prompt of affirmativePrompts) {
      expect(requiresExplicitAuthorization(prompt)).toBe(true);
      expect(isSafeFinalReplyActionPrompt(prompt)).toBe(false);
      expect(isSafeFinalReplyActionPrompt(prompt, 'explicit')).toBe(true);
    }
  });
});
