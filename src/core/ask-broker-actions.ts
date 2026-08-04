/**
 * ask broker 的用户动作实现。
 *
 * 状态存储、授权和结算由 broker 通过窄接口注入；本模块只处理选项校验、
 * 勾选变化、文字回复、撤销与桌面端提交，避免核心状态文件继续膨胀。
 */
import type {
  AskClickOutcome,
  AskQuestion,
  AskResult,
} from './ask-types.js';

interface ActionAsk {
  askId: string;
  nonce: string;
  sessionId: string;
  questions: ReadonlyArray<AskQuestion>;
  selections: Map<number, Set<string>>;
  settled: boolean;
  flowId?: string;
}

/** 文字作答携带的可选发送者上下文，供 broker 复用完整 talk 判定。 */
export interface AskAuthorizationActor {
  botSender?: boolean;
  senderUnionId?: string;
  memberUnionId?: string;
}

interface AskBrokerActionContext {
  gc(): void;
  getAsk(askId: string): ActionAsk | undefined;
  isAuthorized(ask: ActionAsk, by: string, actor?: AskAuthorizationActor): boolean;
  settle(askId: string, result: AskResult): void;
  hasFlowSteps(ask: ActionAsk): boolean;
}

export interface AskBrokerActions {
  toggleAsk(args: {
    askId: string;
    nonce: string;
    questionIndex: number;
    key: string;
    by: string;
  }): AskClickOutcome;
  submitAsk(args: {
    askId: string;
    nonce: string;
    by: string;
    selections?: ReadonlyArray<ReadonlyArray<string>>;
  }): AskClickOutcome;
  submitCustomReply(args: {
    askId: string;
    by: string;
    text: string;
    actor?: AskAuthorizationActor;
  }): AskClickOutcome;
  submitUndoAsk(args: { askId: string; nonce: string; by: string }): AskClickOutcome;
  tryResolveAsk(args: {
    askId: string;
    nonce: string;
    selected: string;
    by: string;
  }): AskClickOutcome;
  submitAskFromDesktop(args: {
    askId: string;
    selections: ReadonlyArray<ReadonlyArray<string>>;
    by?: string;
  }): AskClickOutcome;
}

/** 创建绑定到单个 broker 状态仓的动作集合。 */
export function createAskBrokerActions(context: AskBrokerActionContext): AskBrokerActions {
  function pendingAuthorized(
    askId: string,
    by: string,
    nonce?: string,
    actor?: AskAuthorizationActor,
  ): ActionAsk | AskClickOutcome {
    context.gc();
    const ask = context.getAsk(askId);
    if (!ask) return 'stale';
    if (nonce !== undefined && ask.nonce !== nonce) return 'stale';
    if (ask.settled) return 'already_settled';
    if (!context.isAuthorized(ask, by, actor)) return 'unauthorized';
    return ask;
  }

  function toggleAsk(args: Parameters<AskBrokerActions['toggleAsk']>[0]): AskClickOutcome {
    const checked = pendingAuthorized(args.askId, args.by, args.nonce);
    if (typeof checked === 'string') return checked;
    const question = checked.questions[args.questionIndex];
    if (!question?.options.some(option => option.key === args.key)) return 'stale';
    const selected = checked.selections.get(args.questionIndex);
    if (!selected) return 'stale';
    if (question.multiSelect) {
      if (selected.has(args.key)) selected.delete(args.key);
      else selected.add(args.key);
    } else {
      selected.clear();
      selected.add(args.key);
    }
    return 'toggled';
  }

  function submitAsk(args: Parameters<AskBrokerActions['submitAsk']>[0]): AskClickOutcome {
    const checked = pendingAuthorized(args.askId, args.by, args.nonce);
    if (typeof checked === 'string') return checked;
    const answers = args.selections ?? checked.questions.map(
      (_question, index) => [...(checked.selections.get(index) ?? new Set<string>())],
    );
    for (let index = 0; index < checked.questions.length; index++) {
      const question = checked.questions[index]!;
      const selected = answers[index] ?? [];
      if (!question.multiSelect && selected.length !== 1) return 'stale';
      if (selected.some(key => !question.options.some(option => option.key === key))) return 'stale';
    }
    context.settle(args.askId, {
      kind: 'answered',
      answers,
      by: args.by,
      comment: null,
      timedOut: false,
    });
    return 'accepted';
  }

  function submitCustomReply(
    args: Parameters<AskBrokerActions['submitCustomReply']>[0],
  ): AskClickOutcome {
    const checked = pendingAuthorized(args.askId, args.by, undefined, args.actor);
    if (typeof checked === 'string') return checked;
    const text = args.text.trim();
    if (!text) return 'stale';
    context.settle(args.askId, {
      kind: 'answered',
      answers: checked.questions.map(() => []),
      by: args.by,
      comment: text,
      timedOut: false,
    });
    return 'accepted';
  }

  function submitUndoAsk(
    args: Parameters<AskBrokerActions['submitUndoAsk']>[0],
  ): AskClickOutcome {
    const checked = pendingAuthorized(args.askId, args.by, args.nonce);
    if (typeof checked === 'string') return checked;
    if (!checked.flowId || !context.hasFlowSteps(checked)) return 'stale';
    context.settle(args.askId, {
      kind: 'answered',
      answers: checked.questions.map(() => []),
      by: args.by,
      comment: null,
      action: 'undo',
      timedOut: false,
    });
    return 'accepted';
  }

  function tryResolveAsk(
    args: Parameters<AskBrokerActions['tryResolveAsk']>[0],
  ): AskClickOutcome {
    return submitAsk({
      askId: args.askId,
      nonce: args.nonce,
      by: args.by,
      selections: [[args.selected]],
    });
  }

  function submitAskFromDesktop(
    args: Parameters<AskBrokerActions['submitAskFromDesktop']>[0],
  ): AskClickOutcome {
    context.gc();
    const ask = context.getAsk(args.askId);
    if (!ask) return 'stale';
    if (ask.settled) return 'already_settled';
    for (let index = 0; index < ask.questions.length; index++) {
      const question = ask.questions[index]!;
      const selected = args.selections[index] ?? [];
      if (!question.multiSelect && selected.length !== 1) return 'stale';
      if (selected.some(key => !question.options.some(option => option.key === key))) return 'stale';
    }
    context.settle(args.askId, {
      kind: 'answered',
      answers: args.selections,
      by: args.by ?? 'desktop',
      comment: null,
      timedOut: false,
    });
    return 'accepted';
  }

  return {
    toggleAsk,
    submitAsk,
    submitCustomReply,
    submitUndoAsk,
    tryResolveAsk,
    submitAskFromDesktop,
  };
}
