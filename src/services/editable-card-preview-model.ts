/**
 * 通用可编辑卡片预览的数据边界与模板渲染。
 *
 * 调用方只声明字段、静态模板和目标群；回调仅提交字段值与 preview_id，
 * 不能改写目标、模板或静态 mention。
 */

export const EDITABLE_CARD_PREVIEW_SEND_ACTION = 'editable_card_preview_send';
export const EDITABLE_CARD_PREVIEW_REGENERATE_ACTION = 'editable_card_preview_regenerate';

const CHAT_ID_PATTERN = /^oc_[A-Za-z0-9]+$/;
const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const TEMPLATE_TOKEN_PATTERN = /\{\{([a-z][a-z0-9_]*)\}\}/g;

export type EditableCardFieldFormat = 'markdown_text' | 'inline_code_list';

export interface EditableCardFieldDefinition {
  name: string;
  label: string;
  multiline: boolean;
  maxLength: number;
  format: EditableCardFieldFormat;
}

export type EditableCardTemplateElement =
  | { tag: 'markdown'; template: string }
  | { tag: 'hr' };

export interface EditableCardDefinition {
  previewTitle: string;
  notificationTitle: string;
  previewNote?: string;
  fields: EditableCardFieldDefinition[];
  previewElements: EditableCardTemplateElement[];
  notificationElements: EditableCardTemplateElement[];
}

export type EditableCardValues = Record<string, string>;

export interface EditableCardPreviewSpec {
  targetChatId: string;
  editable: EditableCardValues;
  definition: EditableCardDefinition;
}

export class EditableCardPreviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditableCardPreviewValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new EditableCardPreviewValidationError(`${label} 必须是字符串`);
  const text = value.trim();
  if (!text) throw new EditableCardPreviewValidationError(`${label} 不能为空`);
  if (text.length > maxLength) {
    throw new EditableCardPreviewValidationError(`${label} 不能超过 ${maxLength} 个字符`);
  }
  return text;
}

function parseFields(value: unknown): { definitions: EditableCardFieldDefinition[]; values: EditableCardValues } {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw new EditableCardPreviewValidationError('fields 必须包含 1 到 10 个字段');
  }
  const names = new Set<string>();
  const values: EditableCardValues = {};
  const definitions = value.map((item, index): EditableCardFieldDefinition => {
    if (!isRecord(item)) throw new EditableCardPreviewValidationError(`fields[${index}] 必须是 object`);
    const name = boundedText(item.name, `fields[${index}].name`, 64);
    if (!FIELD_NAME_PATTERN.test(name)) {
      throw new EditableCardPreviewValidationError(`fields[${index}].name 格式无效`);
    }
    if (names.has(name)) throw new EditableCardPreviewValidationError(`字段名重复：${name}`);
    names.add(name);
    const maxLength = item.maxLength === undefined ? 1_000 : item.maxLength;
    if (!Number.isInteger(maxLength) || Number(maxLength) < 1 || Number(maxLength) > 1_000) {
      throw new EditableCardPreviewValidationError(`${name}.maxLength 必须是 1 到 1000 的整数`);
    }
    const format = item.format ?? 'markdown_text';
    if (format !== 'markdown_text' && format !== 'inline_code_list') {
      throw new EditableCardPreviewValidationError(`${name}.format 不受支持`);
    }
    values[name] = boundedText(item.value, `${name}.value`, Number(maxLength));
    return {
      name,
      label: boundedText(item.label, `${name}.label`, 80),
      multiline: item.multiline === true,
      maxLength: Number(maxLength),
      format,
    };
  });
  return { definitions, values };
}

function parseTemplateElements(
  value: unknown,
  label: string,
  fieldNames: Set<string>,
): EditableCardTemplateElement[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new EditableCardPreviewValidationError(`${label} 必须包含 1 到 20 个元素`);
  }
  return value.map((item, index) => {
    if (!isRecord(item)) throw new EditableCardPreviewValidationError(`${label}[${index}] 必须是 object`);
    if (item.tag === 'hr') return { tag: 'hr' };
    if (item.tag !== 'markdown') {
      throw new EditableCardPreviewValidationError(`${label}[${index}].tag 仅支持 markdown/hr`);
    }
    const template = boundedText(item.template, `${label}[${index}].template`, 5_000);
    for (const match of template.matchAll(TEMPLATE_TOKEN_PATTERN)) {
      if (!fieldNames.has(match[1])) {
        throw new EditableCardPreviewValidationError(`${label}[${index}] 引用了未知字段 ${match[1]}`);
      }
    }
    const stripped = template.replace(TEMPLATE_TOKEN_PATTERN, '');
    if (stripped.includes('{{') || stripped.includes('}}')) {
      throw new EditableCardPreviewValidationError(`${label}[${index}] 含无效模板占位符`);
    }
    return { tag: 'markdown', template };
  });
}

/** 解析 Skill 或其它可信调用方生成的通用可编辑卡片规格。 */
export function parseEditableCardPreviewSpec(raw: string | unknown): EditableCardPreviewSpec {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); }
    catch (error) {
      throw new EditableCardPreviewValidationError(
        `可编辑卡片规格不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!isRecord(value)) throw new EditableCardPreviewValidationError('可编辑卡片规格必须是 JSON object');
  const targetChatId = boundedText(value.targetChatId, 'targetChatId', 128);
  if (!CHAT_ID_PATTERN.test(targetChatId)) {
    throw new EditableCardPreviewValidationError('targetChatId 不是合法群聊 chat_id');
  }
  const parsedFields = parseFields(value.fields);
  const fieldNames = new Set(parsedFields.definitions.map(field => field.name));
  const preview = isRecord(value.preview) ? value.preview : {};
  const notification = isRecord(value.notification) ? value.notification : {};
  return {
    targetChatId,
    editable: parsedFields.values,
    definition: {
      previewTitle: boundedText(preview.title, 'preview.title', 100),
      notificationTitle: boundedText(notification.title, 'notification.title', 100),
      ...(preview.note === undefined
        ? {}
        : { previewNote: boundedText(preview.note, 'preview.note', 500) }),
      fields: parsedFields.definitions,
      previewElements: parseTemplateElements(preview.elements, 'preview.elements', fieldNames),
      notificationElements: parseTemplateElements(
        notification.elements,
        'notification.elements',
        fieldNames,
      ),
    },
  };
}

/** 将飞书 form_value 收敛为规格声明的字段集合，不接受额外字段。 */
export function normalizeEditableCardFormValue(
  formValue: Record<string, unknown> | undefined,
  fallback: EditableCardValues,
  fields: EditableCardFieldDefinition[],
): EditableCardValues {
  const submitted = formValue ?? {};
  const normalized: EditableCardValues = {};
  for (const field of fields) {
    const raw = submitted[field.name] === undefined ? fallback[field.name] : submitted[field.name];
    normalized[field.name] = boundedText(raw, field.label, field.maxLength);
  }
  return normalized;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_\[\]()<>])/g, '\\$1');
}

function formatValue(value: string, format: EditableCardFieldFormat): string {
  if (format === 'markdown_text') return escapeMarkdownText(value);
  return value
    .split(/[\n,，、]+/)
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => `\`${item.replace(/`/g, "'")}\``)
    .join('、');
}

/** 用受限占位符渲染静态模板，业务模板不会进入回调负载。 */
export function renderEditableCardTemplate(
  template: string,
  values: EditableCardValues,
  fields: EditableCardFieldDefinition[],
): string {
  const definitions = new Map(fields.map(field => [field.name, field]));
  return template.replace(TEMPLATE_TOKEN_PATTERN, (_token, name: string) => {
    const field = definitions.get(name);
    if (!field || values[name] === undefined) throw new Error(`缺少可编辑字段：${name}`);
    return formatValue(values[name], field.format);
  });
}
