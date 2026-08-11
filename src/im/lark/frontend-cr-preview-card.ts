/**
 * 前端 CR 可编辑预览卡与正式通知卡渲染。
 *
 * 预览卡只暴露文字字段；MR 地址、作者、评审人和感谢表情来自服务端记录。
 * 正式卡只含展示组件，不携带输入框或 callback 按钮。
 */

import {
  FRONTEND_CR_PREVIEW_REGENERATE_ACTION,
  FRONTEND_CR_PREVIEW_SEND_ACTION,
  type FrontendCrEditableFields,
  type FrontendCrProtectedFields,
} from '../../services/frontend-cr-preview-model.js';

export interface FrontendCrPreviewCardInput {
  previewId: string;
  targetChatId: string;
  editable: FrontendCrEditableFields;
  protected: FrontendCrProtectedFields;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_\[\]()<>])/g, '\\$1');
}

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}

function mention(openId: string): string {
  return `<at id=${openId}></at>`;
}

function requestLine(input: Pick<FrontendCrPreviewCardInput, 'editable' | 'protected'>): string {
  const reviewers = input.protected.reviewerOpenIds.map(mention).join('');
  const linkedTitle = `[${escapeMarkdownText(input.editable.mrTitle)}](${input.protected.mrUrl})`;
  return `${mention(input.protected.authorOpenId)} 的 MR：${linkedTitle}　${reviewers} `
    + `求帮忙 CR :${input.protected.thanksEmojiType}:`;
}

function inputElement(
  name: string,
  label: string,
  defaultValue: string,
  options: { multiline?: boolean; maxLength: number },
): Record<string, unknown> {
  return {
    tag: 'input',
    name,
    required: true,
    width: 'fill',
    default_value: defaultValue,
    max_length: options.maxLength,
    ...(options.multiline
      ? { input_type: 'multiline_text', rows: 3, auto_resize: true, max_rows: 8 }
      : {}),
    label: { tag: 'plain_text', content: label },
    label_position: 'top',
    placeholder: { tag: 'plain_text', content: `请输入${label}` },
  };
}

function actionButton(
  previewId: string,
  action: typeof FRONTEND_CR_PREVIEW_SEND_ACTION | typeof FRONTEND_CR_PREVIEW_REGENERATE_ACTION,
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
export function buildFrontendCrPreviewCard(input: FrontendCrPreviewCardInput): string {
  const sendButton = actionButton(input.previewId, FRONTEND_CR_PREVIEW_SEND_ACTION, '发送', 'primary');
  const regenerateButton = actionButton(
    input.previewId,
    FRONTEND_CR_PREVIEW_REGENERATE_ACTION,
    '重新生成',
    'default',
  );
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'CR 请求 · 可编辑预览' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: 'medium',
      elements: [
        { tag: 'markdown', content: requestLine(input) },
        {
          tag: 'markdown',
          text_size: 'notation',
          content: `<font color="grey">发送目标已锁定：${inlineCode(input.targetChatId)}；MR 链接和真实 @ 不可编辑。</font>`,
        },
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'frontend_cr_preview_form',
          vertical_spacing: 'medium',
          elements: [
            inputElement('mr_title', 'MR 标题', input.editable.mrTitle, { maxLength: 300 }),
            inputElement('summary', '需求与改动', input.editable.summary, { multiline: true, maxLength: 1_000 }),
            inputElement('status', '状态', input.editable.status, { maxLength: 50 }),
            inputElement('release_status', '跟版状态', input.editable.releaseStatus, { maxLength: 100 }),
            inputElement('channels', 'Channel', input.editable.channels.join('、'), { multiline: true, maxLength: 1_000 }),
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

/** 构造发往目标群的纯展示通知卡。 */
export function buildFrontendCrNotificationCard(
  editable: FrontendCrEditableFields,
  protectedFields: FrontendCrProtectedFields,
): string {
  const input = { editable, protected: protectedFields };
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'CR 请求' },
    },
    body: {
      direction: 'vertical',
      elements: [
        { tag: 'markdown', content: requestLine(input) },
        { tag: 'markdown', content: escapeMarkdownText(editable.summary) },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: `**状态**　${escapeMarkdownText(editable.status)}\n`
            + `**跟版状态**　${escapeMarkdownText(editable.releaseStatus)}\n`
            + `**Channel**　${editable.channels.map(inlineCode).join('、')}`,
        },
      ],
    },
  });
}

/** 构造旧预览的无控件终态，阻止继续提交旧内容。 */
export function buildFrontendCrPreviewTerminalCard(
  kind: 'sent' | 'regenerated',
  messageId: string,
): string {
  const sent = kind === 'sent';
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: sent ? 'green' : 'grey',
      title: { tag: 'plain_text', content: sent ? 'CR 请求 · 已发送' : 'CR 请求 · 已重新生成' },
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
