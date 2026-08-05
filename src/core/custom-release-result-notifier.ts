/** 自定义发版结果提醒：所有状态只重绘原发版卡，不再补发独立文本气泡。 */
import type {
  CustomReleaseEventRecord,
  CustomReleaseEventStatus,
} from '../services/custom-release-event.js';
import { CustomReleaseEventStore } from '../services/custom-release-event.js';
import { buildCustomReleaseSummaryCard } from '../im/lark/custom-release-card.js';

const SETTLED_STATUSES = new Set<CustomReleaseEventStatus>([
  'frozen', 'freeze_failed', 'stale', 'promoted', 'promote_failed', 'deployed', 'deploy_failed',
]);

interface CustomReleaseResultNotifierDeps {
  store: CustomReleaseEventStore;
  updateCard: (messageId: string, cardJson: string) => Promise<void>;
  log: (message: string) => void;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 1000);
}

export class CustomReleaseResultNotifier {
  constructor(private readonly deps: CustomReleaseResultNotifierDeps) {}

  /** 状态与 messageId 共同保证同一候选生命周期始终只占用原卡片。 */
  async notifySettled(record: CustomReleaseEventRecord): Promise<void> {
    const { status } = record.state;
    if (!SETTLED_STATUSES.has(status) || record.state.notifiedStatus === status) return;
    await this.syncCard(record);
  }

  /** 首次发送完成后用真实投递终点重绘；失败只影响展示，不能降级已经可靠送达的状态。 */
  async refreshDeliveredCard(record: CustomReleaseEventRecord): Promise<void> {
    const messageId = record.state.messageId;
    if (record.state.status !== 'delivered' || !messageId) return;
    try {
      await this.deps.updateCard(messageId, buildCustomReleaseSummaryCard(record));
    } catch (error) {
      this.deps.log(`delivered card refresh failed ${record.event.eventId.slice(0, 12)}: ${errorText(error)}`);
    }
  }

  /** 组合动作进入部署阶段时立即刷新原卡；刷新失败不阻断已授权的发布门禁。 */
  async refreshRunningCard(record: CustomReleaseEventRecord): Promise<void> {
    await this.syncCard(record, true);
  }

  private async syncCard(record: CustomReleaseEventRecord, force = false): Promise<void> {
    const { status, messageId } = record.state;
    if (!messageId || (!force && record.state.notifiedStatus === status)) return;
    try {
      await this.deps.updateCard(messageId, buildCustomReleaseSummaryCard(record));
      this.deps.store.updateState(record.event.eventId, { notifiedStatus: status });
    } catch (error) {
      this.deps.log(`result card patch failed ${record.event.eventId.slice(0, 12)}: ${errorText(error)}`);
    }
  }

  /** 升级后选取最近的已结算事件；即使已有更新的待发卡，也能重绘尚未推进的候选卡。 */
  async refreshLatestSettledCard(): Promise<void> {
    const latest = this.deps.store.list().filter(record => SETTLED_STATUSES.has(record.state.status)).at(-1);
    if (!latest) return;
    await this.syncCard(latest, true);
  }
}
