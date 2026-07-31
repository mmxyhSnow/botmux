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

export interface CustomReleasePromoteResult {
  productionHead: string;
}

export interface CustomReleaseNotifierDeps {
  store: CustomReleaseEventStore;
  ownerOpenId: () => string | undefined;
  sendCard: (ownerOpenId: string, cardJson: string, uuid: string) => Promise<string>;
  updateCard: (messageId: string, cardJson: string) => Promise<void>;
  notifyText: (ownerOpenId: string, content: string, uuid: string) => Promise<void>;
  freeze: (record: CustomReleaseEventRecord) => Promise<CustomReleaseFreezeResult>;
  promote: (record: CustomReleaseEventRecord) => Promise<CustomReleasePromoteResult>;
  log?: (message: string) => void;
  pollIntervalMs?: number;
}

export interface CustomReleaseCardActionInput {
  action?: 'custom_release_freeze' | 'custom_release_promote';
  operatorOpenId?: string;
  messageId?: string;
  eventId?: string;
}
