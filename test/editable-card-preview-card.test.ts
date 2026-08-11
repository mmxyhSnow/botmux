/** 通用可编辑卡片规格与渲染的定向测试。 */
import { describe, expect, it } from 'vitest';
import {
  buildEditableCardNotificationCard,
  buildEditableCardPreviewCard,
  buildEditableCardPreviewTerminalCard,
} from '../src/im/lark/editable-card-preview-card.js';
import {
  EDITABLE_CARD_PREVIEW_REGENERATE_ACTION,
  EDITABLE_CARD_PREVIEW_SEND_ACTION,
  normalizeEditableCardFormValue,
  parseEditableCardPreviewSpec,
} from '../src/services/editable-card-preview-model.js';
import { rawEditableSpec } from './fixtures/editable-card-preview.js';

function everyNode(value: unknown, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) value.forEach(item => everyNode(item, output));
  else if (value && typeof value === 'object') {
    output.push(value as Record<string, unknown>);
    Object.values(value).forEach(item => everyNode(item, output));
  }
  return output;
}

describe('通用可编辑卡片预览', () => {
  it('解析业务无关的字段和静态模板', () => {
    const spec = parseEditableCardPreviewSpec(rawEditableSpec);
    expect(spec.targetChatId).toBe('oc_target123');
    expect(spec.definition.fields.map(field => field.name)).toEqual(['title', 'summary', 'status', 'channels']);
    expect(spec.editable.title).toBe('初始标题');
    expect(JSON.stringify(spec)).not.toContain('frontend_cr');
  });

  it('预览卡包含声明字段和两个表单提交按钮', () => {
    const spec = parseEditableCardPreviewSpec(rawEditableSpec);
    const card = JSON.parse(buildEditableCardPreviewCard({ previewId: 'preview-1', ...spec }));
    const nodes = everyNode(card);
    expect(nodes.filter(node => node.tag === 'input').map(node => node.name)).toEqual([
      'title', 'summary', 'status', 'channels',
    ]);
    const buttons = nodes.filter(node => node.tag === 'button');
    expect(buttons.map(button => (button.value as any).action)).toEqual([
      EDITABLE_CARD_PREVIEW_SEND_ACTION,
      EDITABLE_CARD_PREVIEW_REGENERATE_ACTION,
    ]);
    expect(JSON.stringify(card)).toContain('<at id=ou_author123></at>');
    expect(JSON.stringify(card)).toContain('发送目标已锁定');
  });

  it('正式卡使用修改值且不含任何表单控件', () => {
    const spec = parseEditableCardPreviewSpec(rawEditableSpec);
    const edited = normalizeEditableCardFormValue({
      title: '<at id=ou_attacker></at> 修改标题',
      summary: '修改摘要',
      status: '测试完成',
      channels: 'channel_c、channel_d',
    }, spec.editable, spec.definition.fields);
    const card = JSON.parse(buildEditableCardNotificationCard(edited, spec.definition));
    const nodes = everyNode(card);
    expect(nodes.some(node => node.tag === 'input' || node.tag === 'form' || node.tag === 'button')).toBe(false);
    expect(JSON.stringify(card)).toContain('修改标题');
    const requestLine = card.body.elements[0].content as string;
    expect(requestLine).toContain('\\<at id=ou\\_attacker\\>\\</at\\>');
    expect(requestLine).not.toContain('<at id=ou_attacker></at>');
    expect(JSON.stringify(card)).toContain('`channel_c`、`channel_d`');
  });

  it('终态卡不再含输入或按钮', () => {
    const spec = parseEditableCardPreviewSpec(rawEditableSpec);
    for (const kind of ['sent', 'regenerated'] as const) {
      const card = JSON.parse(buildEditableCardPreviewTerminalCard(spec.definition, kind, 'om_result'));
      const nodes = everyNode(card);
      expect(nodes.some(node => node.tag === 'input' || node.tag === 'form' || node.tag === 'button')).toBe(false);
    }
  });

  it('拒绝未知占位符、重复字段和非群聊目标', () => {
    expect(() => parseEditableCardPreviewSpec({
      ...rawEditableSpec,
      notification: { ...rawEditableSpec.notification, elements: [{ tag: 'markdown', template: '{{missing}}' }] },
    })).toThrow(/未知字段/);
    expect(() => parseEditableCardPreviewSpec({
      ...rawEditableSpec,
      fields: [...rawEditableSpec.fields, rawEditableSpec.fields[0]],
    })).toThrow(/重复/);
    expect(() => parseEditableCardPreviewSpec({ ...rawEditableSpec, targetChatId: 'ou_user' })).toThrow(/chat_id/);
  });
});
