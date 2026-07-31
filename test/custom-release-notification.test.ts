import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CustomReleaseEventStore,
  customReleaseMessageUuid,
  type CustomReleaseEvent,
} from '../src/services/custom-release-event.js';
import { buildCustomReleaseSummaryCard } from '../src/im/lark/custom-release-card.js';
import {
  CustomReleaseNotifier,
} from '../src/core/custom-release-notifier.js';
import { StaleCustomReleaseHeadError } from '../src/core/custom-release-notifier-types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function event(seed = '1', overrides: Partial<CustomReleaseEvent> = {}): CustomReleaseEvent {
  const head = seed.repeat(40).slice(0, 40);
  return {
    schemaVersion: 1,
    eventId: seed.repeat(64).slice(0, 64),
    repository: 'mmxyhSnow/botmux',
    repoRoot: '/workspace/botmux-custom-dev',
    createdAt: '2026-07-31T08:00:00.000Z',
    source: {
      ref: 'origin/refactor/versioned-release-flow',
      head: '31f4aca9ced123130467b93aea93946847d6a5f5',
      title: '接入版本制与 Tag 发版流',
    },
    integration: {
      branch: 'custom/dev',
      previousHead: '929a0008fb166ed4d0ace61b487983bba1978f46',
      head,
      mergeCommit: head,
    },
    production: {
      branch: 'custom/prod',
      head: '929a0008fb166ed4d0ace61b487983bba1978f46',
    },
    release: {
      pendingVersion: '3.7.1-custom.3',
      baseRef: 'custom/prod',
      baseHead: '929a0008fb166ed4d0ace61b487983bba1978f46',
    },
    current: { commits: 2, files: 13, insertions: 574, deletions: 92 },
    cumulative: [{
      title: '接入版本制与 Tag 发版流',
      mergeCommit: head,
      sourceHead: '31f4aca9ced123130467b93aea93946847d6a5f5',
    }],
    totals: { commits: 2, files: 13, insertions: 574, deletions: 92 },
    ...overrides,
  };
}

function storeWithEvent(seed = '1') {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-release-event-'));
  tempDirs.push(dataDir);
  const store = new CustomReleaseEventStore(dataDir);
  const record = store.enqueue(event(seed));
  return { dataDir, store, record };
}

describe('custom release event store', () => {
  it('持久化同一 HEAD 的事件时保持幂等', () => {
    const { store, record } = storeWithEvent();
    expect(store.enqueue(event()).event.eventId).toBe(record.event.eventId);
    expect(store.list()).toHaveLength(1);
    expect(store.listDeliverable()).toHaveLength(1);
  });

  it('拒绝同一事件 ID 对应不同发布内容', () => {
    const { store } = storeWithEvent();
    expect(() => store.enqueue(event('1', {
      source: { ...event().source, title: '伪造的另一项改动' },
    }))).toThrow(/事件 ID 冲突/);
  });

  it('同一事件重放时忽略新的采集时间并保留首次时间', () => {
    const { store } = storeWithEvent();
    const replayed = store.enqueue(event('1', { createdAt: '2026-07-31T09:00:00.000Z' }));
    expect(replayed.event.createdAt).toBe('2026-07-31T08:00:00.000Z');
    expect(store.list()).toHaveLength(1);
  });

  it('消息 UUID 对同一事件稳定且长度受控', () => {
    expect(customReleaseMessageUuid(event().eventId)).toBe(customReleaseMessageUuid(event().eventId));
    expect(customReleaseMessageUuid(event().eventId).length).toBeLessThanOrEqual(50);
  });
});

describe('custom release summary card', () => {
  it('使用 JSON 2.0 回调按钮并把冻结放在卡片末尾', () => {
    const { record } = storeWithEvent();
    const card = JSON.parse(buildCustomReleaseSummaryCard({
      ...record,
      state: { ...record.state, status: 'delivered', messageId: 'om_release' },
    }));
    expect(card.schema).toBe('2.0');
    const encoded = JSON.stringify(card);
    expect(encoded).toContain('本次合入');
    expect(encoded).toContain('当前版本累计改动');
    expect(encoded).toContain('冻结 3.7.1-custom.3');
    expect(encoded).toContain('custom_release_freeze');
    expect(card.body.elements.at(-1).tag).toBe('column_set');
  });

  it('旧卡过期后移除冻结回调', () => {
    const { record } = storeWithEvent();
    const card = buildCustomReleaseSummaryCard({
      ...record,
      state: { ...record.state, status: 'stale', supersededBy: '2'.repeat(64) },
    });
    expect(card).toContain('已有更新的合入卡片');
    expect(card).not.toContain('custom_release_freeze');
  });

  it('冻结后在原卡给出推进生产选项并保留部署边界', () => {
    const { record } = storeWithEvent();
    const card = JSON.parse(buildCustomReleaseSummaryCard({
      ...record,
      state: {
        ...record.state,
        status: 'frozen',
        messageId: 'om_release',
        candidateTag: 'release/v3.7.1-custom.3',
      },
    }));
    const encoded = JSON.stringify(card);
    expect(encoded).toContain('推进 custom/prod');
    expect(encoded).toContain('不会部署或重启');
    expect(encoded).toContain('custom_release_promote');
    expect(card.body.elements.at(-1).tag).toBe('column_set');
  });
});

describe('custom release notifier', () => {
  it('投递新卡后幂等，并把上一张待冻结卡标为过期', async () => {
    const { store } = storeWithEvent('1');
    const sent: string[] = [];
    const patched: Array<{ messageId: string; card: string }> = [];
    const notifier = new CustomReleaseNotifier({
      store,
      ownerOpenId: () => 'ou_owner',
      sendCard: async (_owner, card) => {
        sent.push(card);
        return `om_${sent.length}`;
      },
      updateCard: async (messageId, card) => { patched.push({ messageId, card }); },
      notifyText: async () => undefined,
      freeze: async () => ({ candidateTag: 'release/v3.7.1-custom.3' }),
      promote: async () => ({ productionHead: event().integration.head }),
    });

    await notifier.flush();
    await notifier.flush();
    expect(sent).toHaveLength(1);

    store.enqueue(event('2', {
      integration: {
        ...event('2').integration,
        previousHead: event('1').integration.head,
      },
    }));
    await notifier.flush();
    expect(sent).toHaveLength(2);
    expect(store.get(event('1').eventId)?.state.status).toBe('stale');
    expect(patched.some(item => item.messageId === 'om_1' && item.card.includes('已有更新'))).toBe(true);
  });

  it('只允许收件 owner 冻结，并在后台成功后固化卡片', async () => {
    const { store } = storeWithEvent();
    const patched: string[] = [];
    const notices: string[] = [];
    const notifier = new CustomReleaseNotifier({
      store,
      ownerOpenId: () => 'ou_owner',
      sendCard: async () => 'om_release',
      updateCard: async (_messageId, card) => { patched.push(card); },
      notifyText: async (_owner, content) => { notices.push(content); },
      freeze: async () => ({ candidateTag: 'release/v3.7.1-custom.3' }),
      promote: async () => ({ productionHead: event().integration.head }),
    });
    await notifier.flush();

    const denied = await notifier.handleCardAction({
      operatorOpenId: 'ou_other',
      messageId: 'om_release',
      eventId: event().eventId,
    });
    expect(denied.toast?.type).toBe('error');

    const accepted = await notifier.handleCardAction({
      operatorOpenId: 'ou_owner',
      messageId: 'om_release',
      eventId: event().eventId,
    });
    expect(JSON.stringify(accepted)).toContain('正在冻结');
    await notifier.waitForIdle();
    expect(store.get(event().eventId)?.state).toMatchObject({
      status: 'frozen',
      candidateTag: 'release/v3.7.1-custom.3',
    });
    expect(patched.at(-1)).toContain('已冻结');
    expect(patched.at(-1)).toContain('custom_release_promote');
    expect(notices.at(-1)).toContain('请打开');
    expect(notices.at(-1)).toContain('推进 custom/prod');
  });

  it('冻结期间远端 HEAD 改变时只让旧卡过期，不创建候选结果', async () => {
    const { store } = storeWithEvent();
    const notifier = new CustomReleaseNotifier({
      store,
      ownerOpenId: () => 'ou_owner',
      sendCard: async () => 'om_release',
      updateCard: async () => undefined,
      notifyText: async () => undefined,
      freeze: async () => { throw new StaleCustomReleaseHeadError('远端 custom/dev 已变化'); },
      promote: async () => ({ productionHead: event().integration.head }),
    });
    await notifier.flush();
    await notifier.handleCardAction({
      operatorOpenId: 'ou_owner',
      messageId: 'om_release',
      eventId: event().eventId,
    });
    await notifier.waitForIdle();
    expect(store.get(event().eventId)?.state.status).toBe('stale');
  });

  it('升级启动时重绘最新已冻结卡并只补发一次结果提醒', async () => {
    const { store } = storeWithEvent('1');
    store.updateState(event('1').eventId, {
      status: 'frozen',
      messageId: 'om_frozen',
      candidateTag: 'release/v3.7.1-custom.3',
    });
    const next = store.enqueue(event('2'));
    store.updateState(next.event.eventId, { status: 'delivered', messageId: 'om_next' });
    const patched: string[] = [];
    const notices: string[] = [];
    const notifier = new CustomReleaseNotifier({
      store,
      ownerOpenId: () => 'ou_owner',
      sendCard: async () => 'om_unused',
      updateCard: async (_messageId, card) => { patched.push(card); },
      notifyText: async (_owner, content) => { notices.push(content); },
      freeze: async () => ({ candidateTag: 'release/v3.7.1-custom.4' }),
      promote: async () => ({ productionHead: event('1').integration.head }),
    });

    await notifier.refreshLatestSettledCard();
    await notifier.refreshLatestSettledCard();
    expect(patched.at(-1)).toContain('custom_release_promote');
    expect(notices).toHaveLength(1);
    expect(store.get(event('1').eventId)?.state.notifiedStatus).toBe('frozen');
  });

  it('daemon 重启后把中断中的冻结恢复为可重试状态', async () => {
    const { store } = storeWithEvent();
    store.updateState(event().eventId, { status: 'freezing', messageId: 'om_release' });
    const patched: string[] = [];
    const notifier = new CustomReleaseNotifier({
      store,
      ownerOpenId: () => 'ou_owner',
      sendCard: async () => 'om_release',
      updateCard: async (_messageId, card) => { patched.push(card); },
      notifyText: async () => undefined,
      freeze: async () => ({ candidateTag: 'release/v3.7.1-custom.3' }),
      promote: async () => ({ productionHead: event().integration.head }),
    });

    await notifier.recoverInterruptedFreezes();
    expect(store.get(event().eventId)?.state).toMatchObject({
      status: 'freeze_failed',
      lastError: expect.stringContaining('重启中断'),
    });
    expect(patched.at(-1)).toContain('上次冻结未完成');
  });

});
