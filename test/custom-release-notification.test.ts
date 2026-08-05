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

  it('拒绝累计项中的未知类型标签', () => {
    const { store } = storeWithEvent();
    expect(() => store.enqueue(event('2', {
      cumulative: [{
        title: '未知改动',
        mergeCommit: '2'.repeat(40),
        sourceHead: '3'.repeat(40),
        kind: 'other',
      } as any],
    }))).toThrow(/累计项无效/);
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

  it('状态变化会追加持久时间线，同状态字段更新不会重复节点', () => {
    const { store, record } = storeWithEvent();
    store.updateState(record.event.eventId, {
      status: 'delivering',
      updatedAt: '2026-07-31T08:00:01.000Z',
    });
    store.updateState(record.event.eventId, { attempts: 1 });
    const current = store.updateState(record.event.eventId, {
      status: 'delivered',
      updatedAt: '2026-07-31T08:00:03.000Z',
    });
    expect(current.state.timeline?.map(entry => entry.status)).toEqual([
      'queued', 'delivering', 'delivered',
    ]);
    expect(buildCustomReleaseSummaryCard(current)).toContain('发布时');
    expect(buildCustomReleaseSummaryCard(current)).toContain('2s');
    expect(buildCustomReleaseSummaryCard(current)).not.toContain('待冻结 · 0s');
  });
});

describe('custom release summary card', () => {
  it('在累计改动标题前渲染 feat、bugfix、opt 小标签', () => {
    const { record } = storeWithEvent();
    const card = buildCustomReleaseSummaryCard({
      ...record,
      event: {
        ...record.event,
        cumulative: [
          { title: '新增能力', mergeCommit: '1'.repeat(40), sourceHead: '1'.repeat(40), kind: 'feat' },
          { title: '修复问题', mergeCommit: '2'.repeat(40), sourceHead: '2'.repeat(40), kind: 'bugfix' },
          { title: '优化体验', mergeCommit: '3'.repeat(40), sourceHead: '3'.repeat(40), kind: 'opt' },
        ],
      },
    });
    const table = JSON.parse(card).body.elements.find((element: any) => element.tag === 'table');
    expect(table.columns).toEqual([
      expect.objectContaining({ name: 'kind', display_name: '类型', data_type: 'options', width: '80px' }),
      expect.objectContaining({ name: 'change', display_name: '改动', data_type: 'lark_md' }),
    ]);
    expect(table.rows).toEqual([
      { kind: [{ text: 'feat', color: 'blue' }], change: expect.stringContaining('新增能力') },
      { kind: [{ text: 'bugfix', color: 'red' }], change: expect.stringContaining('修复问题') },
      { kind: [{ text: 'opt', color: 'green' }], change: expect.stringContaining('优化体验') },
    ]);
  });

  it('旧事件缺少 kind 时按当前 source ref 补判标签', () => {
    const { record } = storeWithEvent();
    const card = JSON.parse(buildCustomReleaseSummaryCard(record));
    const table = card.body.elements.find((element: any) => element.tag === 'table');
    expect(table.rows[0]).toEqual({
      kind: [{ text: 'opt', color: 'green' }],
      change: expect.stringContaining('接入版本制与 Tag 发版流'),
    });
  });

  it('使用 JSON 2.0 回调按钮并把冻结与冻结部署放在卡片末尾', () => {
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
    expect(encoded).toContain('冻结并部署 3.7.1-custom.3');
    expect(encoded).toContain('custom_release_freeze');
    expect(encoded).toContain('custom_release_freeze_and_deploy');
    expect(card.body.elements.at(-1)).toMatchObject({
      tag: 'column_set',
      columns: [
        { elements: [{ type: 'default' }] },
        { elements: [{ type: 'primary' }] },
      ],
    });
  });

  it('用空行隔开发版状态、阶段说明和完整差异链接', () => {
    const { record } = storeWithEvent();
    const card = JSON.parse(buildCustomReleaseSummaryCard({
      ...record,
      state: { ...record.state, status: 'delivered', messageId: 'om_release' },
    }));
    const status = card.body.elements.find((element: any) =>
      element.tag === 'markdown' && element.content.includes('发布状态'));
    expect(status.content).toContain('累计：2 commits，13 files，+574/-92\n\n尚未冻结');
    expect(status.content).toContain('尚未冻结、未推进生产、未部署。\n\n[查看完整差异]');
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

  it('冻结后在原卡给出推进并部署选项，点击即为完整授权', () => {
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
    expect(encoded).toContain('推进并部署 3.7.1-custom.3');
    expect(encoded).toContain('按钮点击本身即授权');
    expect(encoded).toContain('custom_release_promote');
    expect(card.body.elements.at(-1).tag).toBe('column_set');
  });

  it('兼容已推进但尚未留 deploy 标签的旧卡，直接提供部署重启按钮', () => {
    const { record } = storeWithEvent();
    const encoded = buildCustomReleaseSummaryCard({
      ...record,
      state: {
        ...record.state,
        status: 'promoted',
        messageId: 'om_release',
        candidateTag: 'release/v3.7.1-custom.3',
        productionHead: record.event.integration.head,
      },
    });
    expect(encoded).toContain('部署并重启 3.7.1-custom.3');
    expect(encoded).toContain('按钮点击本身即为部署授权');
    expect(encoded).toContain('custom_release_promote');
  });
});

describe('custom release notifier', () => {
  it('新的待冻结事件发到最新位置，并把上一张卡标为过期', async () => {
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
      freeze: async () => ({ candidateTag: 'release/v3.7.1-custom.3' }),
      deploy: async () => undefined,
      finalizeDeploy: async () => ({
        productionHead: event().integration.head,
        deployTag: 'deploy/v3.7.1-custom.3',
      }),
    });

    await notifier.flush();
    await notifier.flush();
    expect(sent).toHaveLength(1);
    expect(patched.some(item => item.messageId === 'om_1' && item.card.includes('发布时间线'))).toBe(true);

    store.enqueue(event('2', {
      integration: {
        ...event('2').integration,
        previousHead: event('1').integration.head,
      },
    }));
    await notifier.flush();
    expect(sent).toHaveLength(2);
    expect(store.get(event('1').eventId)?.state.status).toBe('stale');
    expect(store.get(event('2').eventId)?.state.messageId).toBe('om_2');
    expect(sent[1]).toContain('22222222');
    expect(patched.some(item => item.messageId === 'om_1' && item.card.includes('已有更新'))).toBe(true);
  });

  it('已送达卡片的终态重绘失败时保留 delivered 状态', async () => {
    const { store } = storeWithEvent();
    const logs: string[] = [];
    const notifier = new CustomReleaseNotifier({
      store,
      ownerOpenId: () => 'ou_owner',
      sendCard: async () => 'om_release',
      updateCard: async () => { throw new Error('simulated patch failure'); },
      freeze: async () => ({ candidateTag: 'release/v3.7.1-custom.3' }),
      deploy: async () => undefined,
      finalizeDeploy: async () => ({
        productionHead: event().integration.head,
        deployTag: 'deploy/v3.7.1-custom.3',
      }),
      log: message => { logs.push(message); },
    });

    await notifier.flush();
    expect(store.get(event().eventId)?.state).toMatchObject({
      status: 'delivered',
      messageId: 'om_release',
    });
    expect(logs).toContainEqual(expect.stringContaining('delivered card refresh failed'));
  });

  it('只允许收件 owner 冻结，成功后只更新原卡片', async () => {
    const { store } = storeWithEvent();
    const patched: string[] = [];
    const notifier = new CustomReleaseNotifier({
      store,
      ownerOpenId: () => 'ou_owner',
      sendCard: async () => 'om_release',
      updateCard: async (_messageId, card) => { patched.push(card); },
      freeze: async () => ({ candidateTag: 'release/v3.7.1-custom.3' }),
      deploy: async () => undefined,
      finalizeDeploy: async () => ({
        productionHead: event().integration.head,
        deployTag: 'deploy/v3.7.1-custom.3',
      }),
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
  });

  it('owner 选择冻结并部署后，冻结成功才衔接现有部署门禁', async () => {
    const { store } = storeWithEvent();
    const calls: string[] = [];
    const notifier = new CustomReleaseNotifier({
      store,
      ownerOpenId: () => 'ou_owner',
      sendCard: async () => 'om_release',
      updateCard: async () => undefined,
      freeze: async () => {
        calls.push('freeze');
        return { candidateTag: 'release/v3.7.1-custom.3' };
      },
      deploy: async record => {
        calls.push(`deploy:${record.state.candidateTag}`);
      },
      finalizeDeploy: async () => ({
        productionHead: event().integration.head,
        deployTag: 'deploy/v3.7.1-custom.3',
      }),
    });
    await notifier.flush();

    const accepted = await notifier.handleCardAction({
      action: 'custom_release_freeze_and_deploy',
      operatorOpenId: 'ou_owner',
      messageId: 'om_release',
      eventId: event().eventId,
    });
    expect(JSON.stringify(accepted)).toContain('已授权冻结并部署 3.7.1-custom.3');
    await notifier.waitForIdle();
    expect(calls).toEqual(['freeze', 'deploy:release/v3.7.1-custom.3']);
    expect(store.get(event().eventId)?.state).toMatchObject({
      status: 'deploying',
      candidateTag: 'release/v3.7.1-custom.3',
    });
  });

  it('冻结并部署在冻结失败时停止，不调用部署门禁', async () => {
    const { store } = storeWithEvent();
    let deployed = false;
    const notifier = new CustomReleaseNotifier({
      store,
      ownerOpenId: () => 'ou_owner',
      sendCard: async () => 'om_release',
      updateCard: async () => undefined,
      freeze: async () => { throw new Error('冻结验证失败'); },
      deploy: async () => { deployed = true; },
      finalizeDeploy: async () => ({
        productionHead: event().integration.head,
        deployTag: 'deploy/v3.7.1-custom.3',
      }),
    });
    await notifier.flush();

    await notifier.handleCardAction({
      action: 'custom_release_freeze_and_deploy',
      operatorOpenId: 'ou_owner',
      messageId: 'om_release',
      eventId: event().eventId,
    });
    await notifier.waitForIdle();
    expect(deployed).toBe(false);
    expect(store.get(event().eventId)?.state).toMatchObject({
      status: 'freeze_failed',
      lastError: '冻结验证失败',
    });
  });

  it('冻结期间远端 HEAD 改变时只让旧卡过期，不创建候选结果', async () => {
    const { store } = storeWithEvent();
    const notifier = new CustomReleaseNotifier({
      store,
      ownerOpenId: () => 'ou_owner',
      sendCard: async () => 'om_release',
      updateCard: async () => undefined,
      freeze: async () => { throw new StaleCustomReleaseHeadError('远端 custom/dev 已变化'); },
      deploy: async () => undefined,
      finalizeDeploy: async () => ({
        productionHead: event().integration.head,
        deployTag: 'deploy/v3.7.1-custom.3',
      }),
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

  it('升级启动时重绘最新已冻结卡且不补发结果文字', async () => {
    const { store } = storeWithEvent('1');
    store.updateState(event('1').eventId, {
      status: 'frozen',
      messageId: 'om_frozen',
      candidateTag: 'release/v3.7.1-custom.3',
    });
    const next = store.enqueue(event('2'));
    store.updateState(next.event.eventId, { status: 'delivered', messageId: 'om_next' });
    const patched: string[] = [];
    const notifier = new CustomReleaseNotifier({
      store,
      ownerOpenId: () => 'ou_owner',
      sendCard: async () => 'om_unused',
      updateCard: async (_messageId, card) => { patched.push(card); },
      freeze: async () => ({ candidateTag: 'release/v3.7.1-custom.4' }),
      deploy: async () => undefined,
      finalizeDeploy: async () => ({
        productionHead: event('1').integration.head,
        deployTag: 'deploy/v3.7.1-custom.3',
      }),
    });

    await notifier.refreshLatestSettledCard();
    await notifier.refreshLatestSettledCard();
    expect(patched.at(-1)).toContain('custom_release_promote');
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
      freeze: async () => ({ candidateTag: 'release/v3.7.1-custom.3' }),
      deploy: async () => undefined,
      finalizeDeploy: async () => ({
        productionHead: event().integration.head,
        deployTag: 'deploy/v3.7.1-custom.3',
      }),
    });

    await notifier.recoverInterruptedFreezes();
    expect(store.get(event().eventId)?.state).toMatchObject({
      status: 'freeze_failed',
      lastError: expect.stringContaining('重启中断'),
    });
    expect(patched.at(-1)).toContain('上次冻结未完成');
  });

});
