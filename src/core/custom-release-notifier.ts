/**
 * 自定义发版通知编排器。
 * primary daemon 独占投递队列，卡片回调只负责认领任务，耗时冻结/部署在后台执行。
 */
import type { CustomReleaseEventRecord } from '../services/custom-release-event.js';
import { customReleaseMessageUuid } from '../services/custom-release-event.js';
import { buildCustomReleaseSummaryCard } from '../im/lark/custom-release-card.js';
import { CustomReleaseResultNotifier } from './custom-release-result-notifier.js';
import {
  StaleCustomReleaseHeadError,
  type CustomReleaseCardActionInput,
  type CustomReleaseNotifierDeps,
} from './custom-release-notifier-types.js';

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
  private readonly resultNotifier: CustomReleaseResultNotifier;

  constructor(private readonly deps: CustomReleaseNotifierDeps) {
    this.log = deps.log ?? (() => undefined);
    this.resultNotifier = new CustomReleaseResultNotifier({
      store: deps.store,
      updateCard: deps.updateCard,
      log: this.log,
    });
  }

  /** 启动时立即排空一次，之后低频扫描；定时器本身不阻止进程退出。 */
  start(): void {
    if (this.timer) return;
    void this.recoverInterruptedFreezes()
      .then(() => this.resultNotifier.refreshLatestSettledCard())
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
        const previous = this.deps.store.previousDelivered(attempt);
        // 待冻结事件是明确需要 owner 操作的卡片；每次 HEAD 变化都新发到私聊最新位置，
        // 再让旧事件服务端过期，不能用静默 PATCH 把按钮留在历史消息中。
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
        await this.resultNotifier.refreshDeliveredCard(delivered);
        await this.expirePreviousCard(delivered, previous);
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

  private async expirePreviousCard(
    current: CustomReleaseEventRecord,
    previous: CustomReleaseEventRecord | undefined,
  ): Promise<void> {
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

  /** 部署新实现后重绘最新终态卡，并补发尚未确认送达的结果提醒。 */
  async refreshLatestSettledCard(): Promise<void> {
    await this.resultNotifier.refreshLatestSettledCard();
  }

  /**
   * 冻结回调只信任飞书 verified operator 和账本里的 messageId/eventId。
   * 成功认领后立即返回处理中卡片，测试与构建不占用飞书三秒回调预算。
   */
  async handleCardAction(input: CustomReleaseCardActionInput): Promise<any> {
    const owner = this.deps.ownerOpenId();
    if (!owner || input.operatorOpenId !== owner) {
      return { toast: { type: 'error', content: '只有收到该私聊卡的 Bot owner 可以操作发版' } };
    }
    if (!input.eventId) {
      return { toast: { type: 'error', content: '发版事件参数无效' } };
    }
    const record = this.deps.store.get(input.eventId);
    if (!record || !record.state.messageId || record.state.messageId !== input.messageId) {
      return { toast: { type: 'error', content: '这张发版卡片已失效或来源不匹配' } };
    }
    return input.action === 'custom_release_promote'
      ? this.handlePromoteAction(record)
      : this.handleFreezeAction(record);
  }

  private handleFreezeAction(record: CustomReleaseEventRecord): any {
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
      notifiedStatus: undefined,
    });
    const job = this.freezeInBackground(claimed);
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
    return rawCard(claimed, { type: 'success', content: '已开始冻结验证' });
  }

  private handlePromoteAction(record: CustomReleaseEventRecord): any {
    if (record.state.status === 'stale' || record.state.status === 'deploying' || record.state.status === 'deployed') {
      return rawCard(record, {
        type: 'info',
        content: record.state.status === 'stale'
          ? '已有更新的待发版，请使用最新私聊卡'
          : record.state.status === 'deployed' ? '该候选版本已经完成部署' : '推进并部署任务正在执行',
      });
    }
    if (
      record.state.status !== 'frozen'
      && record.state.status !== 'promote_failed'
      && record.state.status !== 'promoted'
      && record.state.status !== 'deploy_failed'
    ) {
      return { toast: { type: 'warning', content: '当前发版卡片还不能推进并部署' } };
    }
    const claimed = this.deps.store.updateState(record.event.eventId, {
      status: 'deploying',
      lastError: undefined,
      notifiedStatus: undefined,
    });
    const job = this.deployInBackground(claimed);
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
    return rawCard(claimed, {
      type: 'success',
      content: `已授权推进并部署 ${record.event.release.pendingVersion}`,
    });
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
    await this.resultNotifier.notifySettled(settled);
  }

  private async deployInBackground(record: CustomReleaseEventRecord): Promise<void> {
    try {
      // 成功后当前 daemon 会被重启；保持 deploying，由新进程验收运行态并收敛终态。
      await this.deps.deploy(record);
      const watchdog = setTimeout(() => {
        void this.failUnclaimedRestart(record.event.eventId);
      }, this.deps.restartHandoffTimeoutMs ?? 30_000);
      watchdog.unref?.();
      return;
    } catch (error) {
      const settled = this.deps.store.updateState(record.event.eventId, {
        status: 'deploy_failed',
        lastError: errorText(error),
      });
      await this.resultNotifier.notifySettled(settled);
    }
  }

  /** 脱离式重启若没有杀掉旧 daemon，避免事件永久停在“部署中”。 */
  private async failUnclaimedRestart(eventId: string): Promise<void> {
    const current = this.deps.store.get(eventId);
    if (current?.state.status !== 'deploying') return;
    const settled = this.deps.store.updateState(eventId, {
      status: 'deploy_failed',
      lastError: '重启驱动未在预期时间内接管，请重新点击推进并部署',
      notifiedStatus: undefined,
    });
    await this.resultNotifier.notifySettled(settled);
  }

  /** daemon 重启会中断子进程；把悬空状态改成明确可重试，并同步更新原卡片。 */
  async recoverInterruptedFreezes(): Promise<void> {
    for (const interrupted of this.deps.store.list().filter(record => record.state.status === 'freezing')) {
      const recovered = this.deps.store.updateState(interrupted.event.eventId, {
        status: 'freeze_failed',
        lastError: 'daemon 重启中断了冻结任务，请重新点击冻结',
      });
      await this.resultNotifier.notifySettled(recovered);
    }
    for (const interrupted of this.deps.store.list().filter(record => record.state.status === 'promoting')) {
      const recovered = this.deps.store.updateState(interrupted.event.eventId, {
        status: 'promote_failed',
        lastError: 'daemon 重启中断了推进任务，请重新点击推进 custom/prod',
        notifiedStatus: undefined,
      });
      await this.resultNotifier.notifySettled(recovered);
    }
    for (const interrupted of this.deps.store.list().filter(record => record.state.status === 'deploying')) {
      let recovered: CustomReleaseEventRecord;
      try {
        const result = await this.deps.finalizeDeploy(interrupted);
        recovered = this.deps.store.updateState(interrupted.event.eventId, {
          status: 'deployed',
          productionHead: result.productionHead,
          deployTag: result.deployTag,
          lastError: undefined,
          notifiedStatus: undefined,
        });
      } catch (error) {
        recovered = this.deps.store.updateState(interrupted.event.eventId, {
          status: 'deploy_failed',
          lastError: errorText(error),
          notifiedStatus: undefined,
        });
      }
      await this.resultNotifier.notifySettled(recovered);
    }
  }

  /** 测试和优雅退出使用：等待当前已认领的冻结任务收敛。 */
  async waitForIdle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.all([...this.jobs]);
  }
}
