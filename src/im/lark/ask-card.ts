import { randomUUID } from 'node:crypto';
import type {
  AskCardDispatcher,
  AskClickOutcome,
  AskResult,
  PendingAsk,
} from '../../core/ask-types.js';
import type { AskReminderPolicy } from '../../bot-registry.js';
import {
  findPendingAskByAnchor,
  getAskSnapshot,
  replaceAskCardProjection,
  submitAsk,
  submitUndoAsk,
  toggleAsk,
  tryResolveAsk,
} from '../../core/ask-broker.js';
import { logger } from '../../utils/logger.js';
import { t, localeForBot, type Locale } from '../../i18n/index.js';
import { replyMessage, sendMessage, updateMessage } from './client.js';
import {
  buildAskFlowCard,
  buildPreviousAskFlowSegmentCard,
} from './ask-card-flow.js';
import { renderAskCard } from './ask-card-render.js';
import {
  cancelAskApproverFollowups,
  scheduleAskApproverFollowups,
} from './ask-card-notification.js';

/** 旧单选即答动作（保留兼容旧卡片回调；Task 5 新增 ask_submit 路径）。 */
export const ASK_SELECT_ACTION = 'ask_select';

/** 新多问 Submit 动作（form 内提交按钮携带此 action）。 */
export const ASK_SUBMIT_ACTION = 'ask_submit';

/** 累积勾选动作。飞书会 silent-drop form + select_static，所以 v0.1.8 用按钮态。 */
export const ASK_TOGGLE_ACTION = 'ask_toggle';

/** 连续提问撤销最近一步动作。 */
export const ASK_UNDO_ACTION = 'ask_undo';
const FLOW_ACTIONS = {
  select: ASK_SELECT_ACTION,
  submit: ASK_SUBMIT_ACTION,
  toggle: ASK_TOGGLE_ACTION,
  undo: ASK_UNDO_ACTION,
};
const ASK_CARD_REPROJECT_DELAY_MS = 1_200;
const askCardProjectionTimers = new Map<string, NodeJS.Timeout>();
export interface AskCardActionData {
  operator?: { open_id?: string };
  action?: {
    value?: Record<string, unknown>;
    form_value?: Record<string, unknown>;
  };
}

export interface AskCardDispatcherDeps {
  sendMessage?: typeof sendMessage;
  replyMessage?: typeof replyMessage;
  updateMessage?: typeof updateMessage;
  /** ASK 提醒策略读取器；生产默认读取 bot 热配置，测试可定向覆盖。 */
  resolveAskReminderPolicy?: (larkAppId: string) => AskReminderPolicy;
  /** 话题列表第二行模式的 ASK 卡片标题投影。 */
  resolveTopicStatusTitle?: (ask: PendingAsk, waiting: boolean) => string | undefined;
  /** 把 ASK 等待生命周期同步给机器人根消息。 */
  onWaitingChange?: (ask: PendingAsk, waiting: boolean) => void | Promise<void>;
}

/** 用于判断一条外部机器人消息是否遮挡当前 ASK 的最小路由信息。 */
export interface AskCardBotActivity {
  larkAppId: string;
  chatId: string;
  rootMessageId?: string;
  inThread: boolean;
}

function buildMovedAskCard(): string {
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    body: {
      elements: [{
        tag: 'div',
        text: { tag: 'lark_md', content: '这张待操作卡已移至下方最新位置。' },
      }],
    },
  });
}

/** 在话题状态标题中保留 ASK 身份，不改动按钮和回调语义。 */
function withTopicStatusTitle(cardJson: string, title?: string): string {
  if (!title) return cardJson;
  try {
    const card = JSON.parse(cardJson) as Record<string, any>;
    const [rawStatus, ...taskParts] = title.split('｜');
    const status = rawStatus?.trim() ?? '';
    const statusMatch = status.match(/^(\S+)\s+(.+)$/u);
    const icon = statusMatch?.[1] ?? '🙋';
    const label = statusMatch?.[2] ?? status;
    const task = taskParts.join('｜').trim();
    card.header ??= {};
    card.header.title = {
      tag: 'plain_text',
      content: `${icon} ASK｜${label}${task ? ` · ${task}` : ''}`,
    };
    return JSON.stringify(card);
  } catch {
    return cardJson;
  }
}

/**
 * 外部机器人消息遮挡 ASK 时，在同一会话安静后新发当前问题并让旧投影失效。
 * 新旧卡共享 askId/nonce，但 projectionId 只认可最新值，避免旧卡继续改写多选状态。
 */
export function noteAskCardBotActivity(
  activity: AskCardBotActivity,
  deps: AskCardDispatcherDeps = {},
): void {
  const anchor = activity.inThread ? activity.rootMessageId : activity.chatId;
  if (!anchor) return;
  const ask = findPendingAskByAnchor({
    larkAppId: activity.larkAppId,
    chatId: activity.chatId,
    anchor,
  });
  if (!ask?.cardMessageId || ask.settled) return;

  const previousTimer = askCardProjectionTimers.get(ask.askId);
  if (previousTimer) clearTimeout(previousTimer);
  const timer = setTimeout(() => {
    askCardProjectionTimers.delete(ask.askId);
    const current = getAskSnapshot(ask.askId);
    if (!current?.cardMessageId || current.settled) return;
    const nextProjectionId = randomUUID();
    const projected = { ...current, projectionId: nextProjectionId };
    const send = deps.sendMessage ?? sendMessage;
    const reply = deps.replyMessage ?? replyMessage;
    const update = deps.updateMessage ?? updateMessage;
    const cardJson = withTopicStatusTitle(
      buildAskCard(projected),
      deps.resolveTopicStatusTitle?.(projected, true),
    );
    const canReplyToRoot = typeof current.rootMessageId === 'string'
      && current.rootMessageId.startsWith('om_');
    void (async () => {
      const messageId = canReplyToRoot
        ? await reply(current.larkAppId, current.rootMessageId!, cardJson, 'interactive', true)
        : await send(current.larkAppId, current.chatId, cardJson, 'interactive');
      const replaced = replaceAskCardProjection({
        askId: current.askId,
        expectedProjectionId: current.projectionId,
        projectionId: nextProjectionId,
        messageId,
      });
      if (!replaced) {
        await update(current.larkAppId, messageId, buildMovedAskCard());
        return;
      }
      try {
        await update(current.larkAppId, current.cardMessageId!, buildMovedAskCard());
      } catch (error) {
        // projectionId 已切换，旧卡视觉更新失败也只会得到 stale 回调。
        logger.warn(`[ask:${current.askId}] failed to retire previous projection: ${
          error instanceof Error ? error.message : String(error)
        }`);
      }
    })().catch(error => {
      logger.warn(`[ask:${current.askId}] failed to move actionable card latest: ${
        error instanceof Error ? error.message : String(error)
      }`);
    });
  }, ASK_CARD_REPROJECT_DELAY_MS);
  timer.unref?.();
  askCardProjectionTimers.set(ask.askId, timer);
}

export function createLarkAskCardDispatcher(
  deps: AskCardDispatcherDeps = {},
): AskCardDispatcher {
  const send = deps.sendMessage ?? sendMessage;
  const reply = deps.replyMessage ?? replyMessage;
  const update = deps.updateMessage ?? updateMessage;

  return {
    async send(ask) {
      const cardJson = withTopicStatusTitle(
        buildAskCard(ask),
        deps.resolveTopicStatusTitle?.(ask, true),
      );
      const previous = buildPreviousAskFlowSegmentCard(ask, FLOW_ACTIONS);
      if (previous) {
        try {
          await update(ask.larkAppId, previous.messageId, previous.cardJson);
        } catch (err) {
          logger.warn(`[ask:${ask.askId}] failed to close previous flow segment: ${
            err instanceof Error ? err.message : String(err)
          }`);
        }
      }
      // botmux 把 chat-scope session 的 routing anchor 也叫 rootMessageId,
      // 但在 chat-scope 下它实际是 chat_id (oc_...) 而非 message_id (om_...).
      // 飞书 /messages/{id}/reply 只接受 om_ — 用 oc_ 会 400 invalid message_id.
      // 所以这里要按前缀判断是否真的能 reply.
      const canReplyToRoot = typeof ask.rootMessageId === 'string'
        && ask.rootMessageId.startsWith('om_');
      let messageId: string;
      if (ask.flow?.cardMessageId) {
        await update(ask.larkAppId, ask.flow.cardMessageId, cardJson);
        messageId = ask.flow.cardMessageId;
      } else {
        messageId = canReplyToRoot
          ? await reply(ask.larkAppId, ask.rootMessageId!, cardJson, 'interactive', true)
          : await send(ask.larkAppId, ask.chatId, cardJson, 'interactive');
      }
      // 卡片内已直接 @ 本轮提问对象，发卡后不再重复发送独立即时 @。
      // 普通 ASK 与连续提问统一从发卡成功后开始延后提醒节拍。
      if (ask.approvers?.length) {
        const noticeDeps = {
          canReplyToRoot,
          reply,
          send,
          resolvePolicy: deps.resolveAskReminderPolicy,
        };
        scheduleAskApproverFollowups(ask, noticeDeps);
      }
      if (deps.onWaitingChange) await deps.onWaitingChange(ask, true);
      return { messageId };
    },
    async onSettle(ask, result) {
      cancelAskApproverFollowups(ask.askId);
      if (deps.onWaitingChange) await deps.onWaitingChange(ask, false);
      if (!ask.cardMessageId) return;
      try {
        await update(
          ask.larkAppId,
          ask.cardMessageId,
          withTopicStatusTitle(
            buildAskCard(ask, result),
            deps.resolveTopicStatusTitle?.(ask, false),
          ),
        );
      } catch (err) {
        logger.warn(
          `[ask:${ask.askId}] failed to patch settled card: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    async completeFlow(ask) {
      const messageId = ask.flow?.cardMessageId;
      if (!messageId) return;
      const cardJson = buildAskFlowCard(ask, FLOW_ACTIONS, undefined, true);
      if (!cardJson) return;
      await update(ask.larkAppId, messageId, cardJson);
    },
  };
}

export function isAskCardAction(action?: string): boolean {
  return action === ASK_SELECT_ACTION
    || action === ASK_SUBMIT_ACTION
    || action === ASK_TOGGLE_ACTION
    || action === ASK_UNDO_ACTION;
}

export async function handleAskCardAction(
  data: AskCardActionData,
): Promise<{ toast: { type: string; content: string } } | Record<string, unknown> | undefined> {
  const value = data.action?.value;
  const action = asString(value?.action);
  if (!isAskCardAction(action)) return undefined;

  const askId = asString(value?.ask_id);
  const nonce = asString(value?.nonce);
  const projectionId = asString(value?.projection_id);
  const by = data.operator?.open_id;
  // Resolve the bot locale from the pending ask (best-effort — a stale/missing
  // ask falls back to the process-default locale).
  const locale = localeForBot(askId ? getAskSnapshot(askId)?.larkAppId : undefined);
  if (!askId || !nonce || !by) {
    return staleToast(locale);
  }
  const currentAsk = getAskSnapshot(askId);
  // 旧进程生成的卡片没有 projection_id；ASK 本就不跨 daemon 恢复，因此只为兼容
  // 当前进程内的旧测试/嵌入方放行缺字段，新版旧投影一定携带字段并会严格失效。
  if (!currentAsk || (projectionId && currentAsk.projectionId !== projectionId)) return staleToast(locale);

  if (action === ASK_UNDO_ACTION) {
    const outcome = submitUndoAsk({ askId, nonce, by });
    if (outcome !== 'accepted') return toastForOutcome(outcome, locale);
    return settledCardResponse(askId, {
      kind: 'answered',
      answers: getAskSnapshot(askId)?.questions.map(() => []) ?? [],
      by,
      comment: null,
      action: 'undo',
      timedOut: false,
    });
  }

  // 旧单选即答路径：按钮直接携带 key，调用 tryResolveAsk（单问单选便捷封装）。
  // accepted 时直接返回终态卡片，让飞书在回调响应里同步替换——不依赖 onSettle 异步 PATCH
  // （异步 PATCH 在飞书侧常因回调已返回而被忽略，导致卡片停在未作答态）。
  if (action === ASK_SELECT_ACTION) {
    const selected = asString(value?.key);
    if (!selected) return staleToast(locale);
    const outcome = tryResolveAsk({ askId, nonce, selected, by });
    if (outcome !== 'accepted') return toastForOutcome(outcome, locale);
    return settledCardResponse(askId, {
      kind: 'answered',
      answers: [[selected]],
      by,
      comment: null,
      timedOut: false,
    });
  }

  if (action === ASK_TOGGLE_ACTION) {
    const questionIndex = asNumber(value?.question_index);
    const key = asString(value?.key);
    if (!Number.isInteger(questionIndex) || !key) return staleToast(locale);
    const outcome = toggleAsk({ askId, nonce, questionIndex, key, by });
    if (outcome !== 'toggled') return toastForOutcome(outcome, locale);
    const updated = getAskSnapshot(askId);
    if (!updated) return staleToast(locale);
    return JSON.parse(buildAskCard(updated)) as Record<string, unknown>;
  }

  // 新 Submit 路径：优先从按钮累积态提交；兼容旧 form_value 回调。
  // 同 ASK_SELECT_ACTION：accepted 时同步返回终态卡片。
  if (action === ASK_SUBMIT_ACTION) {
    const formValue = data.action?.form_value ?? {};
    if (Object.keys(formValue).length > 0) {
      // 推断问题数量：找最大 qN 的 N+1
      const questionCount = guessQuestionCount(formValue);
      const selections = parseFormSelections(formValue, questionCount);
      const outcome = submitAsk({ askId, nonce, by, selections });
      if (outcome !== 'accepted') return toastForOutcome(outcome, locale);
      return settledCardResponse(askId, {
        kind: 'answered',
        answers: selections,
        by,
        comment: null,
        timedOut: false,
      });
    }
    const outcome = submitAsk({ askId, nonce, by });
    if (outcome !== 'accepted') return toastForOutcome(outcome, locale);
    const updated = getAskSnapshot(askId);
    const answers = updated?.selections ?? updated?.questions.map(() => []) ?? [];
    return settledCardResponse(askId, {
      kind: 'answered',
      answers,
      by,
      comment: null,
      timedOut: false,
    });
  }

  return staleToast(locale);
}

/**
 * 构建 settled 终态卡片响应，让飞书在卡片回调响应里**同步**替换原卡片。
 *
 * 为什么需要这个：ASK_SELECT / ASK_SUBMIT 成功 settle 后，若只返回 `undefined`
 * （toastForOutcome('accepted')），飞书不会原地更新卡片，只能依赖 settle() 里
 * dispatcher.onSettle 异步调 updateMessage 去 PATCH——但异步 PATCH 在飞书侧常因
 * 回调响应已返回而被忽略/时序竞争，导致卡片停在未作答态。
 * 这里直接返回终态卡片 JSON，飞书在同一次回调响应里替换，与 ASK_TOGGLE / grant
 * card 的同步替换路径一致。onSettle 仍保留作兜底（双重更新同内容，幂等无害）。
 */
function settledCardResponse(askId: string, result: AskResult): Record<string, unknown> | undefined {
  const updated = getAskSnapshot(askId);
  if (!updated) return undefined;
  return JSON.parse(buildAskCard(updated, result)) as Record<string, unknown>;
}

/** 对外保留旧渲染入口，具体卡片结构由纯渲染模块生成。 */
export function buildAskCard(ask: PendingAsk, result?: AskResult): string {
  return renderAskCard(ask, FLOW_ACTIONS, result);
}

/**
 * 从 form_value 中推断问题数量（取最大 qN 索引 + 1，最少 1）。
 */
function guessQuestionCount(formValue: Record<string, unknown>): number {
  let max = -1;
  for (const key of Object.keys(formValue)) {
    const m = key.match(/^q(\d+)$/);
    if (m) {
      const idx = parseInt(m[1]!, 10);
      if (idx > max) max = idx;
    }
  }
  return max >= 0 ? max + 1 : 1;
}

/**
 * 防御式解析 Lark form_value，将每个 q<i> 字段的编码选项解析为选中 key 数组。
 *
 * 字段值可能为：
 *  - string[]（multi_select_static 多选）
 *  - string（select_static 单选，或 comma/semicolon 分隔的字符串）
 *
 * 每个编码值格式为 `<questionIndex>::<key>`，只收集 prefix 匹配的条目并剥去前缀。
 * 导出供单元测试直接调用。
 */
export function parseFormSelections(
  formValue: Record<string, unknown>,
  questionCount: number,
): string[][] {
  const result: string[][] = [];
  for (let i = 0; i < questionCount; i++) {
    const raw = formValue[`q${i}`];
    // 规范化为字符串数组
    let tokens: string[];
    if (Array.isArray(raw)) {
      tokens = raw.filter((v): v is string => typeof v === 'string');
    } else if (typeof raw === 'string') {
      // 逗号或分号分隔的备用格式
      tokens = raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    } else {
      tokens = [];
    }
    // 筛选出 prefix 匹配 `i::` 的 token，剥去前缀取 key
    const prefix = `${i}::`;
    const keys = tokens
      .filter((t) => t.startsWith(prefix))
      .map((t) => t.slice(prefix.length));
    result.push(keys);
  }
  return result;
}

function toastForOutcome(outcome: AskClickOutcome, locale?: Locale): { toast: { type: string; content: string } } | undefined {
  switch (outcome) {
    case 'accepted':
      return undefined;
    case 'unauthorized':
      return { toast: { type: 'warning', content: t('card.ask.toast.unauthorized', undefined, locale) } };
    case 'already_settled':
      return { toast: { type: 'info', content: t('card.ask.toast.already_settled', undefined, locale) } };
    case 'stale':
      return staleToast(locale);
    case 'toggled':
      // 累积勾选，不弹 toast
      return undefined;
  }
}

function staleToast(locale?: Locale): { toast: { type: string; content: string } } {
  return { toast: { type: 'warning', content: t('card.ask.toast.stale', undefined, locale) } };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}
