/**
 * 前端 CR 预览的数据边界。
 *
 * AI 只能提交结构化规格；真实 mention、MR 地址和目标群会在服务端持久化，
 * 卡片回调只携带 preview_id，不能用 action.value 伪造受保护字段。
 */

export const FRONTEND_CR_PREVIEW_SEND_ACTION = 'frontend_cr_preview_send';
export const FRONTEND_CR_PREVIEW_REGENERATE_ACTION = 'frontend_cr_preview_regenerate';
export const FRONTEND_CR_THANKS_EMOJI = 'ThanksHoldingBoard';

const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9]+$/;
const CHAT_ID_PATTERN = /^oc_[A-Za-z0-9]+$/;

export interface FrontendCrEditableFields {
  mrTitle: string;
  summary: string;
  status: string;
  releaseStatus: string;
  channels: string[];
}

export interface FrontendCrProtectedFields {
  authorOpenId: string;
  mrUrl: string;
  reviewerOpenIds: string[];
  thanksEmojiType: typeof FRONTEND_CR_THANKS_EMOJI;
}

export interface FrontendCrPreviewSpec {
  targetChatId: string;
  editable: FrontendCrEditableFields;
  protected: FrontendCrProtectedFields;
}

export class FrontendCrPreviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontendCrPreviewValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new FrontendCrPreviewValidationError(`${label} 必须是字符串`);
  const text = value.trim();
  if (!text) throw new FrontendCrPreviewValidationError(`${label} 不能为空`);
  if (text.length > maxLength) {
    throw new FrontendCrPreviewValidationError(`${label} 不能超过 ${maxLength} 个字符`);
  }
  return text;
}

function openId(value: unknown, label: string): string {
  const id = boundedText(value, label, 128);
  if (!OPEN_ID_PATTERN.test(id)) throw new FrontendCrPreviewValidationError(`${label} 不是合法 open_id`);
  return id;
}

function channels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new FrontendCrPreviewValidationError('Channel 必须是 1 到 20 项的数组');
  }
  const normalized = value.map((item, index) => boundedText(item, `Channel[${index}]`, 100));
  if (normalized.some(item => /[\n,，、]/.test(item))) {
    throw new FrontendCrPreviewValidationError('单个 Channel 不能包含换行或分隔符');
  }
  if (normalized.join('、').length > 1_000) {
    throw new FrontendCrPreviewValidationError('Channel 合计不能超过 1000 个字符');
  }
  return [...new Set(normalized)];
}

function reviewers(value: unknown, authorOpenId: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new FrontendCrPreviewValidationError('reviewerOpenIds 必须是 1 到 8 项的数组');
  }
  const normalized = [...new Set(value.map((item, index) => openId(item, `reviewerOpenIds[${index}]`)))]
    .filter(id => id !== authorOpenId);
  if (normalized.length === 0) {
    throw new FrontendCrPreviewValidationError('reviewerOpenIds 不能只包含作者本人');
  }
  return normalized;
}

function mrUrl(value: unknown): string {
  const raw = boundedText(value, 'mrUrl', 2_000);
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new FrontendCrPreviewValidationError('mrUrl 不是合法 URL'); }
  if (parsed.protocol !== 'https:') {
    throw new FrontendCrPreviewValidationError('mrUrl 只允许 HTTPS 地址');
  }
  return parsed.toString();
}

/** 解析 AI 生成的 CR 预览规格，不接受原始卡片 JSON。 */
export function parseFrontendCrPreviewSpec(raw: string | unknown): FrontendCrPreviewSpec {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); }
    catch (error) {
      throw new FrontendCrPreviewValidationError(
        `CR 预览规格不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!isRecord(value)) throw new FrontendCrPreviewValidationError('CR 预览规格必须是 JSON object');
  const authorOpenId = openId(value.authorOpenId, 'authorOpenId');
  const targetChatId = boundedText(value.targetChatId, 'targetChatId', 128);
  if (!CHAT_ID_PATTERN.test(targetChatId)) {
    throw new FrontendCrPreviewValidationError('targetChatId 不是合法群聊 chat_id');
  }
  return {
    targetChatId,
    editable: {
      mrTitle: boundedText(value.mrTitle, 'mrTitle', 300),
      summary: boundedText(value.summary, 'summary', 1_000),
      status: boundedText(value.status, 'status', 50),
      releaseStatus: boundedText(value.releaseStatus, 'releaseStatus', 100),
      channels: channels(value.channels),
    },
    protected: {
      authorOpenId,
      mrUrl: mrUrl(value.mrUrl),
      reviewerOpenIds: reviewers(value.reviewerOpenIds, authorOpenId),
      thanksEmojiType: FRONTEND_CR_THANKS_EMOJI,
    },
  };
}

function formText(
  formValue: Record<string, unknown>,
  name: string,
  fallback: string,
  label: string,
  maxLength: number,
): string {
  const value = formValue[name] === undefined ? fallback : formValue[name];
  return boundedText(value, label, maxLength);
}

/** 将飞书 form_value 收敛成发送与重新生成共用的可编辑字段。 */
export function normalizeFrontendCrFormValue(
  formValue: Record<string, unknown> | undefined,
  fallback: FrontendCrEditableFields,
): FrontendCrEditableFields {
  const value = formValue ?? {};
  const channelText = formText(
    value,
    'channels',
    fallback.channels.join('、'),
    'Channel',
    1_000,
  );
  const channelList = channelText
    .split(/[\n,，、]+/)
    .map(item => item.trim())
    .filter(Boolean);
  return {
    mrTitle: formText(value, 'mr_title', fallback.mrTitle, 'MR 标题', 300),
    summary: formText(value, 'summary', fallback.summary, '需求与改动', 1_000),
    status: formText(value, 'status', fallback.status, '状态', 50),
    releaseStatus: formText(value, 'release_status', fallback.releaseStatus, '跟版状态', 100),
    channels: channels(channelList),
  };
}
