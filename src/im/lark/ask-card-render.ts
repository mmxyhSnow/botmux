import type { AskResult, PendingAsk } from '../../core/ask-types.js';
import { localeForBot, t, type Locale } from '../../i18n/index.js';
import { buildAskFlowCard, type AskFlowActions } from './ask-card-flow.js';
import { buildAskAnswerableContent } from './ask-card-meta.js';

/**
 * ASK 卡片纯渲染模块。
 *
 * 本文件只把 broker 快照转成飞书卡片 JSON，不处理发送、更新或回调。
 */
const MAX_BUTTONS_PER_ACTION_ROW = 4;

/** 渲染普通 ASK 或连续提问卡片。 */
export function renderAskCard(
  ask: PendingAsk,
  actions: AskFlowActions,
  result?: AskResult,
): string {
  const flowCard = buildAskFlowCard(ask, actions, result);
  if (flowCard) return flowCard;
  const locale = localeForBot(ask.larkAppId);
  const deadline = new Date(ask.deadlineAt).toLocaleString('zh-CN');
  const status = result ? settleStatus(result, ask, locale) : undefined;

  const metaDiv = {
    tag: 'div',
    fields: [
      {
        is_short: true,
        text: {
          tag: 'lark_md',
          content: `**${t('card.ask.field.deadline', undefined, locale)}**\n${escapeMd(deadline)}`,
        },
      },
      {
        is_short: true,
        text: {
          tag: 'lark_md',
          content: `**${t('card.ask.field.answerable', undefined, locale)}**\n${buildAskAnswerableContent(ask, locale)}`,
        },
      },
    ],
  };
  const elements: Array<Record<string, unknown>> = [metaDiv, { tag: 'hr' }];

  if (status) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: status } });
  } else {
    appendActiveQuestions(elements, ask, actions, locale);
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: t('card.ask.custom_reply_hint', undefined, locale) }],
    });
  }

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: result ? templateForResult(result) : 'blue',
      title: {
        tag: 'plain_text',
        content: result
          ? t('card.ask.title_done', undefined, locale)
          : t('card.ask.title', undefined, locale),
      },
    },
    elements,
  });
}

/** 普通 ASK 只使用 action/button，避免飞书静默丢弃 form 内选择器。 */
function appendActiveQuestions(
  elements: Array<Record<string, unknown>>,
  ask: PendingAsk,
  actions: AskFlowActions,
  locale: Locale,
): void {
  const requiresSubmit = ask.questions.length > 1 || ask.questions.some(question => question.multiSelect);
  const selections = ask.selections ?? ask.questions.map(() => []);

  for (let index = 0; index < ask.questions.length; index++) {
    const question = ask.questions[index]!;
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${t('card.ask.question_n', { n: index + 1 }, locale)}**\n${escapeMd(truncate(question.prompt, 512, locale))}`,
      },
    });

    const selected = new Set(selections[index] ?? []);
    const optionButtons = question.options.map(option => ({
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: requiresSubmit
          ? optionLabel(question.multiSelect, selected.has(option.key), option.label)
          : option.label,
      },
      type: selected.has(option.key) ? 'primary' : 'default',
      value: requiresSubmit
        ? {
            action: actions.toggle,
            ask_id: ask.askId,
            nonce: ask.nonce,
            projection_id: ask.projectionId,
            question_index: String(index),
            key: option.key,
          }
        : {
            action: actions.select,
            ask_id: ask.askId,
            nonce: ask.nonce,
            projection_id: ask.projectionId,
            key: option.key,
          },
    }));
    appendActionRows(elements, optionButtons);
  }

  if (requiresSubmit) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.ask.submit', undefined, locale) },
        type: 'primary',
        value: {
          action: actions.submit,
          ask_id: ask.askId,
          nonce: ask.nonce,
          projection_id: ask.projectionId,
        },
      }],
    });
  }
}

/** 构造普通 ASK 的结算摘要。 */
function settleStatus(result: AskResult, ask: PendingAsk, locale: Locale): string {
  if (result.kind === 'answered') {
    const hasSelection = result.answers.some(keys => keys.length > 0);
    if (result.comment && !hasSelection) {
      return `**${t('card.ask.custom_reply', undefined, locale)}**\n${escapeMd(result.comment)}\n${t('common.operator', { by: escapeMd(short(result.by, 28)) }, locale)}`;
    }
    const lines = result.answers.map((keys, index) => {
      const question = ask.questions[index];
      if (!question) return t('card.ask.q_unparseable', { n: index + 1 }, locale);
      const labels = keys.map(key => question.options.find(option => option.key === key)?.label ?? key);
      return t('card.ask.q_summary_line', { n: index + 1, labels: labels.join(', ') }, locale);
    });
    const commentLine = result.comment
      ? `\n${t('card.ask.supplement', { comment: escapeMd(result.comment) }, locale)}`
      : '';
    return `**${t('card.ask.selected', undefined, locale)}**\n${escapeMd(lines.join('\n'))}${commentLine}\n${t('common.operator', { by: escapeMd(short(result.by, 28)) }, locale)}`;
  }
  if (result.kind === 'timedOut') return `**${t('card.ask.timed_out', undefined, locale)}**`;
  return `**${t('card.ask.invalidated', undefined, locale)}**\n${escapeMd(result.reason)}`;
}

/** 按结算类型选择卡片颜色。 */
function templateForResult(result: AskResult): string {
  switch (result.kind) {
    case 'answered': return 'green';
    case 'timedOut': return 'orange';
    case 'invalidated': return 'grey';
  }
}

function optionLabel(multiSelect: boolean, selected: boolean, label: string): string {
  if (multiSelect) return `${selected ? '☑' : '☐'} ${label}`;
  return `${selected ? '◉' : '○'} ${label}`;
}

function appendActionRows(
  elements: Array<Record<string, unknown>>,
  actions: Array<Record<string, unknown>>,
): void {
  for (let index = 0; index < actions.length; index += MAX_BUTTONS_PER_ACTION_ROW) {
    elements.push({ tag: 'action', actions: actions.slice(index, index + MAX_BUTTONS_PER_ACTION_ROW) });
  }
}

function truncate(value: string, maxChars: number, locale: Locale): string {
  if (value.length <= maxChars) return value || t('common.empty_paren', undefined, locale);
  return `${value.slice(0, maxChars)}\n\n${t('common.truncated_short', undefined, locale)}`;
}

function escapeMd(value: string): string {
  return value.replace(/[*_~`\[\]\\]/g, character => `\\${character}`);
}

function short(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}
