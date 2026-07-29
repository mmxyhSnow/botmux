import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TurnDeliveryLedger,
  stableTurnDeliveryUuid,
  type TurnDeliveryId,
} from '../src/services/turn-delivery-ledger.js';

describe('TurnDeliveryLedger', () => {
  let dataDir: string;
  const id: TurnDeliveryId = {
    larkAppId: 'cli_a',
    sessionId: 'session-a',
    turnId: 'om_turn',
    dispatchAttempt: 0,
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-delivery-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('保留未投递终态，并在投递成功后关闭轮次', () => {
    const ledger = new TurnDeliveryLedger(dataDir, { now: () => 1_000 });
    ledger.recordAccepted({
      id,
      anchor: 'om_root',
      chatId: 'oc_chat',
      scope: 'thread',
      cliId: 'codex-app',
      acceptedAtMs: 1_000,
      promptSummary: '安装 humanizer-zh',
    });
    ledger.recordRunning(id, { nativeTurnId: 'app-turn-1', atMs: 1_100 });
    ledger.recordFinal(id, {
      content: '已安装',
      outcome: 'completed',
      observedAtMs: 1_200,
    });
    ledger.recordDeliveryPending(id, {
      uuid: 'bmx-final-fixed',
      atMs: 1_250,
    });

    expect(ledger.listOutstanding('cli_a')).toEqual([
      expect.objectContaining({
        nativeTurnId: 'app-turn-1',
        final: expect.objectContaining({ content: '已安装' }),
        delivery: expect.objectContaining({ state: 'pending' }),
      }),
    ]);

    ledger.recordDelivered(id, {
      messageId: 'om_reply',
      deliveredAtMs: 1_300,
    });

    expect(ledger.listOutstanding('cli_a')).toEqual([]);
    expect(ledger.get(id)?.delivery).toEqual({
      state: 'delivered',
      uuid: 'bmx-final-fixed',
      messageId: 'om_reply',
      atMs: 1_300,
    });
  });

  it('重放重复和乱序事件时只向前推进，不覆盖可靠终态', () => {
    const first = new TurnDeliveryLedger(dataDir);
    first.recordAccepted({
      id,
      anchor: 'om_root',
      chatId: 'oc_chat',
      scope: 'thread',
      cliId: 'codex-app',
      acceptedAtMs: 1_000,
      promptSummary: '原始任务',
    });
    first.recordRunning(id, { nativeTurnId: 'app-turn-1', atMs: 1_100 });
    first.recordFinal(id, {
      content: '可靠结论',
      outcome: 'completed',
      observedAtMs: 1_200,
    });
    first.recordDelivered(id, {
      messageId: 'om_reply',
      deliveredAtMs: 1_300,
    });

    const replayed = new TurnDeliveryLedger(dataDir);
    replayed.recordAccepted({
      id,
      anchor: 'om_wrong',
      chatId: 'oc_wrong',
      scope: 'chat',
      cliId: 'other',
      acceptedAtMs: 2_000,
      promptSummary: '重复任务',
    });
    replayed.recordFinal(id, {
      content: '不应覆盖',
      outcome: 'failed',
      observedAtMs: 2_100,
    });
    replayed.recordDeliveryPending(id, {
      uuid: 'bmx-final-late',
      atMs: 2_200,
    });

    expect(replayed.get(id)).toEqual(expect.objectContaining({
      anchor: 'om_root',
      chatId: 'oc_chat',
      cliId: 'codex-app',
      promptSummary: '原始任务',
      final: expect.objectContaining({
        content: '可靠结论',
        outcome: 'completed',
      }),
      delivery: expect.objectContaining({
        state: 'delivered',
        messageId: 'om_reply',
      }),
    }));
  });

  it('按 Bot 隔离查询，并在压缩时只清除过期的已投递轮次', () => {
    const ledger = new TurnDeliveryLedger(dataDir);
    const otherId = { ...id, larkAppId: 'cli_b' };
    for (const [turnId, deliveredAtMs] of [
      ['old', 1_000],
      ['new', 5_000],
    ] as const) {
      const currentId = { ...id, turnId };
      ledger.recordAccepted({
        id: currentId,
        anchor: `om_${turnId}`,
        chatId: 'oc_chat',
        scope: 'thread',
        cliId: 'codex-app',
        acceptedAtMs: deliveredAtMs - 100,
        promptSummary: turnId,
      });
      ledger.recordDelivered(currentId, {
        messageId: `om_${turnId}_reply`,
        deliveredAtMs,
      });
    }
    ledger.recordAccepted({
      id: otherId,
      anchor: 'om_other',
      chatId: 'oc_other',
      scope: 'thread',
      cliId: 'codex',
      acceptedAtMs: 2_000,
      promptSummary: '另一个 Bot',
    });

    expect(ledger.listOutstanding('cli_a')).toEqual([]);
    expect(ledger.listOutstanding('cli_b')).toHaveLength(1);

    ledger.compact({ deliveredBeforeMs: 3_000 });

    expect(ledger.get({ ...id, turnId: 'old' })).toBeUndefined();
    expect(ledger.get({ ...id, turnId: 'new' })).toBeDefined();
    expect(ledger.get(otherId)).toBeDefined();
  });

  it('为同一轮次生成固定、长度受限且跨轮次隔离的 UUID', () => {
    expect(stableTurnDeliveryUuid(id))
      .toBe('bmx-final-818af0a0f2c2acfb29915a16b38295fd');
    expect(stableTurnDeliveryUuid(id)).toHaveLength(42);
    expect(stableTurnDeliveryUuid({ ...id, dispatchAttempt: 1 }))
      .not.toBe(stableTurnDeliveryUuid(id));
    expect(stableTurnDeliveryUuid({ ...id, larkAppId: '../cli_b' }))
      .toMatch(/^bmx-final-[0-9a-f]{32}$/);
  });
});
