/**
 * Codex 连续提问卡片渲染。
 *
 * 历史答案由 ask broker 提供只读快照；本模块把已完成问题压缩为有界摘要，
 * 只完整绘制当前问题，避免连续追问让飞书客户端自动折叠整张卡片。
 */
import type {
  AskFlowStep,
  AskResult,
  PendingAsk,
} from '../../core/ask-types.js';
import { localeForBot, t, type Locale } from '../../i18n/index.js';
import { buildAskAnswerableContent } from './ask-card-meta.js';

export interface AskFlowActions {
  select: string;
  submit: string;
  toggle: string;
  undo: string;
}

const MAX_BUTTONS_PER_ACTION_ROW = 4;
const MAX_VISIBLE_HISTORY_QUESTIONS = 3;

/**
 * 兼容原分段调用入口，但不再生成上一张完成卡。
 * broker 会把旧 messageId 暂存在 previousSegment；将它复制到本次只读快照后，
 * dispatcher 会走原有 updateMessage 分支，从而继续复用同一张 ASK 卡片。
 */
export function buildPreviousAskFlowSegmentCard(
  ask: PendingAsk,
  _actions: AskFlowActions,
): { messageId: string; cardJson: string } | undefined {
  const previous = ask.flow?.previousSegment;
  if (!previous || !ask.flow) return undefined;
  ask.flow.cardMessageId = previous.cardMessageId;
  return undefined;
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
  const elements: Array<Record<string, unknown>> = [buildMeta(ask, locale)];
  let questionNumber = ask.flow.questionOffset + 1;

  appendHistorySummary(elements, ask, locale);
  elements.push({ tag: 'hr' });
  questionNumber += ask.flow.steps.reduce(
    (total, step) => total + step.questions.length,
    0,
  );

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

/**
 * 把历史答案压成单个文本组件，最多展示最近三问，其余只保留完成数量。
 * broker 的 previousSegment 只在跨越五问边界时短暂存在；这里同时读取它，
 * 让边界上的下一问仍更新原 cardMessageId，而不新发第二张卡片。
 */
function appendHistorySummary(
  elements: Array<Record<string, unknown>>,
  ask: PendingAsk,
  locale: Locale,
): void {
  const flow = ask.flow;
  if (!flow) return;
  const currentQuestionCount = countQuestions(flow.steps);
  const totalCompleted = flow.previousSegment
    ? flow.questionOffset
    : flow.questionOffset + currentQuestionCount;
  if (totalCompleted === 0) return;

  const source = flow.previousSegment ?? {
    questionOffset: flow.questionOffset,
    steps: flow.steps,
  };
  const entries = historyEntries(source.steps, source.questionOffset + 1, locale);
  const visible = entries.slice(-MAX_VISIBLE_HISTORY_QUESTIONS);
  const omitted = totalCompleted - visible.length;
  const lines = [
    `**历史回答（${totalCompleted}）**`,
    ...(omitted > 0 ? [`另有 ${omitted} 问已完成`] : []),
    ...visible,
  ];
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: lines.join('\n') },
  });
}

/** 将 broker 历史步骤转换为单行答案；不重复问题正文和未选选项。 */
function historyEntries(
  steps: ReadonlyArray<AskFlowStep>,
  startNumber: number,
  locale: Locale,
): string[] {
  const entries: string[] = [];
  let number = startNumber;
  for (const step of steps) {
    for (let index = 0; index < step.questions.length; index++) {
      entries.push(`问题 ${number}：${answerSummary(step, index, locale)}`);
      number++;
    }
  }
  return entries;
}

/** 为单个历史问题生成稳定、紧凑的结果文本。 */
function answerSummary(step: AskFlowStep, questionIndex: number, locale: Locale): string {
  if (step.result.kind === 'timedOut') return '已超时';
  if (step.result.kind === 'invalidated') return '已失效';
  const question = step.questions[questionIndex];
  const selected = step.result.answers[questionIndex] ?? [];
  const labels = selected.map(key => question?.options.find(option => option.key === key)?.label ?? key);
  if (labels.length > 0) return truncate(labels.join('、'), 96, locale);
  if (step.result.comment?.trim()) return truncate(step.result.comment.trim(), 96, locale);
  return '已作答';
}

/** 统计一个连续提问片段中已完成的问题数。 */
function countQuestions(steps: ReadonlyArray<AskFlowStep>): number {
  return steps.reduce((total, step) => total + step.questions.length, 0);
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
    if (index > 0) elements.push({ tag: 'hr' });
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
    })));
  }
  if (requiresSubmit) {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.ask.submit', undefined, locale) },
        type: 'primary',
        value: { action: actions.submit, ask_id: ask.askId, nonce: ask.nonce, projection_id: ask.projectionId },
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
        value: { action: actions.undo, ask_id: ask.askId, nonce: ask.nonce, projection_id: ask.projectionId },
      }],
    });
  }
}

function buildMeta(ask: PendingAsk, locale: Locale): Record<string, unknown> {
  const deadline = new Date(ask.deadlineAt).toLocaleString('zh-CN');
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
          content: `**${t('card.ask.field.answerable', undefined, locale)}**\n${buildAskAnswerableContent(ask, locale)}`,
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
