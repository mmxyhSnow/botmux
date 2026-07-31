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
  it('冻结后点击只推进生产分支，成功后提示单独部署', async () => {
    const store = frozenStore();
    const patched: string[] = [];
    const notices: string[] = [];
    const promote = vi.fn(async () => ({ productionHead: candidateHead }));
    const notifier = new CustomReleaseNotifier({
      store,
      ownerOpenId: () => 'ou_owner',
      sendCard: async () => 'om_release',
      updateCard: async (_messageId, card) => { patched.push(card); },
      notifyText: async (_owner, content) => { notices.push(content); },
      freeze: async () => ({ candidateTag: 'release/v3.7.1-custom.3' }),
      promote,
    });

    const accepted = await notifier.handleCardAction({
      action: 'custom_release_promote',
      operatorOpenId: 'ou_owner',
      messageId: 'om_release',
      eventId: event().eventId,
    });
    expect(JSON.stringify(accepted)).toContain('推进');
    await notifier.waitForIdle();
    expect(promote).toHaveBeenCalledOnce();
    expect(store.get(event().eventId)?.state).toMatchObject({
      status: 'promoted',
      productionHead: candidateHead,
    });
    expect(patched.at(-1)).toContain('下一步：部署并重启');
    expect(notices.at(-1)).toContain('已推进 custom/prod');
  });

  it('daemon 重启后把中断中的生产推进恢复为可重试状态', async () => {
    const store = frozenStore();
    store.updateState(event().eventId, { status: 'promoting' });
    const patched: string[] = [];
    const notifier = new CustomReleaseNotifier({
      store,
      ownerOpenId: () => 'ou_owner',
      sendCard: async () => 'om_release',
      updateCard: async (_messageId, card) => { patched.push(card); },
      notifyText: async () => undefined,
      freeze: async () => ({ candidateTag: 'release/v3.7.1-custom.3' }),
      promote: async () => ({ productionHead: candidateHead }),
    });

    await notifier.recoverInterruptedFreezes();
    expect(store.get(event().eventId)?.state).toMatchObject({
      status: 'promote_failed',
      lastError: expect.stringContaining('重启中断'),
    });
    expect(patched.at(-1)).toContain('重新点击推进');
    expect(patched.at(-1)).toContain('custom_release_promote');
  });
});
