/** 自定义发版结果提醒：重绘终态卡，并用独立私聊提供真正的新消息提醒。 */
import { createHash } from 'node:crypto';
import type {
  CustomReleaseEventRecord,
  CustomReleaseEventStatus,
} from '../services/custom-release-event.js';
import { CustomReleaseEventStore } from '../services/custom-release-event.js';
import { buildCustomReleaseSummaryCard } from '../im/lark/custom-release-card.js';

const NOTICE_STATUSES = new Set<CustomReleaseEventStatus>([
  'frozen', 'freeze_failed', 'stale', 'promoted', 'promote_failed',
]);

interface CustomReleaseResultNotifierDeps {
  store: CustomReleaseEventStore;
  ownerOpenId: () => string | undefined;
  updateCard: (messageId: string, cardJson: string) => Promise<void>;
  notifyText: (ownerOpenId: string, content: string, uuid: string) => Promise<void>;
  log: (message: string) => void;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 1000);
}

function resultMessageUuid(eventId: string, status: CustomReleaseEventStatus): string {
  const digest = createHash('sha256').update(`${eventId}:${status}`).digest('hex').slice(0, 28);
  return `release-result-${digest}`;
}

function resultNotice(record: CustomReleaseEventRecord): string {
  const { event, state } = record;
  if (state.status === 'frozen') {
    return `候选版本 ${event.release.pendingVersion} 已冻结。请打开“待发版 ${event.release.pendingVersion} 已更新”私聊卡，点击“推进 custom/prod”；该操作不会部署或重启。`;
  }
  if (state.status === 'freeze_failed') {
    return `候选版本 ${event.release.pendingVersion} 冻结失败，未创建候选标签。${state.lastError ? `原因：${state.lastError}` : ''}`;
  }
  if (state.status === 'stale') {
    return `待发版 ${event.release.pendingVersion} 对应的 custom/dev 已变化，请使用最新私聊汇总卡。`;
  }
  if (state.status === 'promoted') {
    return `候选版本 ${event.release.pendingVersion} 已推进 custom/prod。下一步是部署并重启；该步骤会改变运行态，请在 Botmux 对话中单独明确授权。`;
  }
  return `候选版本 ${event.release.pendingVersion} 推进 custom/prod 失败。${state.lastError ? `原因：${state.lastError}` : ''}`;
}

export class CustomReleaseResultNotifier {
  constructor(private readonly deps: CustomReleaseResultNotifierDeps) {}

  /** 稳定 UUID 与账本字段共同保证结果提醒重试幂等。 */
  async notifySettled(record: CustomReleaseEventRecord): Promise<void> {
    const { status } = record.state;
    if (!NOTICE_STATUSES.has(status) || record.state.notifiedStatus === status) return;
    const owner = this.deps.ownerOpenId();
    if (!owner) return;
    try {
      await this.deps.notifyText(owner, resultNotice(record), resultMessageUuid(record.event.eventId, status));
      this.deps.store.updateState(record.event.eventId, { notifiedStatus: status });
    } catch (error) {
      this.deps.log(`result notice failed ${record.event.eventId.slice(0, 12)}: ${errorText(error)}`);
    }
  }

  /** 升级后选取最近的已结算事件；即使已有更新的待发卡，也能重绘尚未推进的候选卡。 */
  async refreshLatestSettledCard(): Promise<void> {
    const latest = this.deps.store.list().filter(record => NOTICE_STATUSES.has(record.state.status)).at(-1);
    if (!latest) return;
    if (latest.state.messageId) {
      try {
        await this.deps.updateCard(latest.state.messageId, buildCustomReleaseSummaryCard(latest));
      } catch (error) {
        this.deps.log(`latest card refresh failed ${latest.event.eventId.slice(0, 12)}: ${errorText(error)}`);
      }
    }
    await this.notifySettled(latest);
  }
}
