/** 自定义发版冻结执行器：冻结成功后按卡片授权选择停止或衔接既有部署门禁。 */
import type { CustomReleaseEventRecord, CustomReleaseEventStore } from '../services/custom-release-event.js';
import {
  StaleCustomReleaseHeadError,
  type CustomReleaseFreezeResult,
} from './custom-release-notifier-types.js';

interface CustomReleaseFreezeRunnerDeps {
  store: CustomReleaseEventStore;
  freeze: (record: CustomReleaseEventRecord) => Promise<CustomReleaseFreezeResult>;
  notifySettled: (record: CustomReleaseEventRecord) => Promise<void>;
  refreshRunning: (record: CustomReleaseEventRecord) => Promise<void>;
  startDeploy: (record: CustomReleaseEventRecord) => Promise<void>;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 1000);
}

/**
 * 先锁定候选标签，再决定是否进入部署；冻结失败或 HEAD 过期时绝不调用部署执行器。
 */
export async function runCustomReleaseFreeze(
  record: CustomReleaseEventRecord,
  deployAfterFreeze: boolean,
  deps: CustomReleaseFreezeRunnerDeps,
): Promise<void> {
  let settled: CustomReleaseEventRecord;
  try {
    const result = await deps.freeze(record);
    settled = deps.store.updateState(record.event.eventId, {
      status: 'frozen',
      candidateTag: result.candidateTag,
      lastError: undefined,
    });
  } catch (error) {
    settled = deps.store.updateState(record.event.eventId, {
      status: error instanceof StaleCustomReleaseHeadError ? 'stale' : 'freeze_failed',
      lastError: errorText(error),
    });
  }
  if (!deployAfterFreeze || settled.state.status !== 'frozen') {
    await deps.notifySettled(settled);
    return;
  }
  const deploying = deps.store.updateState(record.event.eventId, {
    status: 'deploying',
    lastError: undefined,
    notifiedStatus: undefined,
  });
  await deps.refreshRunning(deploying);
  await deps.startDeploy(deploying);
}
