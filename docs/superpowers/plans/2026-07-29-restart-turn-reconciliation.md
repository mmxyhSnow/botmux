# Botmux Restart Turn Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让所有 Bot/CLI 的普通可见工作轮次在 Botmux 重启后继续追踪，并对“已有结论但尚未投递”的轮次幂等补发到原线程。

**Architecture:** 新增 append-only `TurnDeliveryLedger` 记录 accepted、running、final、delivery 和 recovery 状态；Daemon 的输入接收与最终回复通道共同维护账本。Codex App Runner 在输出 OSC final 前额外写持久化 outbox，启动恢复器在 session 恢复后读取账本和可靠结果源，使用稳定飞书 UUID 补发缺失结论；其它 CLI 继续复用现有 transcript bridge，并把显式 `botmux send` 的覆盖回执关联到账本。

**Tech Stack:** TypeScript、Node.js 文件系统、Vitest、Botmux Worker IPC、飞书 IM UUID 幂等字段、现有 CLI transcript bridge。

## Global Constraints

- 覆盖所有 Bot、CLI 和普通可见工作线程；按 `larkAppId + sessionId + turnId + dispatchAttempt` 隔离。
- 不恢复已关闭、已撤回、静默调度、HTTP wait/async trigger、文档评论和 VC meeting 专用轮次。
- 不重放安装、提交、发布、删除、重启等外部副作用；未知状态只输出已确认事实和未完成结论。
- `delivered` 是唯一用户交付成功终态；进度卡变绿、CLI 空闲或 `turn_terminal(completed)` 都不能替代。
- 最终补发使用稳定且不超过 50 字符的飞书 UUID。
- 新增或修改的代码注释使用中文；普通源码文件控制在 300 行左右且不得超过 500 行。
- 每个任务按 TDD 执行并独立提交。

---

### Task 1: 持久化轮次交付账本

**Files:**
- Create: `src/services/turn-delivery-ledger.ts`
- Test: `test/turn-delivery-ledger.test.ts`

**Interfaces:**
- Produces:
  - `TurnDeliveryId`
  - `TurnDeliveryRecord`
  - `TurnDeliveryLedger`
  - `stableTurnDeliveryUuid(id: TurnDeliveryId): string`
- Consumes: `dataDir`、系统时钟和 Node.js append-only 文件能力。

- [ ] **Step 1: Write the failing tests**

覆盖同一轮次的单调状态、跨 Bot 隔离、并发重复事件、稳定 UUID、已关闭/静默轮次排除、未闭环查询和 delivered 清理：

```ts
const ledger = new TurnDeliveryLedger(dir, { now: () => 1000 });
const id = {
  larkAppId: 'cli_a',
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
  acceptedAtMs: 1000,
  promptSummary: '安装 humanizer-zh',
});
ledger.recordRunning(id, { nativeTurnId: 'app-turn-1', atMs: 1100 });
ledger.recordFinal(id, { content: '已安装', outcome: 'completed', observedAtMs: 1200 });
expect(ledger.listOutstanding('cli_a')).toHaveLength(1);
ledger.recordDelivered(id, { messageId: 'om_reply', deliveredAtMs: 1300 });
expect(ledger.listOutstanding('cli_a')).toEqual([]);
expect(stableTurnDeliveryUuid(id)).toMatch(/^bmx-final-[0-9a-f]{32}$/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run test/turn-delivery-ledger.test.ts`

Expected: FAIL because `turn-delivery-ledger.ts` does not exist.

- [ ] **Step 3: Implement the append-only ledger**

Use one JSONL file per Bot under `<dataDir>/turn-delivery/<encoded-app-id>.jsonl`. Each event is one `appendFileSync` call; replay validates exact keys and folds by monotonic rank:

```ts
export interface TurnDeliveryId {
  larkAppId: string;
  sessionId: string;
  turnId: string;
  dispatchAttempt: number;
}

export interface TurnDeliveryRecord {
  id: TurnDeliveryId;
  anchor: string;
  chatId: string;
  scope: 'thread' | 'chat';
  cliId: string;
  acceptedAtMs: number;
  promptSummary: string;
  nativeTurnId?: string;
  final?: { content: string; outcome: 'completed' | 'failed' | 'cancelled'; observedAtMs: number };
  delivery?: { state: 'pending' | 'delivered'; uuid: string; messageId?: string; atMs: number };
  recovery?: { state: 'required' | 'failed'; atMs: number; reason?: string };
}

export class TurnDeliveryLedger {
  constructor(
    readonly dataDir: string,
    opts?: { now?: () => number },
  );
  recordAccepted(input: Omit<TurnDeliveryRecord, 'nativeTurnId' | 'final' | 'delivery' | 'recovery'>): void;
  recordRunning(id: TurnDeliveryId, input: { atMs: number; nativeTurnId?: string }): void;
  recordFinal(id: TurnDeliveryId, input: NonNullable<TurnDeliveryRecord['final']>): void;
  recordDeliveryPending(id: TurnDeliveryId, input: { uuid: string; atMs: number }): void;
  recordDelivered(id: TurnDeliveryId, input: { messageId: string; deliveredAtMs: number }): void;
  recordRecoveryRequired(id: TurnDeliveryId, atMs: number): void;
  recordRecoveryFailed(id: TurnDeliveryId, input: { atMs: number; reason: string }): void;
  get(id: TurnDeliveryId): TurnDeliveryRecord | undefined;
  listOutstanding(larkAppId: string): TurnDeliveryRecord[];
  compact(input: { deliveredBeforeMs: number }): void;
}
```

`stableTurnDeliveryUuid()` 对 canonical JSON 做 SHA-256，输出 `bmx-final-` 加 32 位 hex，总长 42。

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run test/turn-delivery-ledger.test.ts`

Expected: PASS，且重复 replay 不改变折叠结果。

- [ ] **Step 5: Commit**

```bash
git add src/services/turn-delivery-ledger.ts test/turn-delivery-ledger.test.ts
git commit -m "feat(recovery): 增加轮次交付持久化账本"
```

---

### Task 2: 将普通工作轮次接入账本和幂等最终投递

**Files:**
- Modify: `src/daemon.ts`
- Modify: `src/core/worker-pool.ts`
- Modify: `src/types.ts`
- Modify: `src/services/bridge-fallback-gate.ts`
- Modify: `src/cli.ts`
- Test: `test/session-lifecycle-hooks.test.ts`
- Test: `test/bridge-fallback-gate.test.ts`
- Test: `test/turn-delivery-integration.test.ts`

**Interfaces:**
- Consumes: `TurnDeliveryLedger`、`stableTurnDeliveryUuid()`。
- Produces:
  - `WorkerToDaemon.final_output.alreadyDeliveredMessageId?: string`
  - `coveringBridgeSendMarker(...)`
  - Daemon 侧 accepted/running/final/delivered 生命周期事件。

- [ ] **Step 1: Write failing lifecycle and bridge tests**

验证：

```ts
expect(coveringBridgeSendMarker(turn, boundary, markers, false))
  .toEqual(expect.objectContaining({ messageId: 'om_explicit_final' }));
```

并驱动真实 `deliverFinalOutput` 测试 seam：

```ts
await harness.deliver({
  type: 'final_output',
  turnId: 'om_turn',
  lastUuid: 'native-final',
  content: '最终结论',
});
expect(ledger.get(id)?.final?.content).toBe('最终结论');
expect(reply).toHaveBeenCalledWith(
  expect.anything(),
  expect.anything(),
  expect.anything(),
  expect.anything(),
  'om_turn',
  expect.objectContaining({ uuid: stableTurnDeliveryUuid(id) }),
);
expect(ledger.get(id)?.delivery?.messageId).toBe('om_reply');
```

显式最终发送覆盖时，`reply` 必须为 0 次并把 marker 的 message id 记为 delivered；短进度发送不得关闭轮次。

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm vitest run test/bridge-fallback-gate.test.ts test/turn-delivery-integration.test.ts test/session-lifecycle-hooks.test.ts
```

Expected: FAIL on missing covering marker and missing ledger events.

- [ ] **Step 3: Record accepted and running**

在 `noteTurnReceived()` 完成进度卡创建之前记录 accepted。只接入普通可见 IM 轮次；使用现有 `silentScheduledTurns`、receiver、doc-comment 和 trigger flags 排除专用入口。`codex_app_turn_started` IPC 增加 `nativeTurnId?: string`，其它 CLI 在 Worker 首次确认执行时只记录 running，不伪造原生 id。

`promptSummary` 只保留规范化后的前 500 字符，不保存附件、Token 或完整终端输出。

- [ ] **Step 4: Make final delivery write-ahead and idempotent**

`deliverFinalOutput()` 在调用 `sessionReply()` 前执行：

```ts
ledger.recordFinal(id, {
  content: msg.content,
  outcome: 'completed',
  observedAtMs: Date.now(),
});
const uuid = stableTurnDeliveryUuid(id);
ledger.recordDeliveryPending(id, { uuid, atMs: Date.now() });
```

普通回复传入 `{ uuid }`。成功后立即记录 provider `messageId`。`alreadyDeliveredMessageId` 存在时不调用飞书，只记录 delivered。

重试使用同一 UUID；三次瞬时重试耗尽后保留 `delivery_pending`，不再“给 up 后遗忘”。

- [ ] **Step 5: Bind explicit `botmux send` to a covering final**

`BridgeSendMarker` 增加 `turnId?: string` 和 `contentHash?: string`。`cli.ts` 从 `BOTMUX_TURN_ID` 记录稳定 turn id。新增：

```ts
export function coveringBridgeSendMarker(
  turn: BridgeGateInput,
  nextBoundaryMs: number | undefined,
  markers: readonly BridgeSendMarker[],
  adoptMode: boolean,
): BridgeSendMarker | undefined;
```

现有 `shouldSuppressBridgeEmit()` 委托给它。Worker 在 marker 覆盖 final 时仍发送一个带 `alreadyDeliveredMessageId` 的 `final_output`，让 Daemon 有机会持久化 final 和 delivered，而不是只发送 `turn_terminal`。

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run test/bridge-fallback-gate.test.ts test/turn-delivery-integration.test.ts test/session-lifecycle-hooks.test.ts
```

Expected: PASS；普通进度发送之后仍会投递较长 final。

- [ ] **Step 7: Commit**

```bash
git add src/daemon.ts src/core/worker-pool.ts src/types.ts src/services/bridge-fallback-gate.ts src/cli.ts test/bridge-fallback-gate.test.ts test/turn-delivery-integration.test.ts test/session-lifecycle-hooks.test.ts
git commit -m "feat(recovery): 持久化工作轮次最终投递"
```

---

### Task 3: 为 Codex App 增加重启可追溯的 final outbox

**Files:**
- Create: `src/services/codex-app-final-outbox.ts`
- Modify: `src/codex-app-runner.ts`
- Modify: `src/services/codex-app-runner-protocol.ts`
- Test: `test/codex-app-final-outbox.test.ts`
- Test: `test/codex-app-turn-controller.test.ts`

**Interfaces:**
- Consumes: `CodexAppFinalMarker`、`SESSION_DATA_DIR`、`BOTMUX_SESSION_ID`。
- Produces:
  - `appendCodexAppFinalOutbox(...)`
  - `readCodexAppFinalOutbox(...)`
  - `ackCodexAppFinalOutbox(...)`

- [ ] **Step 1: Write the failing outbox tests**

```ts
appendCodexAppFinalOutbox(dir, 'session-a', {
  appTurnId: 'app-turn-1',
  replyTurnId: 'om_turn',
  content: '已安装并验证成功',
  outcome: 'completed',
  startedAtMs: 100,
  completedAtMs: 200,
});
expect(readCodexAppFinalOutbox(dir, 'session-a')).toEqual([
  expect.objectContaining({ replyTurnId: 'om_turn', content: '已安装并验证成功' }),
]);
ackCodexAppFinalOutbox(dir, 'session-a', 'app-turn-1');
expect(readCodexAppFinalOutbox(dir, 'session-a')).toEqual([]);
```

同时覆盖重复 append、半行、损坏行、路径穿越和连续重启 replay。

- [ ] **Step 2: Run test and verify RED**

Run: `pnpm vitest run test/codex-app-final-outbox.test.ts`

Expected: FAIL because the outbox module does not exist.

- [ ] **Step 3: Implement write-before-OSC ordering**

Outbox 路径为 `<dataDir>/codex-app-final-outbox/<sessionId>.jsonl`，ACK 为同目录 `<sessionId>.acked.json` 的原子 rename 快照。Runner 的 `onFinal` 必须严格按以下顺序：

```ts
onFinal: marker => {
  appendCodexAppFinalOutbox(
    process.env.SESSION_DATA_DIR!,
    args.sessionId,
    marker,
  );
  emitMarker('final', marker);
  writeLine();
},
```

outbox 写失败时输出 fatal diagnostic 并保留 Runner，不得先发一个不可追溯 OSC final。

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run test/codex-app-final-outbox.test.ts test/codex-app-turn-controller.test.ts
```

Expected: PASS，且测试明确断言 append 发生在 emitMarker 之前。

- [ ] **Step 5: Commit**

```bash
git add src/services/codex-app-final-outbox.ts src/codex-app-runner.ts src/services/codex-app-runner-protocol.ts test/codex-app-final-outbox.test.ts test/codex-app-turn-controller.test.ts
git commit -m "feat(codex-app): 持久化重启期间最终回复"
```

---

### Task 4: 启动后扫描所有 Bot 的未闭环轮次

**Files:**
- Create: `src/core/restart-turn-reconciler.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/worker-pool.ts`
- Modify: `src/daemon.ts`
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`
- Test: `test/restart-turn-reconciler.test.ts`
- Test: `test/restore-zombie-close.test.ts`

**Interfaces:**
- Consumes:
  - `TurnDeliveryLedger.listOutstanding(larkAppId)`
  - Codex App final outbox
  - `DaemonSession` 运行态
  - `sessionReply()` 幂等 UUID 通道
- Produces:
  - `reconcileOutstandingTurns(deps): Promise<RestartTurnReconcileSummary>`
  - `decideRestartTurnAction(input): RestartTurnAction`

- [ ] **Step 1: Write the recovery decision tests**

覆盖：

```ts
expect(decideRestartTurnAction({
  record: pendingFinal,
  session: activeIdleSession,
  reliableFinal: { content: '完成', outcome: 'completed' },
})).toEqual({ kind: 'deliver-final', content: '完成', outcome: 'completed' });

expect(decideRestartTurnAction({
  record: runningRecord,
  session: activeWorkingSession,
})).toEqual({ kind: 'keep-following' });

expect(decideRestartTurnAction({
  record: acceptedOnly,
  session: activeIdleSession,
})).toEqual({ kind: 'report-unconfirmed' });
```

并断言 closed、silent、doc、trigger、receiver 全部 `skip`；不同 `larkAppId` 不可见；同一恢复租约只执行一次。

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm vitest run test/restart-turn-reconciler.test.ts test/restore-zombie-close.test.ts
```

Expected: FAIL because reconciler does not exist.

- [ ] **Step 3: Implement pure decision and recovery lease**

`RestartTurnAction` 固定为：

```ts
export type RestartTurnAction =
  | { kind: 'skip'; reason: string }
  | { kind: 'deliver-final'; content: string; outcome: 'completed' | 'failed' | 'cancelled' }
  | { kind: 'keep-following' }
  | { kind: 'report-unconfirmed' };
```

租约文件放在 `<dataDir>/turn-delivery/leases/<turn-uuid>.json`，使用 `openSync(path, 'wx')` 抢占，60 秒过期；完成后删除，进程崩溃由过期时间恢复。

- [ ] **Step 4: Implement reliable result lookup**

查找顺序：

1. ledger 的 `final`；
2. Codex App outbox 中 `replyTurnId === record.id.turnId` 且 `appTurnId === nativeTurnId`；
3. 其它 CLI 等待现有 Worker transcript bridge 的 `final_output`；
4. Worker/persistent backend 正在工作时 `keep-following`；
5. 已空闲或退出且无 final 时 `report-unconfirmed`。

`report-unconfirmed` 只发送：

```text
Botmux 重启后已追溯此任务，但没有找到可靠的最终结论。
已确认进度：{lastProgressOrPromptSummary}
当前结论：任务状态未确认，未自动重放任何操作。
请继续在本线程补充要求，我会从现有状态继续处理。
```

它不向 CLI 注入新 prompt，因此不会重复外部副作用。

- [ ] **Step 5: Wire startup and progress recovery**

每个 Bot daemon 在 `await restoreActiveSessions(activeSessions)` 后调用 reconciler。若 `keep-following`，将该 `DaemonSession.suppressRecoveryCard` 清为 `false`，复用原 `streamCardId` 接续 PATCH；若 reliable final 存在，使用 ledger 稳定 UUID 在原 thread/chat route 补发并 ACK Codex App outbox。

立即扫描一次，再在 5 秒后扫描一次，吸收重启边界上刚落盘的 final；两个扫描共享租约和 delivered 账本，不会重复发送。

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run test/restart-turn-reconciler.test.ts test/restore-zombie-close.test.ts test/turn-delivery-integration.test.ts
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/core/restart-turn-reconciler.ts src/core/types.ts src/core/worker-pool.ts src/daemon.ts src/i18n/zh.ts src/i18n/en.ts test/restart-turn-reconciler.test.ts test/restore-zombie-close.test.ts
git commit -m "feat(recovery): 重启后追溯并补偿未闭环线程"
```

---

### Task 5: 故障注入、全量验证和 Live 部署

**Files:**
- Create: `test/restart-turn-reconciliation.e2e.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: Tasks 1-4 的 ledger、outbox、reconciler 和稳定 UUID。
- Produces: 可重复的重启故障注入用例和用户可见行为说明。

- [ ] **Step 1: Write the e2e failure-injection test**

用临时 dataDir 和 fake Lark provider 模拟：

1. accepted 后重启；
2. Runner 写 final outbox 后、Daemon 收 OSC 前重启；
3. 飞书接受稳定 UUID 后、本地 delivered 落盘前重启；
4. 第二次启动恢复；
5. 第三次启动确认没有第二条消息。

核心断言：

```ts
expect(provider.messages).toEqual([
  expect.objectContaining({
    uuid: stableTurnDeliveryUuid(id),
    content: expect.stringContaining('已安装并验证成功'),
  }),
]);
expect(provider.callsFor(stableTurnDeliveryUuid(id))).toBe(2);
expect(provider.messages).toHaveLength(1);
expect(ledger.get(id)?.delivery?.state).toBe('delivered');
```

- [ ] **Step 2: Run e2e and full relevant suite**

Run:

```bash
pnpm vitest run test/restart-turn-reconciliation.e2e.ts
pnpm vitest run test/turn-delivery-ledger.test.ts test/turn-delivery-integration.test.ts test/codex-app-final-outbox.test.ts test/restart-turn-reconciler.test.ts test/codex-app-turn-controller.test.ts test/bridge-fallback-gate.test.ts test/restore-zombie-close.test.ts
pnpm build
```

Expected: all PASS，TypeScript build exit 0。

- [ ] **Step 3: Run repository gates**

Run:

```bash
pnpm test
kmp-cli scan --rule script-size --root . --staged
git diff --check
```

Expected: all PASS；新增普通源码文件均不超过 500 行。

- [ ] **Step 4: Document behavior and commit**

README 的 Tmux 会话常驻章节补充：

```markdown
Daemon 重启后会扫描持久化的工作轮次交付账本：仍在运行的任务继续跟踪，
已产出但尚未投递的最终结论使用稳定飞书 UUID 补发到原线程；无法确认终态时
会明确报告“状态未确认”，不会静默结束或自动重放外部操作。
```

Commit:

```bash
git add README.md test/restart-turn-reconciliation.e2e.ts
git commit -m "test(recovery): 覆盖重启边界结论补偿"
```

- [ ] **Step 5: Push the exact branch**

Run:

```bash
git push origin p/zhangxin.snow/feature-codex-progress-card-v3.6.0
git rev-parse HEAD
git ls-remote origin refs/heads/p/zhangxin.snow/feature-codex-progress-card-v3.6.0
```

Expected: local HEAD equals remote SHA。

- [ ] **Step 6: Deploy this checkout and perform controlled live restart**

Run:

```bash
pnpm switch:here
pnpm daemon:restart
```

创建一个只读测试线程，等待首条进度后再次执行 `pnpm daemon:restart`。验收：

- 原进度卡继续更新；
- 原线程只收到一条最终结论；
- 再次重启不重复补发；
- `daemon-0-out.log` 出现 ledger reconcile delivered/skip 日志；
- `botmux history --session-id <test-session-id>` 中 final 可见且只有一次。

- [ ] **Step 7: Final verification**

Run:

```bash
botmux bots
ps -eo pid,lstart,args | rg '[b]otmux|[c]odex-app-runner'
git status --short
```

Expected: 所有 Bot online、Daemon/Worker 使用当前 checkout、工作树 clean。
