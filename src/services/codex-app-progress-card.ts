import { createHash } from 'node:crypto';
import type {
  CodexAppProgressCardPhase,
  CodexAppProgressCardSessionState,
  CodexAppProgressSemanticSummaryItem,
} from '../types.js';
import { renderCodexAppProgressCard } from './codex-app-progress-card-renderer.js';
import {
  computeExternalOutcome,
  externalTerminalHeadline,
} from './codex-app-progress-external.js';
import {
  deriveProgressMilestone,
  deriveTerminalMilestone,
} from './codex-app-progress-milestones.js';
import {
  appendCodexAppProgressEntry,
  cloneCodexAppProgressState,
  isCodexAppProgressSummaryEvent,
  restoreCodexAppProgressState,
} from './codex-app-progress-state.js';
import { parseCodexAppProgress } from './codex-app-progress-structure.js';

export { renderCodexAppProgressCard } from './codex-app-progress-card-renderer.js';

export interface CodexAppProgressCardOperations {
  sessionId?: string;
  post(cardJson: string, turnId: string): Promise<string>;
  patch(messageId: string, cardJson: string): Promise<void>;
  canRepostAfterPatchFailure?(error: unknown): boolean;
  persist(state: CodexAppProgressCardSessionState): void;
  /** 可选的当前卡片标题投影；归档卡仍保留原有标题。 */
  titleOverride?(state: CodexAppProgressCardSessionState): string | undefined;
  /** 发布当前完整过程并返回受保护的 HTML 链接；失败时主卡仍需正常更新。 */
  publishReport?(
    state: CodexAppProgressCardSessionState,
  ): string | undefined | Promise<string | undefined>;
  /** 后台综合完整时间线；失败返回 undefined，上层继续保留最近一次成功摘要。 */
  summarize?(
    state: CodexAppProgressCardSessionState,
    signal: AbortSignal,
  ): Promise<CodexAppProgressSemanticSummaryItem[] | undefined>;
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

function terminalText(
  phase: Exclude<CodexAppProgressCardPhase, 'running'>,
  overview?: CodexAppProgressCardSessionState['overview'],
): string {
  if (phase === 'failed') return '本轮处理失败。';
  if (phase === 'interrupted') return '本轮已中断。';
  // completed 阶段是「AI 本轮执行结束」，是否等于外部任务成功取决于结构化状态。
  return externalTerminalHeadline(computeExternalOutcome(overview?.external));
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
  private summaryEpoch = 0;
  private summaryRequestedRevision = 0;
  private summaryRunning = false;
  private summaryAbort?: AbortController;

  constructor(
    private readonly operations: CodexAppProgressCardOperations,
    initialState?: CodexAppProgressCardSessionState,
  ) {
    this.state = initialState ? restoreCodexAppProgressState(initialState) : undefined;
    if (this.state && operations.sessionId && !this.state.sessionId) {
      this.state.sessionId = operations.sessionId;
    }
  }

  snapshot(): CodexAppProgressCardSessionState | undefined {
    return this.state ? cloneCodexAppProgressState(this.state) : undefined;
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
        appendCodexAppProgressEntry(
          current,
          timestampedContent(terminalText('completed', current.overview), this.now()),
          true,
          deriveTerminalMilestone({
            overview: current.overview,
            phase: 'completed',
            index: current.currentEntryCount ?? 0,
          }),
        );
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
      const summaryEvent = parsed.overview
        ? isCodexAppProgressSummaryEvent(this.state.overview, parsed.overview)
        : false;
      const milestone = summaryEvent && parsed.overview
        ? deriveProgressMilestone({
            previous: this.state.overview,
            next: parsed.overview,
            index: this.state.currentEntryCount ?? 0,
          })
        : undefined;
      if (parsed.title) this.state.title = parsed.title;
      if (parsed.overview) this.state.overview = parsed.overview;
      if (trimmed) appendCodexAppProgressEntry(
        this.state,
        timestampedContent(trimmed, now),
        summaryEvent,
        milestone,
      );
      if (trimmed) this.requestSemanticSummary();
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
      appendCodexAppProgressEntry(
        this.state,
        timestampedContent(terminalText(phase, this.state.overview), now),
        true,
        deriveTerminalMilestone({
          overview: this.state.overview,
          phase,
          index: this.state.currentEntryCount ?? 0,
        }),
      );
      this.requestSemanticSummary();
      this.state.updatedAtMs = now.getTime();
      this.persist();
      await this.syncCard();
    });
  }

  /** 保存与当前任务绑定的最终回复，并立即刷新稳定报告链接对应的 HTML。 */
  recordFinal(turnId: string, content: string): Promise<void> {
    return this.enqueue(async () => {
      const finalResponse = content.trim();
      if (
        !finalResponse
        || !this.state
        || !this.state.acceptedTurnIds.includes(turnId)
        || this.state.finalResponse === finalResponse
      ) return;
      this.state.finalResponse = finalResponse;
      this.requestSemanticSummary();
      this.state.updatedAtMs = this.now().getTime();
      this.persist();
      await this.publishCurrentReport();
    });
  }

  interrupt(): Promise<void> {
    const turnId = this.state?.activeTurnId;
    return turnId ? this.settle(turnId, 'interrupted') : Promise.resolve();
  }

  private startState(turnId: string, title: string): void {
    this.summaryAbort?.abort();
    this.summaryAbort = undefined;
    this.summaryEpoch += 1;
    this.summaryRequestedRevision = 0;
    this.summaryRunning = false;
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
      summaryEntryIndexes: [],
      ...(this.operations.summarize
        ? { semanticSummary: { status: 'updating' as const, items: [], sourceEntryCount: 0 } }
        : {}),
      pageNumber: 1,
      currentEntryCount: 1,
      archivedPages: [],
    };
    this.persist();
  }

  /** 每个新增事件只读取一次时钟，保证持久化与卡片展示一致。 */
  private now(): Date {
    return this.operations.now?.() ?? new Date();
  }

  private persist(): void {
    if (this.state) this.operations.persist(cloneCodexAppProgressState(this.state));
  }

  /** 标记摘要已过期并启动最多一个后台生成器；连续进展只增加待处理修订号。 */
  private requestSemanticSummary(): void {
    if (!this.state || !this.operations.summarize) return;
    this.summaryRequestedRevision += 1;
    const previous = this.state.semanticSummary;
    this.state.semanticSummary = {
      status: 'updating',
      items: previous?.items ?? [],
      sourceEntryCount: previous?.sourceEntryCount ?? 0,
      updatedAtMs: previous?.updatedAtMs,
    };
    if (this.summaryRunning) return;
    this.summaryRunning = true;
    const epoch = this.summaryEpoch;
    void this.runSemanticSummaryLoop(epoch);
  }

  /**
   * 每次只总结启动时的完整快照；生成期间如有新记录，只再补一次最新修订。
   * 应用结果也走卡片串行队列，避免后台完成覆盖同步进展。
   */
  private async runSemanticSummaryLoop(epoch: number): Promise<void> {
    try {
      while (epoch === this.summaryEpoch && this.state && this.operations.summarize) {
        const revision = this.summaryRequestedRevision;
        const snapshot = cloneCodexAppProgressState(this.state);
        const sourceEntryCount = snapshot.currentEntryCount ?? 0;
        const abort = new AbortController();
        this.summaryAbort = abort;
        let items: CodexAppProgressSemanticSummaryItem[] | undefined;
        try {
          items = await this.operations.summarize(snapshot, abort.signal);
        } catch {
          // 后台摘要失败不能形成未处理 rejection，更不能阻断真实进展写入。
          items = undefined;
        }
        if (epoch !== this.summaryEpoch) return;
        await this.enqueue(async () => {
          if (!this.state || epoch !== this.summaryEpoch) return;
          const newerRevisionPending = this.summaryRequestedRevision > revision;
          const previous = this.state.semanticSummary;
          this.state.semanticSummary = items
            ? {
                status: newerRevisionPending ? 'updating' : 'ready',
                items,
                sourceEntryCount,
                updatedAtMs: this.now().getTime(),
              }
            : {
                status: newerRevisionPending ? 'updating' : 'failed',
                items: previous?.items ?? [],
                sourceEntryCount: previous?.sourceEntryCount ?? 0,
                updatedAtMs: previous?.updatedAtMs,
              };
          this.persist();
          await this.publishCurrentReport();
        });
        if (this.summaryRequestedRevision <= revision) return;
      }
    } finally {
      if (epoch === this.summaryEpoch) {
        this.summaryRunning = false;
        this.summaryAbort = undefined;
      }
    }
  }

  /** 报告失败不能阻断主卡；稳定 URL 会在下一次状态同步时再次覆盖刷新。 */
  private async publishCurrentReport(): Promise<string | undefined> {
    if (!this.state) return;
    try {
      return await this.operations.publishReport?.(cloneCodexAppProgressState(this.state));
    } catch {
      // 报告是主卡的增强入口，写入失败不得阻断用户看到最新任务状态。
      return undefined;
    }
  }

  private async syncCard(): Promise<void> {
    if (!this.state) return;
    const reportUrl = await this.publishCurrentReport();
    const cardJson = renderCodexAppProgressCard(this.state, {
      reportUrl,
      titleOverride: this.operations.titleOverride?.(cloneCodexAppProgressState(this.state)),
    });
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
