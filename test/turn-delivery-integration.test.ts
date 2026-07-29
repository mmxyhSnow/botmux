import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {},
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{}'),
  buildSessionCard: vi.fn(() => '{}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Codex'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'codex-app' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-turn-delivery-integration' },
    daemon: { backendType: 'tmux', cliId: 'codex-app' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {},
  WSClient: class {},
  EventDispatcher: class {},
  LoggerLevel: { info: 2 },
}));

import {
  __testOnly_deliverFinalOutput,
  initWorkerPool,
  recordAcceptedTurnDelivery,
} from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';
import {
  TurnDeliveryLedger,
  stableTurnDeliveryUuid,
  type TurnDeliveryId,
} from '../src/services/turn-delivery-ledger.js';
import {
  appendCodexAppFinalOutbox,
  readCodexAppFinalOutbox,
} from '../src/services/codex-app-final-outbox.js';

const dataDir = '/tmp/test-turn-delivery-integration';

function makeSession(): DaemonSession {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.send = vi.fn();
  worker.kill = vi.fn();
  worker.pid = 99999;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  return {
    session: {
      sessionId: 'sid-final-out',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'fixture',
      status: 'active',
      createdAt: 1_000,
      updatedAt: 1_000,
      pid: null,
      chatType: 'group',
    },
    worker,
    workerPort: 0,
    workerToken: 'token',
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1_000,
    cliVersion: '1',
    lastMessageAt: 1_000,
    hasHistory: true,
  };
}

function accept(ledger: TurnDeliveryLedger, id: TurnDeliveryId): void {
  ledger.recordAccepted({
    id,
    anchor: 'om_root',
    chatId: 'oc_chat',
    scope: 'thread',
    cliId: 'codex-app',
    acceptedAtMs: 1_000,
    promptSummary: '执行任务',
  });
}

describe('普通轮次最终交付账本接入', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
  });

  it('只登记普通可见入站消息，并规范化提示摘要', () => {
    const ledger = new TurnDeliveryLedger(dataDir, { now: () => 2_000 });
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      turnDeliveryLedger: ledger,
    });
    const ds = makeSession();

    recordAcceptedTurnDelivery(ds, 'om_turn', '  第一行\n第二行  ');
    ds.silentScheduledTurns = new Map([['om_silent', Date.now()]]);
    recordAcceptedTurnDelivery(ds, 'om_silent', '静默调度');
    recordAcceptedTurnDelivery(ds, 'comment_1', '文档评论');

    expect(ledger.listOutstanding('app_test')).toEqual([
      expect.objectContaining({
        id: expect.objectContaining({ turnId: 'om_turn' }),
        promptSummary: '第一行 第二行',
      }),
    ]);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('在飞书发送前记录最终结论和稳定 UUID，成功后记录 provider 回执', async () => {
    const ledger = new TurnDeliveryLedger(dataDir, { now: () => 2_000 });
    const id: TurnDeliveryId = {
      larkAppId: 'app_test',
      sessionId: 'sid-final-out',
      turnId: 'om_turn',
      dispatchAttempt: 0,
    };
    accept(ledger, id);
    appendCodexAppFinalOutbox(dataDir, 'sid-final-out', {
      appTurnId: 'app-turn-1',
      replyTurnId: 'om_turn',
      content: '最终结论',
      outcome: 'completed',
    });
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      turnDeliveryLedger: ledger,
    });

    __testOnly_deliverFinalOutput(makeSession(), {
      type: 'final_output',
      content: '最终结论',
      lastUuid: 'native-final',
      turnId: 'om_turn',
      nativeTurnId: 'app-turn-1',
    }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).toHaveBeenCalledWith(
      'om_root',
      expect.any(String),
      'interactive',
      'app_test',
      'om_turn',
      expect.objectContaining({ uuid: stableTurnDeliveryUuid(id) }),
    );
    expect(ledger.get(id)).toEqual(expect.objectContaining({
      nativeTurnId: 'app-turn-1',
      final: expect.objectContaining({ content: '最终结论' }),
      delivery: expect.objectContaining({
        state: 'delivered',
        uuid: stableTurnDeliveryUuid(id),
        messageId: 'om_reply',
      }),
    }));
    expect(readCodexAppFinalOutbox(dataDir, 'sid-final-out')).toEqual([]);
  });

  it('显式发送已覆盖最终结论时不再发第二条消息，只登记已有回执', async () => {
    const ledger = new TurnDeliveryLedger(dataDir, { now: () => 2_000 });
    const id: TurnDeliveryId = {
      larkAppId: 'app_test',
      sessionId: 'sid-final-out',
      turnId: 'om_explicit',
      dispatchAttempt: 0,
    };
    accept(ledger, id);
    const sessionReply = vi.fn(async () => 'om_unexpected');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      turnDeliveryLedger: ledger,
    });
    const message: Extract<WorkerToDaemon, { type: 'final_output' }> = {
      type: 'final_output',
      content: '显式发送的最终结论',
      lastUuid: 'native-final',
      turnId: 'om_explicit',
      alreadyDeliveredMessageId: 'om_explicit_reply',
    };

    __testOnly_deliverFinalOutput(makeSession(), message, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(sessionReply).not.toHaveBeenCalled();
    expect(ledger.get(id)).toEqual(expect.objectContaining({
      final: expect.objectContaining({ content: '显式发送的最终结论' }),
      delivery: expect.objectContaining({
        state: 'delivered',
        messageId: 'om_explicit_reply',
      }),
    }));
  });
});
