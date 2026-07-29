import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcileOutstandingTurns } from '../src/core/restart-turn-reconciler.js';
import {
  TurnDeliveryLedger,
  stableTurnDeliveryUuid,
  type TurnDeliveryId,
} from '../src/services/turn-delivery-ledger.js';
import {
  appendCodexAppFinalOutbox,
  readCodexAppFinalOutbox,
} from '../src/services/codex-app-final-outbox.js';

describe('重启边界最终结论补偿', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-restart-reconcile-e2e-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('provider 接受 UUID 后 Daemon 崩溃，后续两次重启只产生一条可见消息', async () => {
    const ledger = new TurnDeliveryLedger(dataDir, { now: () => 2_000 });
    const id: TurnDeliveryId = {
      larkAppId: 'app_a',
      sessionId: 'session-a',
      turnId: 'om_turn',
      dispatchAttempt: 0,
    };
    ledger.recordAccepted({
      id,
      anchor: 'om_root',
      chatId: 'oc_chat',
      scope: 'thread',
      cliId: 'codex-app',
      acceptedAtMs: 1_000,
      promptSummary: '安装并验证 skill',
    });
    ledger.recordRunning(id, { atMs: 1_100, nativeTurnId: 'app-turn-1' });

    // 模拟 Runner 已持久化 final，但 Daemon 在收到 OSC 之前重启。
    appendCodexAppFinalOutbox(dataDir, 'session-a', {
      appTurnId: 'app-turn-1',
      replyTurnId: 'om_turn',
      content: '已安装并验证成功',
      outcome: 'completed',
      completedAtMs: 1_200,
    });

    const provider = new IdempotentProvider();
    const send = async (_record: unknown, content: string, uuid: string): Promise<string> => {
      const messageId = provider.accept(uuid, content);
      if (provider.totalCalls === 1) {
        // 飞书已接受 UUID，但本地 delivered 尚未写入时 Daemon 崩溃。
        throw new Error('simulated crash after provider accepted UUID');
      }
      return messageId;
    };
    const input = {
      dataDir,
      larkAppId: 'app_a',
      ledger,
      sessions: [],
      send,
    };

    const first = await reconcileOutstandingTurns(input);
    expect(first.failed).toBe(1);
    expect(provider.messages).toHaveLength(1);

    const second = await reconcileOutstandingTurns(input);
    expect(second.delivered).toBe(1);

    const third = await reconcileOutstandingTurns(input);
    expect(third.scanned).toBe(0);

    const uuid = stableTurnDeliveryUuid(id);
    expect(provider.callsFor(uuid)).toBe(2);
    expect(provider.messages).toEqual([
      { uuid, content: '已安装并验证成功', messageId: 'om_provider_1' },
    ]);
    expect(ledger.get(id)?.delivery?.state).toBe('delivered');
    expect(readCodexAppFinalOutbox(dataDir, 'session-a')).toEqual([]);
  });
});

class IdempotentProvider {
  readonly messages: Array<{ uuid: string; content: string; messageId: string }> = [];
  private readonly callCounts = new Map<string, number>();
  totalCalls = 0;

  accept(uuid: string, content: string): string {
    this.totalCalls++;
    this.callCounts.set(uuid, (this.callCounts.get(uuid) ?? 0) + 1);
    const existing = this.messages.find(message => message.uuid === uuid);
    if (existing) return existing.messageId;
    const messageId = `om_provider_${this.messages.length + 1}`;
    this.messages.push({ uuid, content, messageId });
    return messageId;
  }

  callsFor(uuid: string): number {
    return this.callCounts.get(uuid) ?? 0;
  }
}
