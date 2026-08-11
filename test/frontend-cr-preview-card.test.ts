/** 前端 CR 预览规格与卡片渲染的定向测试。 */
import { describe, expect, it } from 'vitest';
import {
  buildFrontendCrNotificationCard,
  buildFrontendCrPreviewCard,
  buildFrontendCrPreviewTerminalCard,
} from '../src/im/lark/frontend-cr-preview-card.js';
import {
  FRONTEND_CR_PREVIEW_REGENERATE_ACTION,
  FRONTEND_CR_PREVIEW_SEND_ACTION,
  normalizeFrontendCrFormValue,
  parseFrontendCrPreviewSpec,
} from '../src/services/frontend-cr-preview-model.js';

const rawSpec = {
  targetChatId: 'oc_target123',
  authorOpenId: 'ou_author123',
  mrUrl: 'https://code.example.com/team/repo/merge_requests/552',
  mrTitle: 'feat: [development task] 网络恢复后自动重试',
  reviewerOpenIds: ['ou_reviewer1', 'ou_reviewer2', 'ou_reviewer3'],
  summary: '网络恢复后自动重试最近失败请求。',
  status: '测试中',
  releaseStatus: '跟版 v6.6.6',
  channels: ['novelfm', 'novelfm_distribution_lynx'],
};

function everyNode(value: unknown, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) value.forEach(item => everyNode(item, output));
  else if (value && typeof value === 'object') {
    output.push(value as Record<string, unknown>);
    Object.values(value).forEach(item => everyNode(item, output));
  }
  return output;
}

describe('前端 CR 预览卡', () => {
  it('解析结构化规格并固定感谢表情与受保护字段', () => {
    const spec = parseFrontendCrPreviewSpec(JSON.stringify(rawSpec));
    expect(spec.targetChatId).toBe(rawSpec.targetChatId);
    expect(spec.protected.thanksEmojiType).toBe('ThanksHoldingBoard');
    expect(spec.protected.mrUrl).toBe(rawSpec.mrUrl);
    expect(spec.editable.channels).toEqual(rawSpec.channels);
  });

  it('预览卡包含五个输入字段和两个同表单提交按钮', () => {
    const spec = parseFrontendCrPreviewSpec(rawSpec);
    const card = JSON.parse(buildFrontendCrPreviewCard({ previewId: 'preview-1', ...spec }));
    const nodes = everyNode(card);
    const inputs = nodes.filter(node => node.tag === 'input');
    const buttons = nodes.filter(node => node.tag === 'button');
    expect(inputs.map(input => input.name)).toEqual([
      'mr_title',
      'summary',
      'status',
      'release_status',
      'channels',
    ]);
    expect(buttons).toHaveLength(2);
    expect(buttons.every(button => button.action_type === 'form_submit')).toBe(true);
    expect(buttons.map(button => (button.value as any).action)).toEqual([
      FRONTEND_CR_PREVIEW_SEND_ACTION,
      FRONTEND_CR_PREVIEW_REGENERATE_ACTION,
    ]);
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('<at id=ou_author123></at>');
    expect(serialized).toContain('<at id=ou_reviewer1></at>');
    expect(serialized).toContain(':ThanksHoldingBoard:');
    expect(serialized).toContain('发送目标已锁定');
  });

  it('正式卡只有展示内容且使用提交后的字段', () => {
    const spec = parseFrontendCrPreviewSpec(rawSpec);
    const edited = normalizeFrontendCrFormValue({
      mr_title: 'feat: 用户修改标题',
      summary: '用户修改总结',
      status: '测试完成',
      release_status: '不跟版',
      channels: 'channel_a、channel_b',
    }, spec.editable);
    const card = JSON.parse(buildFrontendCrNotificationCard(edited, spec.protected));
    const nodes = everyNode(card);
    expect(nodes.some(node => node.tag === 'input' || node.tag === 'form' || node.tag === 'button')).toBe(false);
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('用户修改标题');
    expect(serialized).toContain('用户修改总结');
    expect(serialized).toContain('测试完成');
    expect(serialized).toContain('不跟版');
    expect(serialized).toContain('channel_a');
  });

  it('旧预览终态不再含输入或按钮', () => {
    for (const kind of ['sent', 'regenerated'] as const) {
      const card = JSON.parse(buildFrontendCrPreviewTerminalCard(kind, 'om_result'));
      const nodes = everyNode(card);
      expect(nodes.some(node => node.tag === 'input' || node.tag === 'form' || node.tag === 'button')).toBe(false);
    }
  });

  it('拒绝非 HTTPS 地址与空 Channel', () => {
    expect(() => parseFrontendCrPreviewSpec({ ...rawSpec, mrUrl: 'http://code.example.com/mr/1' })).toThrow(/HTTPS/);
    expect(() => normalizeFrontendCrFormValue({ channels: '，、\n' }, parseFrontendCrPreviewSpec(rawSpec).editable)).toThrow(/Channel/);
  });

  it('拒绝只有作者本人的评审列表与带分隔符的单个 Channel', () => {
    expect(() => parseFrontendCrPreviewSpec({
      ...rawSpec,
      reviewerOpenIds: [rawSpec.authorOpenId],
    })).toThrow(/作者本人/);
    expect(() => parseFrontendCrPreviewSpec({
      ...rawSpec,
      channels: ['channel_a、channel_b'],
    })).toThrow(/分隔符/);
  });
});
