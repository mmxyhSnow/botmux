/**
 * 通用可编辑预览卡与最终通知卡渲染。
 *
 * 预览卡只暴露声明过的文字字段；最终卡只含 markdown/hr 展示组件，
 * 不携带输入框或 callback 按钮。
 */

import {
  EDITABLE_CARD_PREVIEW_REGENERATE_ACTION,
  EDITABLE_CARD_PREVIEW_SEND_ACTION,
  renderEditableCardTemplate,
  type EditableCardDefinition,
  type EditableCardTemplateElement,
  type EditableCardValues,
} from '../../services/editable-card-preview-model.js';

export interface EditableCardPreviewCardInput {
  previewId: string;
  targetChatId: string;
  editable: EditableCardValues;
  definition: EditableCardDefinition;
}

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}

function renderElements(
  elements: EditableCardTemplateElement[],
  editable: EditableCardValues,
  definition: EditableCardDefinition,
): Record<string, unknown>[] {
  return elements.map(element => element.tag === 'hr'
    ? { tag: 'hr' }
    : {
        tag: 'markdown',
        content: renderEditableCardTemplate(element.template, editable, definition.fields),
      });
}

function inputElement(
  field: EditableCardDefinition['fields'][number],
  defaultValue: string,
): Record<string, unknown> {
  return {
    tag: 'input',
    name: field.name,
    required: true,
    width: 'fill',
    default_value: defaultValue,
    max_length: field.maxLength,
    ...(field.multiline
      ? { input_type: 'multiline_text', rows: 3, auto_resize: true, max_rows: 8 }
      : {}),
    label: { tag: 'plain_text', content: field.label },
    label_position: 'top',
    placeholder: { tag: 'plain_text', content: `请输入${field.label}` },
  };
}

function actionButton(
  previewId: string,
  action: typeof EDITABLE_CARD_PREVIEW_SEND_ACTION | typeof EDITABLE_CARD_PREVIEW_REGENERATE_ACTION,
  label: string,
  type: 'primary' | 'default',
): Record<string, unknown> {
  return {
    tag: 'button',
    name: action,
    type,
    text: { tag: 'plain_text', content: label },
    action_type: 'form_submit',
    value: { action, preview_id: previewId, label },
  };
}

/** 构造只允许发起人提交的结构化编辑预览。 */
export function buildEditableCardPreviewCard(input: EditableCardPreviewCardInput): string {
  const definition = input.definition;
  const targetChatDisplay = definition.targetChatDisplayName ?? input.targetChatId;
  const sendButton = actionButton(input.previewId, EDITABLE_CARD_PREVIEW_SEND_ACTION, '发送', 'primary');
  const regenerateButton = actionButton(
    input.previewId,
    EDITABLE_CARD_PREVIEW_REGENERATE_ACTION,
    '重新生成',
    'default',
  );
  const note = [
    definition.previewNote,
    `发送目标已锁定：${inlineCode(targetChatDisplay)}；静态模板和目标不可由回调修改。`,
  ].filter(Boolean).join('\n');
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: definition.previewTitle },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: 'medium',
      elements: [
        ...renderElements(definition.previewElements, input.editable, definition),
        { tag: 'markdown', text_size: 'notation', content: `<font color="grey">${note}</font>` },
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'editable_card_preview_form',
          vertical_spacing: 'medium',
          elements: [
            ...definition.fields.map(field => inputElement(field, input.editable[field.name])),
            {
              tag: 'column_set',
              flex_mode: 'none',
              horizontal_spacing: 'small',
              columns: [sendButton, regenerateButton].map(button => ({
                tag: 'column',
                width: 'auto',
                vertical_align: 'center',
                elements: [button],
              })),
            },
          ],
        },
      ],
    },
  });
}

/** 构造发往锁定目标群的纯展示通知卡。 */
export function buildEditableCardNotificationCard(
  editable: EditableCardValues,
  definition: EditableCardDefinition,
): string {
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: definition.notificationTitle },
    },
    body: {
      direction: 'vertical',
      elements: renderElements(definition.notificationElements, editable, definition),
    },
  });
}

/** 构造旧预览的无控件终态，阻止继续提交旧内容。 */
export function buildEditableCardPreviewTerminalCard(
  definition: EditableCardDefinition,
  kind: 'sent' | 'regenerated',
  messageId: string,
): string {
  const sent = kind === 'sent';
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: sent ? 'green' : 'grey',
      title: {
        tag: 'plain_text',
        content: `${definition.notificationTitle} · ${sent ? '已发送' : '已重新生成'}`,
      },
    },
    body: {
      direction: 'vertical',
      elements: [{
        tag: 'markdown',
        content: sent
          ? `正式通知已发送，消息 ID：${inlineCode(messageId)}`
          : `此预览已失效，请使用新预览：${inlineCode(messageId)}`,
      }],
    },
  });
}
