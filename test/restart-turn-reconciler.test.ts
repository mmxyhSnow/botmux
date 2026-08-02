import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import {
  decideRestartTurnAction,
  reconcileOutstandingTurns,
} from '../src/core/restart-turn-reconciler.js';
import {
  TurnDeliveryLedger,
  stableTurnDeliveryUuid,
  type TurnDeliveryId,
} from '../src/services/turn-delivery-ledger.js';
import { appendCodexAppFinalOutbox } from '../src/services/codex-app-final-outbox.js';

describe('restart turn reconciler', () => {
  let dataDir: string;
  let ledger: TurnDeliveryLedger;
  const id: TurnDeliveryId = {
    larkAppId: 'app_a',
    sessionId: 'session-a',
    turnId: 'om_turn',
    dispatchAttempt: 0,
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-restart-turn-'));
    ledger = new TurnDeliveryLedger(dataDir, { now: () => 2_000 });
    accept(ledger, id);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('可靠 final 优先补发，仍在工作则继续跟踪，空闲且无结论则静默结算', () => {
    const record = ledger.get(id)!;
    expect(decideRestartTurnAction({
      record,
      session: sessionState('idle'),
      reliableFinal: { content: '完成', outcome: 'completed' },
    })).toEqual({ kind: 'deliver-final', content: '完成', outcome: 'completed' });

    expect(decideRestartTurnAction({
      record,
      session: sessionState('working'),
    })).toEqual({ kind: 'keep-following' });

    expect(decideRestartTurnAction({
      record,
      session: sessionState('idle'),
    })).toEqual({ kind: 'settle-silently', reason: 'not_in_flight' });
  });

  it('已关闭会话跳过，不会把旧任务重新打开', () => {
    expect(decideRestartTurnAction({
      record: ledger.get(id)!,
      session: sessionState('closed'),
      reliableFinal: { content: '迟到结论', outcome: 'completed' },
    })).toEqual({ kind: 'skip', reason: 'session_closed' });
  });

  it('从 Codex App outbox 找回 final，并用稳定 UUID 投递后 ACK', async () => {
    ledger.recordRunning(id, { atMs: 1_100, nativeTurnId: 'app-turn-1' });
    appendCodexAppFinalOutbox(dataDir, 'session-a', {
      appTurnId: 'app-turn-1',
      replyTurnId: 'om_turn',
      content: '已安装并验证成功',
      outcome: 'completed',
      completedAtMs: 1_200,
    });
    const send = vi.fn(async () => 'om_recovered');

    const summary = await reconcileOutstandingTurns({
      dataDir,
      larkAppId: 'app_a',
      ledger,
      sessions: [makeSession('idle')],
      send,
      now: () => 2_000,
    });

    expect(summary).toEqual(expect.objectContaining({ delivered: 1, failed: 0 }));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ id }),
      '已安装并验证成功',
      stableTurnDeliveryUuid(id),
    );
    expect(ledger.listOutstanding('app_a')).toEqual([]);
  });

  it('活跃任务恢复进度跟踪，不发送未确认消息', async () => {
    const ds = makeSession('working');
    ds.session.quoteTargetId = id.turnId;
    ds.suppressRecoveryCard = true;
    const send = vi.fn(async () => 'om_unexpected');

    const summary = await reconcileOutstandingTurns({
      dataDir,
      larkAppId: 'app_a',
      ledger,
      sessions: [ds],
      send,
    });

    expect(summary.following).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(ds.suppressRecoveryCard).toBe(false);
    expect(ledger.get(id)?.recovery?.state).toBe('required');
  });

  it('无可靠终态且没有执行中证据时静默持久结算，不向群里刷屏', async () => {
    const send = vi.fn(async () => 'om_unexpected');

    const summary = await reconcileOutstandingTurns({
      dataDir,
      larkAppId: 'app_a',
      ledger,
      sessions: [makeSession('idle')],
      send,
    });

    expect(send).not.toHaveBeenCalled();
    expect(summary.suppressed).toBe(1);
    expect(ledger.get(id)?.recovery).toEqual(expect.objectContaining({
      state: 'suppressed',
      reason: 'not_in_flight',
    }));
    expect(ledger.listOutstanding('app_a')).toEqual([]);
  });

  it('首轮扫描只延期静默结算，为恢复 worker 留出精确识别当前 turn 的窗口', async () => {
    const send = vi.fn(async () => 'om_unexpected');

    const summary = await reconcileOutstandingTurns({
      dataDir,
      larkAppId: 'app_a',
      ledger,
      sessions: [makeSession('idle')],
      send,
      settleUnconfirmed: false,
    });

    expect(send).not.toHaveBeenCalled();
    expect(summary.deferred).toBe(1);
    expect(ledger.get(id)?.recovery?.state).toBe('required');
    expect(ledger.listOutstanding('app_a')).toHaveLength(1);
  });

  it('只有进度卡精确绑定的当前 turn 可以解除恢复静默', async () => {
    const ds = makeSession('working');
    ds.session.codexAppProgressCard = {
      phase: 'running',
      activeTurnId: id.turnId,
      acceptedTurnIds: [id.turnId],
      pendingTurns: [],
      title: '生产部署',
      content: '已完成构建',
      overview: {
        stage: '运行态切换',
        current: '切换生产进程',
        completed: ['完成合入', '完成构建与推送'],
        next: '核对进程状态',
        evidence: ['commit abc123', 'build id build-1'],
        delivery: ['origin/custom/prod'],
      },
    };
    ds.suppressRecoveryCard = true;
    const send = vi.fn(async () => 'om_unexpected');

    const summary = await reconcileOutstandingTurns({
      dataDir,
      larkAppId: 'app_a',
      ledger,
      sessions: [ds],
      send,
    });

    expect(send).not.toHaveBeenCalled();
    expect(summary.following).toBe(1);
    expect(ds.suppressRecoveryCard).toBe(false);
  });

  it('同一 working session 的历史 turn 不得借用当前 turn 状态解除静默', async () => {
    const ds = makeSession('working');
    ds.session.codexAppProgressCard = {
      phase: 'running',
      activeTurnId: 'om_other_turn',
      acceptedTurnIds: ['om_other_turn'],
      pendingTurns: [],
      title: '其它任务',
      content: '其它任务进度',
      overview: {
        stage: '不应出现',
        current: '不应串用',
        completed: ['其它任务已完成'],
        next: '其它任务下一步',
      },
    };
    ds.session.quoteTargetId = 'om_other_turn';
    ds.suppressRecoveryCard = true;
    const send = vi.fn(async () => 'om_unexpected');

    const summary = await reconcileOutstandingTurns({
      dataDir,
      larkAppId: 'app_a',
      ledger,
      sessions: [ds],
      send,
    });

    expect(send).not.toHaveBeenCalled();
    expect(summary.suppressed).toBe(1);
    expect(summary.following).toBe(0);
    expect(ds.suppressRecoveryCard).toBe(true);
  });

  it('静默结算后出现晚到 final 会重新进入待投递集合', () => {
    ledger.recordRecoverySuppressed(id, { atMs: 1_500, reason: 'not_in_flight' });
    expect(ledger.listOutstanding('app_a')).toEqual([]);

    ledger.recordFinal(id, {
      content: '晚到但可靠的最终结论',
      outcome: 'completed',
      observedAtMs: 1_800,
    });

    expect(ledger.listOutstanding('app_a')).toHaveLength(1);
    expect(ledger.get(id)?.recovery).toBeUndefined();
  });

  it('并发扫描通过恢复租约只执行一次外部发送', async () => {
    ledger.recordFinal(id, {
      content: '唯一结论',
      outcome: 'completed',
      observedAtMs: 1_500,
    });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(async () => {
      await blocked;
      return 'om_once';
    });
    const input = {
      dataDir,
      larkAppId: 'app_a',
      ledger,
      sessions: [makeSession('idle')],
      send,
    };

    const first = reconcileOutstandingTurns(input);
    const second = reconcileOutstandingTurns(input);
    await Promise.resolve();
    release();
    await Promise.all([first, second]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(ledger.listOutstanding('app_a')).toEqual([]);
  });

  function accept(target: TurnDeliveryLedger, turnId: TurnDeliveryId): void {
    target.recordAccepted({
      id: turnId,
      anchor: 'om_root',
      chatId: 'oc_chat',
      scope: 'thread',
      cliId: 'codex-app',
      acceptedAtMs: 1_000,
      promptSummary: '原始任务',
    });
  }

  function sessionState(
    state: 'working' | 'idle' | 'closed',
  ): { status: 'active' | 'closed'; working: boolean } {
    return {
      status: state === 'closed' ? 'closed' : 'active',
      working: state === 'working',
    };
  }

  function makeSession(state: 'working' | 'idle'): DaemonSession {
    return {
      session: {
        sessionId: 'session-a',
        rootMessageId: 'om_root',
        chatId: 'oc_chat',
        title: 'fixture',
        status: 'active',
        createdAt: 1_000,
        updatedAt: 1_000,
        pid: null,
        chatType: 'group',
        cliId: 'codex-app',
      },
      worker: state === 'working' ? { killed: false } as any : null,
      workerPort: null,
      workerToken: null,
      larkAppId: 'app_a',
      chatId: 'oc_chat',
      chatType: 'group',
      scope: 'thread',
      spawnedAt: 1_000,
      cliVersion: '1',
      lastMessageAt: 1_000,
      hasHistory: true,
      lastScreenStatus: state,
    };
  }
});
