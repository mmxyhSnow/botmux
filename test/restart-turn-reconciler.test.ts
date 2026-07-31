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

  it('可靠 final 优先补发，仍在工作则继续跟踪，空闲且无结论则明确未确认', () => {
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
    })).toEqual({ kind: 'report-unconfirmed' });
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

  it('无可靠终态时发送明确的状态未确认结论，且不重放任务', async () => {
    const send = vi.fn(async () => 'om_unconfirmed');

    await reconcileOutstandingTurns({
      dataDir,
      larkAppId: 'app_a',
      ledger,
      sessions: [makeSession('idle')],
      send,
      formatUnconfirmed: record => `状态未确认：${record.promptSummary}`,
    });

    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      '状态未确认：原始任务',
      stableTurnDeliveryUuid(id),
    );
    expect(ledger.listOutstanding('app_a')).toEqual([]);
  });

  it('无可靠终态时优先使用与当前 turn 精确匹配的结构化进度', async () => {
    const ds = makeSession('idle');
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
    const send = vi.fn(async () => 'om_structured_progress');

    await reconcileOutstandingTurns({
      dataDir,
      larkAppId: 'app_a',
      ledger,
      sessions: [ds],
      send,
      formatUnconfirmed: (record, progress) => [
        record.promptSummary,
        progress?.stage,
        progress?.current,
        progress?.completed.join('；'),
        progress?.evidence?.join('；'),
      ].filter(Boolean).join('\n'),
    });

    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('运行态切换'),
      stableTurnDeliveryUuid(id),
    );
    expect(send.mock.calls[0]?.[1]).toContain('完成合入；完成构建与推送');
    expect(send.mock.calls[0]?.[1]).toContain('commit abc123；build id build-1');
  });

  it('结构化进度属于其它 turn 时回退到原始任务，避免串用旧任务状态', async () => {
    const ds = makeSession('idle');
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
    const send = vi.fn(async () => 'om_prompt_fallback');

    await reconcileOutstandingTurns({
      dataDir,
      larkAppId: 'app_a',
      ledger,
      sessions: [ds],
      send,
      formatUnconfirmed: (record, progress) => progress?.current ?? record.promptSummary,
    });

    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      '原始任务',
      stableTurnDeliveryUuid(id),
    );
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
