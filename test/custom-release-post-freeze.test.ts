/** 自定义发布后续流转测试：覆盖生产推进、提醒与中断恢复。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CustomReleaseNotifier } from '../src/core/custom-release-notifier.js';
import {
  CustomReleaseEventStore,
  type CustomReleaseEvent,
} from '../src/services/custom-release-event.js';

const tempDirs: string[] = [];
const candidateHead = '1'.repeat(40);

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function event(): CustomReleaseEvent {
  return {
    schemaVersion: 1,
    eventId: 'a'.repeat(64),
    repository: 'mmxyhSnow/botmux',
    repoRoot: '/workspace/botmux-custom-dev',
    createdAt: '2026-07-31T08:00:00.000Z',
    source: { ref: 'origin/fix/release-card', head: '2'.repeat(40), title: '发布后续操作' },
    integration: {
      branch: 'custom/dev',
      previousHead: '3'.repeat(40),
      head: candidateHead,
      mergeCommit: candidateHead,
    },
    production: { branch: 'custom/prod', head: '3'.repeat(40) },
    release: {
      pendingVersion: '3.7.1-custom.3',
      baseRef: 'custom/prod',
      baseHead: '3'.repeat(40),
    },
    current: { commits: 1, files: 1, insertions: 1, deletions: 0 },
    cumulative: [{ title: '发布后续操作', mergeCommit: candidateHead, sourceHead: '2'.repeat(40) }],
    totals: { commits: 1, files: 1, insertions: 1, deletions: 0 },
  };
}

function frozenStore(): CustomReleaseEventStore {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-release-post-freeze-'));
  tempDirs.push(dataDir);
  const store = new CustomReleaseEventStore(dataDir);
  store.enqueue(event());
  store.updateState(event().eventId, {
    status: 'frozen',
    messageId: 'om_release',
    candidateTag: 'release/v3.7.1-custom.3',
  });
  return store;
}

describe('custom release post-freeze actions', () => {
  it('冻结后点击直接认领完整发布，不再等待一条额外授权消息', async () => {
    const store = frozenStore();
    const deploy = vi.fn(async () => undefined);
    const notifier = new CustomReleaseNotifier({
      store,
      ownerOpenId: () => 'ou_owner',
      sendCard: async () => 'om_release',
      updateCard: async () => undefined,
      freeze: async () => ({ candidateTag: 'release/v3.7.1-custom.3' }),
      deploy,
      finalizeDeploy: async () => ({
        productionHead: candidateHead,
        deployTag: 'deploy/v3.7.1-custom.3',
      }),
    });

    const accepted = await notifier.handleCardAction({
      action: 'custom_release_promote',
      operatorOpenId: 'ou_owner',
      messageId: 'om_release',
      eventId: event().eventId,
    });
    expect(JSON.stringify(accepted)).toContain('已授权推进并部署 3.7.1-custom.3');
    await notifier.waitForIdle();
    expect(deploy).toHaveBeenCalledOnce();
    expect(store.get(event().eventId)?.state).toMatchObject({
      status: 'deploying',
    });
  });

  it('新 daemon 启动后验收运行态、记录 deploy 标签并回写原卡', async () => {
    const store = frozenStore();
    store.updateState(event().eventId, { status: 'deploying' });
    const patched: string[] = [];
    const notifier = new CustomReleaseNotifier({
      store,
      ownerOpenId: () => 'ou_owner',
      sendCard: async () => 'om_release',
      updateCard: async (_messageId, card) => { patched.push(card); },
      freeze: async () => ({ candidateTag: 'release/v3.7.1-custom.3' }),
      deploy: async () => undefined,
      finalizeDeploy: async () => ({
        productionHead: candidateHead,
        deployTag: 'deploy/v3.7.1-custom.3',
      }),
    });

    await notifier.recoverInterruptedFreezes();
    expect(store.get(event().eventId)?.state).toMatchObject({
      status: 'deployed',
      productionHead: candidateHead,
      deployTag: 'deploy/v3.7.1-custom.3',
    });
    expect(patched.at(-1)).toContain('已部署');
    expect(patched.at(-1)).not.toContain('custom_release_promote');
  });

  it('新 daemon 运行态验收失败时恢复为可重试部署', async () => {
    const store = frozenStore();
    store.updateState(event().eventId, { status: 'deploying' });
    const notifier = new CustomReleaseNotifier({
      store,
      ownerOpenId: () => 'ou_owner',
      sendCard: async () => 'om_release',
      updateCard: async () => undefined,
      freeze: async () => ({ candidateTag: 'release/v3.7.1-custom.3' }),
      deploy: async () => undefined,
      finalizeDeploy: async () => { throw new Error('运行路径不一致'); },
    });

    await notifier.recoverInterruptedFreezes();
    expect(store.get(event().eventId)?.state).toMatchObject({
      status: 'deploy_failed',
      lastError: '运行路径不一致',
    });
  });

  it('重启驱动未接管旧 daemon 时不会永久卡在部署中', async () => {
    vi.useFakeTimers();
    const store = frozenStore();
    const notifier = new CustomReleaseNotifier({
      store,
      ownerOpenId: () => 'ou_owner',
      sendCard: async () => 'om_release',
      updateCard: async () => undefined,
      freeze: async () => ({ candidateTag: 'release/v3.7.1-custom.3' }),
      deploy: async () => undefined,
      finalizeDeploy: async () => ({
        productionHead: candidateHead,
        deployTag: 'deploy/v3.7.1-custom.3',
      }),
      restartHandoffTimeoutMs: 10,
    });

    await notifier.handleCardAction({
      action: 'custom_release_promote',
      operatorOpenId: 'ou_owner',
      messageId: 'om_release',
      eventId: event().eventId,
    });
    await notifier.waitForIdle();
    await vi.advanceTimersByTimeAsync(11);
    expect(store.get(event().eventId)?.state).toMatchObject({
      status: 'deploy_failed',
      lastError: expect.stringContaining('重启驱动'),
    });
  });
});
