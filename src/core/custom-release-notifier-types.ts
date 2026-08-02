/** 自定义发版通知契约：集中卡片动作、后台执行结果与依赖边界。 */
import type { CustomReleaseEventRecord } from '../services/custom-release-event.js';
import type { CustomReleaseEventStore } from '../services/custom-release-event.js';

export class StaleCustomReleaseHeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleCustomReleaseHeadError';
  }
}

export interface CustomReleaseFreezeResult {
  candidateTag: string;
}

/** 远端生产分支推进器的内部结果；一键部署继续消费该 HEAD。 */
export interface CustomReleasePromoteResult {
  productionHead: string;
}

export interface CustomReleaseDeployResult {
  productionHead: string;
  deployTag: string;
}

export interface CustomReleaseNotifierDeps {
  store: CustomReleaseEventStore;
  ownerOpenId: () => string | undefined;
  sendCard: (ownerOpenId: string, cardJson: string, uuid: string) => Promise<string>;
  updateCard: (messageId: string, cardJson: string) => Promise<void>;
  freeze: (record: CustomReleaseEventRecord) => Promise<CustomReleaseFreezeResult>;
  /** 完成推进、构建、wrapper 切换并发起脱离当前 daemon 的重启。 */
  deploy: (record: CustomReleaseEventRecord) => Promise<void>;
  /** 新 daemon 启动后验收实际运行态并记录同号部署标签。 */
  finalizeDeploy: (record: CustomReleaseEventRecord) => Promise<CustomReleaseDeployResult>;
  log?: (message: string) => void;
  pollIntervalMs?: number;
  /** 重启驱动未接管时，旧 daemon 把悬空 deploying 恢复为可重试的等待时间。 */
  restartHandoffTimeoutMs?: number;
}

export interface CustomReleaseCardActionInput {
  action?: 'custom_release_freeze' | 'custom_release_promote';
  operatorOpenId?: string;
  messageId?: string;
  eventId?: string;
}
