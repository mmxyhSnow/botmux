import { createHash } from 'node:crypto';
import type {
  CodexAppProgressCardPhase,
  CodexAppProgressCardSessionState,
} from '../types.js';
import { countProgressCardEntries } from './codex-app-progress-pagination.js';
import { renderCodexAppProgressCard } from './codex-app-progress-card-renderer.js';
import { parseCodexAppProgress } from './codex-app-progress-structure.js';

export { renderCodexAppProgressCard } from './codex-app-progress-card-renderer.js';

export interface CodexAppProgressCardOperations {
  sessionId?: string;
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
    archivedPages: state.archivedPages?.map(page => ({ ...page })),
    overview: state.overview
      ? {
          ...state.overview,
          completed: [...state.overview.completed],
          evidence: state.overview.evidence ? [...state.overview.evidence] : undefined,
          delivery: state.overview.delivery ? [...state.overview.delivery] : undefined,
          risks: state.overview.risks ? [...state.overview.risks] : undefined,
        }
      : undefined,
  };
}

/** 把旧单页状态补成可继续写入的第 1 页，不要求离线迁移。 */
function restoreState(state: CodexAppProgressCardSessionState): CodexAppProgressCardSessionState {
  const restored = cloneState(state);
  restored.pageNumber ??= 1;
  restored.currentEntryCount ??= countProgressCardEntries(restored.content);
  restored.archivedPages ??= [];
  return restored;
}

function terminalText(phase: Exclude<CodexAppProgressCardPhase, 'running'>): string {
  if (phase === 'completed') return '本轮已完成。';
  if (phase === 'failed') return '本轮处理失败。';
  return '本轮已中断。';
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
    this.state = initialState ? restoreState(initialState) : undefined;
    if (this.state && operations.sessionId && !this.state.sessionId) {
      this.state.sessionId = operations.sessionId;
    }
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
        this.appendEntry(timestampedContent(terminalText('completed'), this.now()));
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
      const parsed = parseCodexAppProgress(content);
      const trimmed = parsed.content;
      if (
        (!trimmed && !parsed.overview)
        || !this.state
        || this.state.phase !== 'running'
        || !this.state.acceptedTurnIds.includes(turnId)
      ) return;
      const nextFingerprint = fingerprint(JSON.stringify({
        content: trimmed,
        title: parsed.title,
        overview: parsed.overview,
      }));
      if (this.state.lastFingerprint === nextFingerprint) return;
      this.state.lastFingerprint = nextFingerprint;
      const now = this.now();
      if (parsed.title) this.state.title = parsed.title;
      if (parsed.overview) this.state.overview = parsed.overview;
      if (trimmed) this.appendEntry(timestampedContent(trimmed, now));
      this.state.updatedAtMs = now.getTime();
      this.persist();
      await this.syncCard();
    });
  }

  /** 查看按钮只改变主卡明细密度，不改变任务执行状态。 */
  setDetailsExpanded(expanded: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (!this.state || this.state.detailsExpanded === expanded) return;
      this.state.detailsExpanded = expanded;
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
      const now = this.now();
      this.appendEntry(timestampedContent(terminalText(phase), now));
      this.state.updatedAtMs = now.getTime();
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
    const now = this.now();
    this.state = {
      phase: 'running',
      activeTurnId: turnId,
      acceptedTurnIds: [turnId],
      pendingTurns: remainingPending,
      ...(this.operations.sessionId ? { sessionId: this.operations.sessionId } : {}),
      title,
      content: timestampedContent(INITIAL_CONTENT, now),
      startedAtMs: now.getTime(),
      updatedAtMs: now.getTime(),
      pageNumber: 1,
      currentEntryCount: 1,
      archivedPages: [],
    };
    this.persist();
  }

  /** 主卡只保存完整历史文本并复用同一消息；展示和历史分页由渲染层负责。 */
  private appendEntry(entry: string): void {
    if (!this.state) return;
    const entryCount = this.state.currentEntryCount
      ?? countProgressCardEntries(this.state.content);
    this.state.content = this.state.content
      ? `${this.state.content}\n\n${entry}`
      : entry;
    this.state.pageNumber = 1;
    this.state.currentEntryCount = entryCount + 1;
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
    if (!this.state.messageId) {
      const messageId = await this.operations.post(cardJson, this.state.activeTurnId);
      this.state.messageId = messageId;
      this.persist();
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => {});
    return next;
  }
}
