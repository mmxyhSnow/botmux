/**
 * Codex 连续提问卡片渲染。
 *
 * 历史答案由 ask broker 提供只读快照；本模块只负责把已完成问题绘制为
 * 高亮且不可点击的按钮，并把当前问题追加在同一卡片下方。
 */
import type {
  AskFlowStep,
  AskQuestion,
  AskResult,
  PendingAsk,
} from '../../core/ask-types.js';
import { localeForBot, t, type Locale } from '../../i18n/index.js';

export interface AskFlowActions {
  select: string;
  submit: string;
  toggle: string;
  undo: string;
}

const MAX_BUTTONS_PER_ACTION_ROW = 4;

/** 自动分段时构造上一张卡片的只读完成态。 */
export function buildPreviousAskFlowSegmentCard(
  ask: PendingAsk,
  actions: AskFlowActions,
): { messageId: string; cardJson: string } | undefined {
  const previous = ask.flow?.previousSegment;
  if (!previous) return undefined;
  const previousAsk: PendingAsk = {
    ...ask,
    settled: true,
    flow: {
      flowId: ask.flow!.flowId,
      cardMessageId: previous.cardMessageId,
      questionOffset: previous.questionOffset,
      steps: previous.steps,
    },
  };
  const cardJson = buildAskFlowCard(previousAsk, actions, undefined, true);
  return cardJson ? { messageId: previous.cardMessageId, cardJson } : undefined;
}

/** 存在 flow 时返回完整卡片；普通单次 ask 返回 undefined 走旧渲染。 */
export function buildAskFlowCard(
  ask: PendingAsk,
  actions: AskFlowActions,
  result?: AskResult,
  completed = false,
): string | undefined {
  if (!ask.flow) return undefined;
  const locale = localeForBot(ask.larkAppId);
  const elements: Array<Record<string, unknown>> = [buildMeta(ask, locale), { tag: 'hr' }];
  let questionNumber = ask.flow.questionOffset + 1;

  for (const step of ask.flow.steps) {
    questionNumber = appendCompletedStep(elements, step, questionNumber, locale);
  }

  if (!ask.settled) {
    appendActiveQuestions(elements, ask, questionNumber, actions, locale);
    appendCustomReplyHint(elements, locale);
  } else if (!completed) {
    elements.push({
      tag: 'note',
      elements: [{
        tag: 'plain_text',
        content: result?.kind === 'answered' && result.action === 'undo'
          ? t('card.ask.flow.restoring_previous', undefined, locale)
          : t('card.ask.flow.waiting_next', undefined, locale),
      }],
    });
  }

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: completed ? 'green' : 'blue',
      title: {
        tag: 'plain_text',
        content: completed
          ? t('card.ask.title_done', undefined, locale)
          : t('card.ask.title', undefined, locale),
      },
    },
    elements,
  });
}

/** 已完成步骤保留原问题，选中项高亮，所有按钮禁用。 */
function appendCompletedStep(
  elements: Array<Record<string, unknown>>,
  step: AskFlowStep,
  startNumber: number,
  locale: Locale,
): number {
  let number = startNumber;
  for (let index = 0; index < step.questions.length; index++) {
    if (number > startNumber || elements.length > 2) elements.push({ tag: 'hr' });
    const question = step.questions[index]!;
    appendQuestionTitle(elements, number, question.prompt, locale);
    const selected = step.result.kind === 'answered'
      ? new Set(step.result.answers[index] ?? [])
      : new Set<string>();
    appendActionRows(elements, question.options.map(option => ({
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: `${selected.has(option.key) ? '✅' : '○'} ${option.label}`,
      },
      type: selected.has(option.key) ? 'primary' : 'default',
      disabled: true,
    })));
    const selectedLabels = question.options
      .filter(option => selected.has(option.key))
      .map(option => option.label);
    if (selectedLabels.length > 0) {
      elements.push({
        tag: 'note',
        elements: [{
          tag: 'plain_text',
          content: `你的选择：${selectedLabels.join('、')}`,
        }],
      });
    }
    number++;
  }
  if (step.result.kind === 'answered' && step.result.comment?.trim()) {
    elements.push({
      tag: 'note',
      elements: [{
        tag: 'plain_text',
        content: `文字回复：${truncate(step.result.comment.trim(), 256, locale)}`,
      }],
    });
  }
  return number;
}

/** 当前步骤继续沿用原按钮协议，确保点击能 settle 当前 ask。 */
function appendActiveQuestions(
  elements: Array<Record<string, unknown>>,
  ask: PendingAsk,
  startNumber: number,
  actions: AskFlowActions,
  locale: Locale,
): void {
  const requiresSubmit = ask.questions.length > 1 || ask.questions.some(question => question.multiSelect);
  const selections = ask.selections ?? ask.questions.map(() => []);
  for (let index = 0; index < ask.questions.length; index++) {
    if (elements.length > 2) elements.push({ tag: 'hr' });
    const question = ask.questions[index]!;
    appendQuestionTitle(elements, startNumber + index, question.prompt, locale);
    const selected = new Set(selections[index] ?? []);
    appendActionRows(elements, question.options.map(option => ({
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
            question_index: String(index),
            key: option.key,
          }
        : {
            action: actions.select,
            ask_id: ask.askId,
            nonce: ask.nonce,
            key: option.key,
          },
    })));
  }
  if (requiresSubmit) {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.ask.submit', undefined, locale) },
        type: 'primary',
        value: { action: actions.submit, ask_id: ask.askId, nonce: ask.nonce },
      }],
    });
  }
  if (ask.flow && ask.flow.steps.length > 0) {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.ask.flow.undo_previous', undefined, locale) },
        type: 'default',
        value: { action: actions.undo, ask_id: ask.askId, nonce: ask.nonce },
      }],
    });
  }
}

function buildMeta(ask: PendingAsk, locale: Locale): Record<string, unknown> {
  const deadline = new Date(ask.deadlineAt).toLocaleString('zh-CN');
  const answerable = ask.approvers?.length
    ? t('card.ask.answerable_turn_callers', undefined, locale)
    : t('card.ask.answerable_talk_members', undefined, locale);
  return {
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
          content: `**${t('card.ask.field.answerable', undefined, locale)}**\n${escapeMd(answerable)}`,
        },
      },
    ],
  };
}

function appendQuestionTitle(
  elements: Array<Record<string, unknown>>,
  number: number,
  prompt: string,
  locale: Locale,
): void {
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**${t('card.ask.question_n', { n: number }, locale)}**\n${escapeMd(truncate(prompt, 512, locale))}`,
    },
  });
}

function appendCustomReplyHint(elements: Array<Record<string, unknown>>, locale: Locale): void {
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: t('card.ask.custom_reply_hint', undefined, locale) }],
  });
}

function appendActionRows(
  elements: Array<Record<string, unknown>>,
  buttons: Array<Record<string, unknown>>,
): void {
  for (let index = 0; index < buttons.length; index += MAX_BUTTONS_PER_ACTION_ROW) {
    elements.push({ tag: 'action', actions: buttons.slice(index, index + MAX_BUTTONS_PER_ACTION_ROW) });
  }
}

function optionLabel(multiSelect: boolean, selected: boolean, label: string): string {
  if (multiSelect) return `${selected ? '☑' : '☐'} ${label}`;
  return `${selected ? '◉' : '○'} ${label}`;
}

function truncate(value: string, maxChars: number, locale: Locale): string {
  if (value.length <= maxChars) return value || t('common.empty_paren', undefined, locale);
  return `${value.slice(0, maxChars)}\n\n${t('common.truncated_short', undefined, locale)}`;
}

function escapeMd(value: string): string {
  return value.replace(/[*_~`\[\]\\]/g, character => `\\${character}`);
}
