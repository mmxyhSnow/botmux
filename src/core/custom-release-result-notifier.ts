/** 自定义发版结果提醒：重绘终态卡，并仅为异常或后续发布结果补充独立私聊。 */
import { createHash } from 'node:crypto';
import type {
  CustomReleaseEventRecord,
  CustomReleaseEventStatus,
} from '../services/custom-release-event.js';
import { CustomReleaseEventStore } from '../services/custom-release-event.js';
import { buildCustomReleaseSummaryCard } from '../im/lark/custom-release-card.js';

const SETTLED_STATUSES = new Set<CustomReleaseEventStatus>([
  'frozen', 'freeze_failed', 'stale', 'promoted', 'promote_failed', 'deployed', 'deploy_failed',
]);

// 冻结成功后的状态和下一步已经完整呈现在原卡片中，不再发送重复文字。
const TEXT_NOTICE_STATUSES = new Set<CustomReleaseEventStatus>([
  'freeze_failed', 'stale', 'promoted', 'promote_failed', 'deployed', 'deploy_failed',
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
  if (state.status === 'freeze_failed') {
    return `候选版本 ${event.release.pendingVersion} 冻结失败，未创建候选标签。${state.lastError ? `原因：${state.lastError}` : ''}`;
  }
  if (state.status === 'stale') {
    return `待发版 ${event.release.pendingVersion} 对应的 custom/dev 已变化，请使用最新私聊汇总卡。`;
  }
  if (state.status === 'promoted') {
    return `候选版本 ${event.release.pendingVersion} 已推进 custom/prod。请打开原私聊卡点击“部署并重启 ${event.release.pendingVersion}”；无需再发送授权消息。`;
  }
  if (state.status === 'deployed') {
    return `候选版本 ${event.release.pendingVersion} 已完成推进、部署和重启，并记录 ${state.deployTag ?? `deploy/v${event.release.pendingVersion}`}。`;
  }
  if (state.status === 'deploy_failed') {
    return `候选版本 ${event.release.pendingVersion} 部署未完成。请查看原私聊卡后重试。${state.lastError ? `原因：${state.lastError}` : ''}`;
  }
  return `候选版本 ${event.release.pendingVersion} 推进 custom/prod 失败。${state.lastError ? `原因：${state.lastError}` : ''}`;
}

export class CustomReleaseResultNotifier {
  constructor(private readonly deps: CustomReleaseResultNotifierDeps) {}

  /** 稳定 UUID 与账本字段共同保证结果提醒重试幂等。 */
  async notifySettled(record: CustomReleaseEventRecord): Promise<void> {
    const { status } = record.state;
    if (!TEXT_NOTICE_STATUSES.has(status) || record.state.notifiedStatus === status) return;
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
    const latest = this.deps.store.list().filter(record => SETTLED_STATUSES.has(record.state.status)).at(-1);
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
