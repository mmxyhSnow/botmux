/**
 * In-memory broker for `botmux ask` (v0.1.8).
 *
 * Holds the pending-ask registry, runs the deadline timers, and arbitrates
 * click resolution. IM-agnostic: the im/lark side wires a dispatcher via
 * `setCardDispatcher` so the broker doesn't import Lark types.
 *
 * §3 / §6 / §7 / §8 of /tmp/botmux-ask.md.
 */

import { randomUUID } from 'node:crypto';

import { logger } from '../utils/logger.js';
import { createAskBrokerActions } from './ask-broker-actions.js';
import type {
  AskCardDispatcher,
  AskFlowStep,
  AskResult,
  CreateAskInput,
  PendingAsk,
} from './ask-types.js';
interface InternalPending extends Omit<PendingAsk, 'selections'> {
  resolve: (result: AskResult) => void;
  timeoutHandle: NodeJS.Timeout;
  /** epoch ms when settle ran; undefined while still pending. */
  settledAt?: number;
  /** 结算态卡片更新；最终完成态必须等待它结束，避免旧状态后写覆盖。 */
  settlePatch?: Promise<void>;
  /**
   * 按问题序号（questionIndex）累积的勾选 key 集合。
   * 单选问题（multiSelect:false）Set 内最多保留 1 个 key。
   * 多选问题（multiSelect:true）Set 内可保留任意个 key。
   */
  selections: Map<number, Set<string>>;
  /** 连续提问标识；具体历史集中保存在 flows，避免每个 ask 复制可变状态。 */
  flowId?: string;
}
const pending = new Map<string, InternalPending>();
interface InternalFlow {
  cardMessageId?: string;
  lastAskId?: string;
  questionOffset: number;
  steps: AskFlowStep[];
  previousSegment?: {
    cardMessageId: string;
    questionOffset: number;
    steps: AskFlowStep[];
  };
}
const flows = new Map<string, InternalFlow>();
const MAX_FLOW_QUESTIONS_PER_CARD = 5;
function flowKey(sessionId: string, flowId: string): string {
  return `${sessionId}\u0000${flowId}`;
}
let dispatcher: AskCardDispatcher | null = null;
/** IM-side canTalk predicate, wired by the daemon at bootstrap. Lets the broker
 *  honour the bot's canTalk gate without importing Lark types: whoever may
 *  address the bot in this chat may answer its `botmux ask`. Returns false until
 *  wired, so an unwired broker authorizes no one (daemon always wires it). */
let canTalkChecker: ((larkAppId: string, chatId: string, openId: string, chatType?: 'group' | 'p2p') => boolean) | null = null;
/** Wire the canTalk predicate. Called once during daemon bootstrap. */
export function setCanTalkChecker(
  fn: (larkAppId: string, chatId: string, openId: string, chatType?: 'group' | 'p2p') => boolean,
): void {
  canTalkChecker = fn;
}
/** A click is authorized iff the clicker may `canTalk` to the bot in this chat.
 *  `botmux ask` is a talk-level interaction (answering the agent's question),
 *  so it follows the canTalk gate — not the stricter canOperate / allowedUsers. */
function isAuthorizedToAnswer(ask: InternalPending, by: string): boolean {
  if (ask.approvers?.length && !ask.approvers.includes(by)) return false;
  return canTalkChecker?.(ask.larkAppId, ask.chatId, by, ask.chatType) ?? false;
}

/** Window during which a settled ask is still queryable so race-losers get a
 *  precise `already_settled` outcome (and the card click handler can show
 *  "已被 X 答了" instead of a generic "已失效"). After this window expires,
 *  late clicks fall through to `stale` like any forgotten id. */
const SETTLED_RETENTION_MS = 60_000;

/** Wire the IM-side dispatcher. Called once during daemon bootstrap from
 *  daemon.ts after im/lark/ask-card.ts is constructed. */
export function setCardDispatcher(d: AskCardDispatcher): void {
  dispatcher = d;
}

/** Register a new pending ask. Returns a Promise that settles when:
 *   - a valid click arrives (`kind:'answered'`)
 *   - the deadline elapses (`kind:'timedOut'`)
 *   - the broker invalidates the ask (`kind:'invalidated'`)
 *
 *  Side effects:
 *   - generates askId + nonce
 *   - starts the deadline timer
 *   - dispatches the card; if the card send fails, the ask is immediately
 *     invalidated and the Promise settles with `kind:'invalidated'`.
 *
 *  Throws synchronously only if no dispatcher has been wired — that's a
 *  daemon-misconfiguration bug, not a runtime ask failure.
 */
export function registerAsk(input: CreateAskInput): Promise<AskResult> {
  if (!dispatcher) {
    throw new Error('ask-broker: cardDispatcher not wired — daemon bootstrap bug');
  }

  const askId = randomUUID();
  const nonce = randomUUID().slice(0, 8);
  const createdAt = Date.now();
  const deadlineAt = createdAt + input.timeoutMs;
  let flow: InternalFlow | undefined;
  if (input.flowId) {
    const key = flowKey(input.sessionId, input.flowId);
    flow = flows.get(key);
    if (!flow) {
      flow = { questionOffset: 0, steps: [] };
      flows.set(key, flow);
    }
    const currentQuestionCount = flow.steps.reduce(
      (total, step) => total + step.questions.length,
      0,
    );
    if (
      currentQuestionCount > 0
      && currentQuestionCount + input.questions.length > MAX_FLOW_QUESTIONS_PER_CARD
    ) {
      if (flow.cardMessageId) {
        flow.previousSegment = {
          cardMessageId: flow.cardMessageId,
          questionOffset: flow.questionOffset,
          steps: flow.steps,
        };
      }
      flow.questionOffset += currentQuestionCount;
      flow.steps = [];
      flow.cardMessageId = undefined;
    }
  }

  return new Promise<AskResult>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      settle(askId, {
        kind: 'timedOut',
        selected: null,
        by: null,
        comment: null,
        timedOut: true,
      });
    }, input.timeoutMs);
    // Don't keep the event loop alive just because an ask is pending.
    timeoutHandle.unref?.();

    // 为每个问题初始化空的勾选集合
    const selections = new Map<number, Set<string>>();
    for (let i = 0; i < input.questions.length; i++) {
      selections.set(i, new Set<string>());
    }

    const ask: InternalPending = {
      askId,
      nonce,
      larkAppId: input.larkAppId,
      chatId: input.chatId,
      rootMessageId: input.rootMessageId,
      sessionId: input.sessionId,
      chatType: input.chatType,
      questions: input.questions,
      ...(input.approvers?.length ? { approvers: [...input.approvers] } : {}),
      ...(input.flowId ? { flowId: input.flowId } : {}),
      createdAt,
      deadlineAt,
      settled: false,
      resolve,
      timeoutHandle,
      selections,
    };
    pending.set(askId, ask);
    if (flow) flow.lastAskId = askId;

    // Card dispatch is async — store the messageId once it lands.
    void dispatcher!
      .send(snapshot(ask))
      .then(({ messageId }) => {
        const cur = pending.get(askId);
        if (cur) {
          cur.cardMessageId = messageId;
          if (cur.flowId) {
            const flow = flows.get(flowKey(cur.sessionId, cur.flowId));
            // 飞书卡已可点击时，回调可能先于发送 Promise 的 then 结算 ASK。
            // 即使本问已经 settled，也要保存卡片身份供同一 flow 的下一问复用。
            if (flow && flow.lastAskId === askId) {
              flow.cardMessageId = messageId;
              flow.previousSegment = undefined;
            }
          }
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn?.(`ask-broker: ${askId} card dispatch failed: ${msg}`);
        settle(askId, {
          kind: 'invalidated',
          reason: `card dispatch failed: ${msg}`,
          selected: null,
          by: null,
          comment: null,
          timedOut: false,
        });
      });
  });
}

/**
 * 按话题 anchor 查找一个**未 settle**的 pending ask，供 daemon 判断「这条文字回复
 * 是不是在回答某个 ask」。匹配条件：
 *   - larkAppId 相同（不跨 bot 命中）
 *   - chatId 相同
 *   - thread-scope：ask.rootMessageId === anchor（话题根 message_id）
 *   - chat-scope：ask.rootMessageId === null（anchor 实为 chatId，已由 chatId 命中）
 *
 * 命中多个时返回最先注册的（实践中同一 anchor 同时最多一个 pending ask，因为发起
 * ask 的 CLI 此刻正阻塞等待结果）。返回 snapshot，改它不影响 broker 状态。
 */
export function findPendingAskByAnchor(args: {
  larkAppId: string;
  chatId: string;
  anchor: string;
}): PendingAsk | undefined {
  for (const ask of pending.values()) {
    if (ask.settled) continue;
    if (ask.larkAppId !== args.larkAppId) continue;
    if (ask.chatId !== args.chatId) continue;
    const matches =
      ask.rootMessageId === null ? true : ask.rootMessageId === args.anchor;
    if (matches) return snapshot(ask);
  }
  return undefined;
}

/**
 * 使所有待答 ASK 失效，供 daemon 关闭或重启时解除 CLI 子进程等待。
 *
 * 返回本次实际结算的数量；竞态窗口里已结算但仍保留的记录会被跳过。
 */
export function invalidateAll(reason: string): number {
  const ids = [...pending.entries()]
    .filter(([, ask]) => !ask.settled)
    .map(([id]) => id);
  for (const id of ids) {
    settle(id, {
      kind: 'invalidated',
      reason,
      selected: null,
      by: null,
      comment: null,
      timedOut: false,
    });
  }
  if (ids.length > 0) {
    logger.info?.(`ask-broker: invalidated ${ids.length} pending ask(s): ${reason}`);
  }
  return ids.length;
}

/**
 * 使所有待答 ASK 失效，并等待对应卡片完成失效态回写。
 *
 * daemon 关闭时必须先完成这一步，再断开飞书回调服务，避免群里留下仍可点击、
 * 点击后却只提示“目标回调服务当前未在线”的旧卡片。等待有上限，防止飞书接口
 * 异常时阻塞进程退出。
 */
export async function invalidateAllAndWait(
  reason: string,
  timeoutMs = 2_000,
): Promise<number> {
  const activeAsks = [...pending.values()].filter(ask => !ask.settled);
  const invalidatedCount = invalidateAll(reason);
  const settlePatches = activeAsks
    .map(ask => ask.settlePatch)
    .filter((patch): patch is Promise<void> => patch !== undefined);
  if (settlePatches.length === 0) return invalidatedCount;

  let timeoutHandle: NodeJS.Timeout | undefined;
  const completed = await Promise.race([
    Promise.allSettled(settlePatches).then(() => true),
    new Promise<boolean>(resolve => {
      timeoutHandle = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
      timeoutHandle.unref?.();
    }),
  ]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (!completed) {
    logger.warn?.(
      `ask-broker: timed out after ${timeoutMs}ms waiting for `
      + `${settlePatches.length} invalidated card patch(es)`,
    );
  }
  return invalidatedCount;
}

/** 只结算一次；保留短期终态供重复点击返回精确结果。 */
function settle(askId: string, result: AskResult): void {
  const ask = pending.get(askId);
  if (!ask || ask.settled) return;
  ask.settled = true;
  ask.settledAt = Date.now();
  clearTimeout(ask.timeoutHandle);
  if (ask.flowId) {
    const flow = flows.get(flowKey(ask.sessionId, ask.flowId));
    if (flow) {
      if (result.kind === 'answered' && result.action === 'undo') {
        flow.steps.pop();
      } else {
        flow.steps.push({
          questions: ask.questions.map(question => ({
            ...question,
            options: question.options.map(option => ({ ...option })),
          })),
          result,
        });
      }
    }
  }
  // 顺便清理旧终态，避免为极小集合单独维护 GC 定时器。
  gcSettled();

  if (dispatcher?.onSettle) {
    try {
      ask.settlePatch = Promise.resolve(dispatcher.onSettle(snapshot(ask), result)).catch((err) => {
        logger.warn?.(
          `ask-broker: ${askId} onSettle failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } catch (err) {
      logger.warn?.(
        `ask-broker: ${askId} onSettle threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  try {
    ask.resolve(result);
  } catch (err) {
    logger.warn?.(
      `ask-broker: ${askId} resolve threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** 移除 broker 内部字段后再交给 IM 层。 */
function snapshot(ask: InternalPending): PendingAsk {
  const {
    resolve: _r,
    timeoutHandle: _t,
    settledAt: _sat,
    settlePatch: _sp,
    selections: _sel,
    flowId: _flowId,
    ...rest
  } = ask;
  const flow = ask.flowId ? flows.get(flowKey(ask.sessionId, ask.flowId)) : undefined;
  return {
    ...rest,
    selections: ask.questions.map((_, i) => [...(ask.selections.get(i) ?? new Set<string>())]),
    ...(ask.flowId && flow
      ? {
          flow: {
            flowId: ask.flowId,
            ...(flow.cardMessageId ? { cardMessageId: flow.cardMessageId } : {}),
            questionOffset: flow.questionOffset,
            steps: flow.steps.map(step => ({
              questions: step.questions.map(question => ({
                ...question,
                options: question.options.map(option => ({ ...option })),
              })),
              result: step.result,
            })),
            ...(flow.previousSegment
              ? {
                  previousSegment: {
                    cardMessageId: flow.previousSegment.cardMessageId,
                    questionOffset: flow.previousSegment.questionOffset,
                    steps: flow.previousSegment.steps.map(step => ({
                      questions: step.questions.map(question => ({
                        ...question,
                        options: question.options.map(option => ({ ...option })),
                      })),
                      result: step.result,
                    })),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

/** 清理超过保留窗口的终态；集合通常只有几十项。 */
function gcSettled(): void {
  const cutoff = Date.now() - SETTLED_RETENTION_MS;
  for (const [id, ask] of pending) {
    if (ask.settled && ask.settledAt !== undefined && ask.settledAt < cutoff) {
      pending.delete(id);
    }
  }
}

// ---- diagnostics for tests ---------------------------------------------------

/** Count of asks still awaiting a click / timeout — excludes settled entries
 *  retained within the race-loser feedback window. For tests and metrics only. */
export function _pendingCount(): number {
  let n = 0;
  for (const ask of pending.values()) if (!ask.settled) n++;
  return n;
}

/** Read a pending ask by id. Returns a snapshot; mutating it has no effect on
 *  broker state. Used by the card handler to PATCH toggle state. */
export function getAskSnapshot(askId: string): PendingAsk | undefined {
  const a = pending.get(askId);
  return a ? snapshot(a) : undefined;
}

/** List unsettled asks for Desktop / dashboard aggregation (read-only snapshots). */
export function listPendingAsks(): PendingAsk[] {
  gcSettled();
  const out: PendingAsk[] = [];
  for (const ask of pending.values()) {
    if (!ask.settled) out.push(snapshot(ask));
  }
  return out;
}

/** Codex turn 完成时，按 flowId 把最后一段卡片切换为完成态。 */
export async function completeAskFlow(flowId: string, sessionId: string): Promise<boolean> {
  const key = flowKey(sessionId, flowId);
  const flow = flows.get(key);
  const ask = flow?.lastAskId ? pending.get(flow.lastAskId) : undefined;
  if (!flow || !ask || !ask.settled || !dispatcher?.completeFlow) return false;
  await ask.settlePatch;
  await dispatcher.completeFlow(snapshot(ask));
  flows.delete(key);
  return true;
}

/** 用户动作与状态仓解耦；对外导出名称保持兼容。 */
export const {
  toggleAsk,
  submitAsk,
  submitCustomReply,
  submitUndoAsk,
  tryResolveAsk,
  submitAskFromDesktop,
} = createAskBrokerActions({
  gc: gcSettled,
  getAsk: askId => pending.get(askId),
  isAuthorized: (ask, by) => isAuthorizedToAnswer(ask as InternalPending, by),
  settle,
  hasFlowSteps: ask => !!ask.flowId
    && (flows.get(flowKey(ask.sessionId, ask.flowId))?.steps.length ?? 0) > 0,
});

/** Read a pending ask by id — for tests only. Returns a snapshot; mutating it
 *  has no effect on broker state. */
export function _getPending(askId: string): PendingAsk | undefined {
  return getAskSnapshot(askId);
}

/** 返回当前 pending map 中所有 askId 列表（含 settled 但仍在 retention 内的条目）。
 *  仅供测试使用。 */
export function _allAskIds(): string[] {
  return [...pending.keys()];
}

/** Reset broker state — for tests only. Does NOT resolve outstanding promises,
 *  so tests must not call this while real CLI processes might be waiting. */
export function _resetForTest(): void {
  for (const ask of pending.values()) clearTimeout(ask.timeoutHandle);
  pending.clear();
  flows.clear();
  dispatcher = null;
  canTalkChecker = null;
}
