import { createHash } from 'node:crypto';
import { buildCardBodyElements } from '../im/lark/md-card.js';
import type {
  CodexAppProgressCardPhase,
  CodexAppProgressCardSessionState,
} from '../types.js';

export interface CodexAppProgressCardOperations {
  post(cardJson: string, turnId: string): Promise<string>;
  patch(messageId: string, cardJson: string): Promise<void>;
  canRepostAfterPatchFailure?(error: unknown): boolean;
  persist(state: CodexAppProgressCardSessionState): void;
  /** 返回内容事件的发生时间；测试可注入固定时钟，生产环境缺省使用系统时间。 */
  now?(): Date;
}

const INITIAL_CONTENT = '已收到，开始处理。';
const PROGRESS_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** 在内容写入状态时固定北京时间，避免后续 PATCH 或重启改变旧时间。 */
function timestampedContent(content: string, now: Date): string {
  return `[${PROGRESS_TIME_FORMATTER.format(now)}] ${content}`;
}

function cloneState(state: CodexAppProgressCardSessionState): CodexAppProgressCardSessionState {
  return {
    ...state,
    acceptedTurnIds: [...state.acceptedTurnIds],
    pendingTurns: state.pendingTurns.map(turn => ({ ...turn })),
  };
}

function terminalText(phase: Exclude<CodexAppProgressCardPhase, 'running'>): string {
  if (phase === 'completed') return '本轮已完成，最终结果见最新回复。';
  if (phase === 'failed') return '本轮处理失败，错误详情见最新回复。';
  return '本轮已中断。';
}

function titlePrefix(phase: CodexAppProgressCardPhase): string {
  if (phase === 'running') return '处理中';
  if (phase === 'completed') return '已完成';
  if (phase === 'failed') return '处理失败';
  return '已中断';
}

function cardTemplate(phase: CodexAppProgressCardPhase): string {
  if (phase === 'running') return 'turquoise';
  if (phase === 'completed') return 'green';
  if (phase === 'failed') return 'red';
  return 'grey';
}

/** 使用官方 markdown 渲染链生成可 PATCH 的飞书卡片。 */
export function renderCodexAppProgressCard(state: CodexAppProgressCardSessionState): string {
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: cardTemplate(state.phase),
      title: {
        tag: 'plain_text',
        content: `${titlePrefix(state.phase)} · ${state.title}`,
      },
    },
    body: {
      direction: 'vertical',
      elements: buildCardBodyElements(state.content),
    },
  });
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex');
}

/**
 * 管理一个会话当前可见的 Codex App 状态卡。
 * 所有写入串行化，确保并发进展不会重复 POST 或覆盖更新。
 */
export class CodexAppProgressCard {
  private state?: CodexAppProgressCardSessionState;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly operations: CodexAppProgressCardOperations,
    initialState?: CodexAppProgressCardSessionState,
  ) {
    this.state = initialState ? cloneState(initialState) : undefined;
  }

  snapshot(): CodexAppProgressCardSessionState | undefined {
    return this.state ? cloneState(this.state) : undefined;
  }

  /** 收到消息时先持久化 running，再立即创建卡片；失败时保留待重试状态。 */
  accept(turnId: string, title: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.state?.phase === 'running') {
        if (
          this.state.acceptedTurnIds.includes(turnId)
          || this.state.pendingTurns.some(turn => turn.turnId === turnId)
        ) return;
        this.state.pendingTurns.push({ turnId, title });
        this.persist();
        return;
      }
      this.startState(turnId, title);
      await this.syncCard();
    });
  }

  /** turn/start 表示先前未被 steer 接受的输入开始了独立新回合。 */
  turnStarted(turnId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.state?.phase === 'running' && this.state.acceptedTurnIds.includes(turnId)) {
        await this.syncCard();
        return;
      }
      const current = this.state;
      if (!current) return;
      const pending = current.pendingTurns.find(turn => turn.turnId === turnId);
      if (!pending) return;
      if (current.phase === 'running') {
        current.phase = 'completed';
        current.content = `${current.content}\n\n${timestampedContent(terminalText('completed'), this.now())}`;
        this.persist();
        await this.syncCard();
      }
      this.startState(turnId, pending.title);
      await this.syncCard();
    });
  }

  /** steer 接受后把补充消息绑定到当前任务卡，不创建第二张卡。 */
  steerAccepted(turnId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.state || this.state.phase !== 'running') return;
      const pendingIndex = this.state.pendingTurns.findIndex(turn => turn.turnId === turnId);
      if (pendingIndex < 0 && this.state.acceptedTurnIds.includes(turnId)) return;
      if (pendingIndex >= 0) this.state.pendingTurns.splice(pendingIndex, 1);
      if (!this.state.acceptedTurnIds.includes(turnId)) this.state.acceptedTurnIds.push(turnId);
      this.persist();
      await this.syncCard();
    });
  }

  /** 只接受已绑定回合的完整 assistant 进展，并按内容指纹去重。 */
  append(turnId: string, content: string): Promise<void> {
    return this.enqueue(async () => {
      const trimmed = content.trim();
      if (
        !trimmed
        || !this.state
        || this.state.phase !== 'running'
        || !this.state.acceptedTurnIds.includes(turnId)
      ) return;
      const nextFingerprint = fingerprint(trimmed);
      if (this.state.lastFingerprint === nextFingerprint) return;
      this.state.lastFingerprint = nextFingerprint;
      this.state.content = `${this.state.content}\n\n${timestampedContent(trimmed, this.now())}`;
      this.persist();
      await this.syncCard();
    });
  }

  /** 权威终态只结算属于当前卡片的回合。 */
  settle(
    turnId: string,
    phase: Exclude<CodexAppProgressCardPhase, 'running'>,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (
        !this.state
        || this.state.phase !== 'running'
        || !this.state.acceptedTurnIds.includes(turnId)
      ) return;
      this.state.phase = phase;
      this.state.content = `${this.state.content}\n\n${timestampedContent(terminalText(phase), this.now())}`;
      this.persist();
      await this.syncCard();
    });
  }

  interrupt(): Promise<void> {
    const turnId = this.state?.activeTurnId;
    return turnId ? this.settle(turnId, 'interrupted') : Promise.resolve();
  }

  private startState(turnId: string, title: string): void {
    const remainingPending = this.state?.pendingTurns.filter(turn => turn.turnId !== turnId) ?? [];
    this.state = {
      phase: 'running',
      activeTurnId: turnId,
      acceptedTurnIds: [turnId],
      pendingTurns: remainingPending,
      title,
      content: timestampedContent(INITIAL_CONTENT, this.now()),
    };
    this.persist();
  }

  /** 每个新增事件只读取一次时钟，保证持久化与卡片展示一致。 */
  private now(): Date {
    return this.operations.now?.() ?? new Date();
  }

  private persist(): void {
    if (this.state) this.operations.persist(cloneState(this.state));
  }

  private async syncCard(): Promise<void> {
    if (!this.state) return;
    const cardJson = renderCodexAppProgressCard(this.state);
    if (this.state.messageId) {
      try {
        await this.operations.patch(this.state.messageId, cardJson);
        return;
      } catch (error) {
        if (
          this.state.repostedAfterWithdraw
          || !this.operations.canRepostAfterPatchFailure?.(error)
        ) throw error;
        this.state.messageId = undefined;
        this.state.repostedAfterWithdraw = true;
        this.persist();
      }
    }
    const messageId = await this.operations.post(cardJson, this.state.activeTurnId);
    this.state.messageId = messageId;
    this.persist();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => {});
    return next;
  }
}
