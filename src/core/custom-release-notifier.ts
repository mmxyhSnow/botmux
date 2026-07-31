/**
 * 自定义发版通知编排器。
 * primary daemon 独占投递队列，卡片回调只负责认领任务，耗时冻结在后台执行。
 */
import type { CustomReleaseEventRecord } from '../services/custom-release-event.js';
import {
  CustomReleaseEventStore,
  customReleaseMessageUuid,
} from '../services/custom-release-event.js';
import { buildCustomReleaseSummaryCard } from '../im/lark/custom-release-card.js';

export class StaleCustomReleaseHeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleCustomReleaseHeadError';
  }
}

export interface CustomReleaseFreezeResult {
  candidateTag: string;
}

export interface CustomReleaseNotifierDeps {
  store: CustomReleaseEventStore;
  ownerOpenId: () => string | undefined;
  sendCard: (ownerOpenId: string, cardJson: string, uuid: string) => Promise<string>;
  updateCard: (messageId: string, cardJson: string) => Promise<void>;
  freeze: (record: CustomReleaseEventRecord) => Promise<CustomReleaseFreezeResult>;
  log?: (message: string) => void;
  pollIntervalMs?: number;
}

export interface CustomReleaseCardActionInput {
  operatorOpenId?: string;
  messageId?: string;
  eventId?: string;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 1000);
}

function rawCard(record: CustomReleaseEventRecord, toast?: { type: string; content: string }) {
  return {
    ...(toast ? { toast } : {}),
    card: { type: 'raw' as const, data: JSON.parse(buildCustomReleaseSummaryCard(record)) },
  };
}

export class CustomReleaseNotifier {
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  private readonly jobs = new Set<Promise<void>>();
  private readonly log: (message: string) => void;

  constructor(private readonly deps: CustomReleaseNotifierDeps) {
    this.log = deps.log ?? (() => undefined);
  }

  /** 启动时立即排空一次，之后低频扫描；定时器本身不阻止进程退出。 */
  start(): void {
    if (this.timer) return;
    void this.recoverInterruptedFreezes()
      .then(() => this.flush())
      .catch(error => this.log(`startup recovery/flush failed: ${errorText(error)}`));
    this.timer = setInterval(() => {
      void this.flush().catch(error => this.log(`scheduled flush failed: ${errorText(error)}`));
    }, this.deps.pollIntervalMs ?? 5_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 单进程 single-flight 排空，避免 timer 与启动扫描重复发送。 */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const run = this.flushOnce();
    this.flushing = run;
    try { await run; } finally { this.flushing = undefined; }
  }

  private async flushOnce(): Promise<void> {
    const owner = this.deps.ownerOpenId();
    if (!owner) {
      this.log('owner unavailable; release notifications remain queued');
      return;
    }
    for (const queued of this.deps.store.listDeliverable()) {
      const attempt = this.deps.store.updateState(queued.event.eventId, {
        status: 'delivering',
        attempts: queued.state.attempts + 1,
        lastError: undefined,
      });
      const visible = {
        ...attempt,
        state: { ...attempt.state, status: 'delivered' as const },
      };
      try {
        const messageId = await this.deps.sendCard(
          owner,
          buildCustomReleaseSummaryCard(visible),
          customReleaseMessageUuid(attempt.event.eventId),
        );
        const delivered = this.deps.store.updateState(attempt.event.eventId, {
          status: 'delivered',
          messageId,
          lastError: undefined,
        });
        await this.expirePreviousCard(delivered);
        this.log(`delivered ${attempt.event.eventId.slice(0, 12)} message=${messageId}`);
      } catch (error) {
        this.deps.store.updateState(attempt.event.eventId, {
          status: 'delivery_failed',
          lastError: errorText(error),
        });
        this.log(`delivery failed ${attempt.event.eventId.slice(0, 12)}: ${errorText(error)}`);
      }
    }
  }

  private async expirePreviousCard(current: CustomReleaseEventRecord): Promise<void> {
    const previous = this.deps.store.previousDelivered(current);
    if (!previous?.state.messageId) return;
    const stale = this.deps.store.updateState(previous.event.eventId, {
      status: 'stale',
      supersededBy: current.event.eventId,
    });
    try {
      await this.deps.updateCard(previous.state.messageId, buildCustomReleaseSummaryCard(stale));
    } catch (error) {
      // 服务端状态已过期，旧卡即使视觉更新失败也会在回调时被拒绝。
      this.log(`previous card patch failed ${previous.event.eventId.slice(0, 12)}: ${errorText(error)}`);
    }
  }

  /**
   * 冻结回调只信任飞书 verified operator 和账本里的 messageId/eventId。
   * 成功认领后立即返回处理中卡片，测试与构建不占用飞书三秒回调预算。
   */
  async handleCardAction(input: CustomReleaseCardActionInput): Promise<any> {
    const owner = this.deps.ownerOpenId();
    if (!owner || input.operatorOpenId !== owner) {
      return { toast: { type: 'error', content: '只有收到该私聊卡的 Bot owner 可以冻结版本' } };
    }
    if (!input.eventId) {
      return { toast: { type: 'error', content: '发版事件参数无效' } };
    }
    const record = this.deps.store.get(input.eventId);
    if (!record || !record.state.messageId || record.state.messageId !== input.messageId) {
      return { toast: { type: 'error', content: '这张发版卡片已失效或来源不匹配' } };
    }
    if (record.state.status === 'stale' || record.state.status === 'frozen' || record.state.status === 'freezing') {
      return rawCard(record, {
        type: 'info',
        content: record.state.status === 'stale'
          ? '已有更新的待发版，请使用最新私聊卡'
          : record.state.status === 'frozen' ? '该版本已经冻结' : '冻结任务正在执行',
      });
    }
    if (record.state.status !== 'delivered' && record.state.status !== 'freeze_failed') {
      return { toast: { type: 'warning', content: '当前发版卡片还不能执行冻结' } };
    }
    const claimed = this.deps.store.updateState(record.event.eventId, {
      status: 'freezing',
      lastError: undefined,
    });
    const job = this.freezeInBackground(claimed);
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
    return rawCard(claimed, { type: 'success', content: '已开始冻结验证' });
  }

  private async freezeInBackground(record: CustomReleaseEventRecord): Promise<void> {
    let settled: CustomReleaseEventRecord;
    try {
      const result = await this.deps.freeze(record);
      settled = this.deps.store.updateState(record.event.eventId, {
        status: 'frozen',
        candidateTag: result.candidateTag,
        lastError: undefined,
      });
    } catch (error) {
      settled = this.deps.store.updateState(record.event.eventId, {
        status: error instanceof StaleCustomReleaseHeadError ? 'stale' : 'freeze_failed',
        lastError: errorText(error),
      });
    }
    if (!settled.state.messageId) return;
    try {
      await this.deps.updateCard(settled.state.messageId, buildCustomReleaseSummaryCard(settled));
    } catch (error) {
      this.log(`freeze result patch failed ${record.event.eventId.slice(0, 12)}: ${errorText(error)}`);
    }
  }

  /** daemon 重启会中断子进程；把悬空状态改成明确可重试，并同步更新原卡片。 */
  async recoverInterruptedFreezes(): Promise<void> {
    for (const interrupted of this.deps.store.list().filter(record => record.state.status === 'freezing')) {
      const recovered = this.deps.store.updateState(interrupted.event.eventId, {
        status: 'freeze_failed',
        lastError: 'daemon 重启中断了冻结任务，请重新点击冻结',
      });
      if (!recovered.state.messageId) continue;
      try {
        await this.deps.updateCard(recovered.state.messageId, buildCustomReleaseSummaryCard(recovered));
      } catch (error) {
        this.log(`interrupted freeze patch failed ${recovered.event.eventId.slice(0, 12)}: ${errorText(error)}`);
      }
    }
  }

  /** 测试和优雅退出使用：等待当前已认领的冻结任务收敛。 */
  async waitForIdle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.all([...this.jobs]);
  }
}
