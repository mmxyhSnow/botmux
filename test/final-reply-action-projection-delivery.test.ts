/**
 * 最终回复操作卡投递回归测试。
 *
 * 覆盖卡片发送成功后 actionSetId、messageId 与持久化 projection 的一致性，
 * 以及后续无操作回复对旧入口的终态化，防止升级合并再次只保留按钮而丢失账本。
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateMessageMock = vi.fn(async () => undefined);
const updateSessionMock = vi.fn();

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: (...args: unknown[]) => updateMessageMock(...args),
  addReaction: vi.fn(async () => 'reaction-id'),
  removeReaction: vi.fn(async () => undefined),
  sendUserMessage: vi.fn(async () => undefined),
  deleteMessage: vi.fn(async () => undefined),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {},
}));

vi.mock('../src/im/lark/doc-comment.js', () => ({
  replyToDocComment: vi.fn(async () => undefined),
  chunkCommentText: vi.fn((content: string) => [content]),
  unsubscribeDocFile: vi.fn(async () => undefined),
  removeCommentReaction: vi.fn(async () => undefined),
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
  resolveUsageDisplay: vi.fn(() => 'off'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/botmux-final-action-projection-test' },
    daemon: { backendType: 'tmux', cliId: 'codex-app' },
  },
}));

vi.mock('../src/core/cost-calculator.js', () => ({
  getSessionTokenUsage: vi.fn(() => null),
  getSessionUsageSnapshot: vi.fn(() => ({ context: null, tokens: null })),
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: (...args: unknown[]) => updateSessionMock(...args),
  createSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import {
  __testOnly_deliverFinalOutput,
  initWorkerPool,
} from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';

/** 构造能经过普通飞书最终回复链路的最小会话。 */
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
      sessionId: 'sid-final-action-projection',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'fixture',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
      cliId: 'codex-app',
    },
    worker,
    workerPort: 0,
    workerToken: 'token',
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1',
    lastMessageAt: Date.now(),
    hasHistory: false,
    adoptedFrom: {
      tmuxTarget: '0:1.0',
      originalCliPid: 1234,
      sessionId: 'codex-session',
      cliId: 'codex-app',
      cwd: '/tmp',
    },
  } as DaemonSession;
}

/** 生成带 v2 快捷操作协议的最终回复。 */
function actionOutput(): Extract<WorkerToDaemon, { type: 'final_output' }> {
  const marker = JSON.stringify({
    version: 2,
    actions: [{
      label: '修复操作卡',
      target: '恢复最终回复操作卡账本',
      scope: '仅修改投递链路',
      acceptance: '点击时通过最新 messageId 校验',
    }],
  });
  return {
    type: 'final_output',
    content: `修复建议。\n<!--botmux-actions:${marker}-->`,
    lastUuid: 'uuid-action',
    turnId: 'turn-action',
  };
}

describe('最终回复操作卡 projection 投递', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('发送后持久化与按钮完全一致的 actionSetId 和 messageId', async () => {
    const sessionReply = vi.fn(async () => 'om_action_card');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeSession();

    __testOnly_deliverFinalOutput(ds, actionOutput(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    const card = JSON.parse(sessionReply.mock.calls[0][1] as string);
    const callback = card.body.elements
      .find((element: any) => element.tag === 'column_set')
      .columns[0].elements[0].behaviors[0].value;
    expect(ds.session.finalReplyActionProjection).toMatchObject({
      actionSetId: callback.action_set_id,
      messageId: 'om_action_card',
      status: 'pending',
      turnId: 'turn-action',
      reprojectCount: 0,
    });
    expect(updateSessionMock).toHaveBeenCalledWith(ds.session);
  });

  it('后续回复不再提供操作时终态化旧入口', async () => {
    const sessionReply = vi.fn()
      .mockResolvedValueOnce('om_action_card')
      .mockResolvedValueOnce('om_plain_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const ds = makeSession();

    __testOnly_deliverFinalOutput(ds, actionOutput(), 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);
    __testOnly_deliverFinalOutput(ds, {
      type: 'final_output',
      content: '当前回复没有后续操作。',
      lastUuid: 'uuid-plain',
      turnId: 'turn-plain',
    }, 'tag', 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(ds.session.finalReplyActionProjection).toMatchObject({
      messageId: 'om_action_card',
      status: 'superseded',
    });
    expect(updateMessageMock).toHaveBeenCalledWith(
      'app_test',
      'om_action_card',
      expect.stringContaining('操作入口已移至下方最新卡片'),
    );
  });
});
