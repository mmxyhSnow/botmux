# Codex App 即时进度卡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为显式开启配置的 Codex App 机器人增加“消息准入后立即建卡、真实进展持续更新原卡、任务结束后收口且最终答案独立发送”的能力。

**Architecture:** 复用 daemon 的 `noteTurnReceived` 作为首响边界，新增独立的进度卡状态机负责串行 POST/PATCH 与持久化。Codex App controller 只提取真实 assistant progress，经 runner OSC、worker IPC 送到 daemon；现有 `turn_terminal` 负责完成、失败和中断收口，现有 `final_output` 发送路径保持不变。

**Tech Stack:** TypeScript、Node.js、Vitest、Lark Interactive Card v2、Codex app-server JSON-RPC、Botmux runner OSC 与 worker IPC。

## Global Constraints

- 基线固定为官方 `v3.6.0`；不合并旧 `dev`，只按行为重新实现。
- 功能仅在 `codexAppImmediateProgressCard === true` 且有效 CLI 为 `codex-app` 时开启，默认关闭。
- 首卡失败、PATCH 失败或恢复失败都不得阻塞用户消息进入 Codex App。
- 最终答案继续作为新消息发送，禁止用 PATCH 代替最终答案。
- steer 接受后复用当前任务卡；拒绝并转入下一 turn 时，下一 turn 启动后创建新卡。
- 所有新增或修改的代码注释使用中文。
- 当前阶段只构建和测试候选版本，不切换线上运行版本。

---

### Task 1: 配置开关与持久化状态契约

**Files:**
- Modify: `src/bot-registry.ts`
- Modify: `src/types.ts`
- Modify: `test/bot-config-store.test.ts`

**Interfaces:**
- Produces: `BotConfig.codexAppImmediateProgressCard?: boolean`
- Produces: `Session.codexAppProgressCard?: CodexAppProgressCardSessionState`
- Produces:

```ts
export type CodexAppProgressCardPhase =
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted';

export interface CodexAppProgressCardSessionState {
  activeTurnId: string;
  acceptedTurnIds: string[];
  pendingTurns: Array<{ turnId: string; title: string }>;
  messageId?: string;
  title: string;
  content: string;
  phase: CodexAppProgressCardPhase;
  lastFingerprint?: string;
  repostedAfterWithdraw?: boolean;
}
```

- [ ] **Step 1: 写配置解析失败测试**

在 `test/bot-config-store.test.ts` 增加严格布尔解析用例：

```ts
it('parses codexAppImmediateProgressCard strictly and defaults it off', async () => {
  const { registry } = await freshModules();
  const [on, off, invalid, missing] = registry.parseBotConfigsFromText(JSON.stringify([
    { larkAppId: 'progress-on', larkAppSecret: 's', cliId: 'codex-app', codexAppImmediateProgressCard: true },
    { larkAppId: 'progress-off', larkAppSecret: 's', cliId: 'codex-app', codexAppImmediateProgressCard: false },
    { larkAppId: 'progress-invalid', larkAppSecret: 's', cliId: 'codex-app', codexAppImmediateProgressCard: 'true' },
    { larkAppId: 'progress-missing', larkAppSecret: 's', cliId: 'codex-app' },
  ]));
  expect(on.codexAppImmediateProgressCard).toBe(true);
  expect(off.codexAppImmediateProgressCard).toBeUndefined();
  expect(invalid.codexAppImmediateProgressCard).toBeUndefined();
  expect(missing.codexAppImmediateProgressCard).toBeUndefined();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm vitest run --project unit test/bot-config-store.test.ts
```

Expected: FAIL，`codexAppImmediateProgressCard` 尚未出现在解析结果中。

- [ ] **Step 3: 增加最小配置与状态类型**

在 `BotConfig` 中新增带中文契约注释的开关；在 `parseBotConfigsFromText` 的返回对象中只接受精确 `true`：

```ts
codexAppImmediateProgressCard: entry.codexAppImmediateProgressCard === true || undefined,
```

在 `src/types.ts` 中加入上述 phase、session state 与 `Session.codexAppProgressCard` 字段，不增加 Dashboard 字段。

- [ ] **Step 4: 运行定向测试与类型检查**

Run:

```bash
pnpm vitest run --project unit test/bot-config-store.test.ts
pnpm exec tsc --noEmit
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/bot-registry.ts src/types.ts test/bot-config-store.test.ts
git commit -m "feat: 增加 Codex App 即时进度卡开关"
```

---

### Task 2: 独立进度卡状态机与卡片渲染

**Files:**
- Create: `src/services/codex-app-progress-card.ts`
- Create: `test/codex-app-progress-card.test.ts`

**Interfaces:**
- Consumes: `CodexAppProgressCardSessionState`、`CodexAppProgressCardPhase`
- Produces:

```ts
export interface CodexAppProgressCardOperations {
  post(cardJson: string, turnId: string): Promise<string>;
  patch(messageId: string, cardJson: string): Promise<void>;
  isWithdrawn(error: unknown): boolean;
  persist(state: CodexAppProgressCardSessionState | undefined): void;
}

export class CodexAppProgressCard {
  accept(turnId: string, title: string): Promise<void>;
  startQueued(turnId: string): Promise<void>;
  acceptSteer(turnId: string): Promise<void>;
  append(turnId: string, content: string): Promise<void>;
  settle(turnId: string, phase: Exclude<CodexAppProgressCardPhase, 'running'>): Promise<void>;
}

export function buildCodexAppProgressCard(
  state: CodexAppProgressCardSessionState,
): string;
```

- [ ] **Step 1: 写状态机失败测试**

覆盖以下断言：

```ts
it('posts immediately, patches serially, and deduplicates progress', async () => {
  const card = createCardHarness();
  await card.instance.accept('om_1', '检查部署');
  await Promise.all([
    card.instance.append('om_1', '已读取当前版本。'),
    card.instance.append('om_1', '已读取当前版本。'),
    card.instance.append('om_1', '正在核对配置。'),
  ]);
  expect(card.post).toHaveBeenCalledTimes(1);
  expect(card.patch).toHaveBeenCalledTimes(2);
  expect(card.state().content).toContain('已收到，开始处理。');
  expect(card.state().content.match(/已读取当前版本。/g)).toHaveLength(1);
});
```

再覆盖：

- running 状态收到补充消息只 PATCH `已收到补充要求，继续处理。`，不 POST 新卡；
- `acceptSteer` 把补充 turn 加入 `acceptedTurnIds`；
- terminal 后 `startQueued` 为拒绝 steer 的排队 turn 新建卡；
- `settle(completed)` 使用绿色标题并追加“任务已完成，结果见下方最终回复。”；
- 首次 POST 失败仍持久化无 `messageId` 的 running 状态，下一条真实进展会重试 POST；
- withdrawn PATCH 最多重建一次；
- 从持久化 state 构造后继续 PATCH 原 `messageId`。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm vitest run --project unit test/codex-app-progress-card.test.ts
```

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现状态机**

实现要点：

```ts
private enqueue(operation: () => Promise<void>): Promise<void> {
  const next = this.chain.then(operation, operation);
  this.chain = next.catch(() => undefined);
  return next;
}
```

`accept` 在没有 running 卡时先持久化以 `已收到，开始处理。` 初始化的状态，再尝试建卡；POST 失败时保留无 `messageId` 的 running 状态，供后续 `append` 重试。已有 running 卡时登记 `pendingTurns` 并追加补充确认。`append` 只接受 `activeTurnId` 或 `acceptedTurnIds` 中的 turn，按规范化文本指纹去重。`settle` 只收口属于当前任务的 turn。

`buildCodexAppProgressCard` 使用 `buildCardBodyElements` 渲染正文，header 模板映射：

```ts
const templateByPhase = {
  running: 'turquoise',
  completed: 'green',
  failed: 'red',
  interrupted: 'grey',
} as const;
```

标题和正文均限制长度；标题移除换行与控制字符，正文继续走现有 Markdown 消毒路径。

- [ ] **Step 4: 运行测试**

Run:

```bash
pnpm vitest run --project unit test/codex-app-progress-card.test.ts
pnpm exec tsc --noEmit
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/services/codex-app-progress-card.ts test/codex-app-progress-card.test.ts
git commit -m "feat: 实现 Codex App 进度卡状态机"
```

---

### Task 3: 从 app-server 提取真实 assistant progress

**Files:**
- Create: `src/services/codex-app-progress.ts`
- Create: `test/codex-app-progress.test.ts`
- Modify: `src/services/codex-app-turn-controller.ts`
- Modify: `test/codex-app-turn-controller.test.ts`

**Interfaces:**
- Produces:

```ts
export interface CodexAppProgressSnapshot {
  turnId?: string;
  content: string;
  startedAtMs: number;
  updatedAtMs: number;
}

export class CodexAppProgressThrottler {
  resetTo(text?: string): void;
  drain(input: {
    turnId?: string;
    text: string;
    startedAtMs: number;
    nowMs: number;
    force?: boolean;
  }): CodexAppProgressSnapshot[];
}
```

- Extends `CodexAppTurnControllerDeps` with:

```ts
onProgress?(snapshot: CodexAppProgressSnapshot): void;
```

- [ ] **Step 1: 写进度分段失败测试**

在 `test/codex-app-progress.test.ts` 覆盖：

```ts
it('emits only complete incremental sentences', () => {
  const progress = new CodexAppProgressThrottler();
  expect(progress.drain({ turnId: 'om_1', text: '正在检查', startedAtMs: 1, nowMs: 2 })).toEqual([]);
  expect(progress.drain({ turnId: 'om_1', text: '正在检查。已找到原因。', startedAtMs: 1, nowMs: 3 })
    .map(item => item.content)).toEqual(['正在检查。', '已找到原因。']);
  expect(progress.drain({ turnId: 'om_1', text: '正在检查。已找到原因。', startedAtMs: 1, nowMs: 4 })).toEqual([]);
});
```

另测 Markdown 空白归一化、最大长度、reset 后只发送 steer 之后的新文本。

- [ ] **Step 2: 写 controller progress 失败测试**

扩展 `createHarness` 收集 `progresses`。模拟 `item/started` 的 commentary、两个 delta 和 `item/completed`，断言进度绑定当前 `replyTurnId`；模拟已接受 steer 后的新 commentary，断言仍属于新 `replyTurnId`，但不重复旧文本；`phase === 'final_answer'` 不进入 progress。

- [ ] **Step 3: 运行测试确认失败**

Run:

```bash
pnpm vitest run --project unit test/codex-app-progress.test.ts test/codex-app-turn-controller.test.ts
```

Expected: FAIL，throttler 与 `onProgress` 尚不存在。

- [ ] **Step 4: 实现进度提取**

在 `ActiveTurn` 增加 `progress`、`itemPhase`。`item/started` 记录 agent message phase；`item/agentMessage/delta` 只把非 `final_answer` 文本交给 throttler；`item/completed` 对非最终 assistant message 用 `force: true` 排空完整内容。

steer 成功后执行：

```ts
turn.progress.resetTo(turn.allAgentText);
turn.replyTurnId = input.replyTurnId ?? turn.replyTurnId;
```

随后真实的新 commentary 使用更新后的 reply route。不要转发 command output、工具参数或 reasoning。

- [ ] **Step 5: 运行定向测试**

Run:

```bash
pnpm vitest run --project unit test/codex-app-progress.test.ts test/codex-app-turn-controller.test.ts
pnpm exec tsc --noEmit
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/services/codex-app-progress.ts src/services/codex-app-turn-controller.ts test/codex-app-progress.test.ts test/codex-app-turn-controller.test.ts
git commit -m "feat: 提取 Codex App 真实进展"
```

---

### Task 4: 打通 runner、worker 与 daemon 的进度协议

**Files:**
- Modify: `src/codex-app-runner.ts`
- Modify: `src/worker.ts`
- Modify: `src/types.ts`
- Modify: `src/services/codex-app-runner-protocol.ts`
- Modify: `test/codex-app-runner.integration.test.ts`
- Modify: `test/codex-app-runner-protocol.test.ts`

**Interfaces:**
- Produces OSC marker: `botmux:progress:<base64-json>`
- Produces:

```ts
export interface CodexAppProgressMarker {
  content: string;
  turnId: string;
  startedAtMs: number;
  updatedAtMs: number;
}

export function normalizeCodexAppProgressMarker(
  payload: unknown,
): CodexAppProgressMarker | undefined;
```

- Produces Worker IPC:

```ts
| { type: 'progress_output'; content: string; turnId: string }
| { type: 'codex_app_turn_started'; turnId: string }
```

- [ ] **Step 1: 写 runner/协议失败测试**

在 runner integration 中让 fake app-server 发送 commentary agent message，断言：

```ts
expect(decodeProgressMarkers(result.output)).toEqual([
  expect.objectContaining({
    content: '已确认当前版本。',
    turnId: 'om_integration_123',
  }),
]);
```

在协议测试中验证空 turn ID、空内容、超长 turn ID 和伪造字段被拒绝。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm vitest run --project unit test/codex-app-runner-protocol.test.ts
pnpm vitest run --project unit test/codex-app-runner.integration.test.ts
```

Expected: FAIL，progress marker 尚未生成。

- [ ] **Step 3: runner 发出受信进度 marker**

把 controller 的 `onProgress` 接到：

```ts
onProgress: snapshot => emitMarker('progress', snapshot),
```

生命周期 `turn_start_attempt` 保留既有 marker，由 worker 投影为 `codex_app_turn_started`；`steer_accepted` 继续复用已有 IPC。

- [ ] **Step 4: worker 严格校验并转成 IPC**

在 `normalizeCodexAppProgressMarker` 和 `handleCodexAppMarker` 中只接受：

- `payload.content` 为非空字符串；
- `payload.turnId` 在 `submittedCodexAppReplyTurnIds`；
- content 截断到卡片允许长度；
- 仅当前 `cliId === 'codex-app'`。

通过后发送 `progress_output`。生命周期 `turn_start_attempt` 通过同样的 reply turn 校验后发送 `codex_app_turn_started`。

- [ ] **Step 5: 运行测试与类型检查**

Run:

```bash
pnpm vitest run --project unit test/codex-app-runner-protocol.test.ts test/codex-app-runner.integration.test.ts
pnpm exec tsc --noEmit
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/codex-app-runner.ts src/worker.ts src/types.ts src/services/codex-app-runner-protocol.ts test/codex-app-runner.integration.test.ts test/codex-app-runner-protocol.test.ts
git commit -m "feat: 打通 Codex App 进度传输链路"
```

---

### Task 5: daemon 首卡、steer 复用与终态收口

**Files:**
- Modify: `src/core/worker-pool.ts`
- Modify: `src/daemon.ts`
- Modify: `test/turn-reactions.test.ts`
- Create: `test/codex-app-progress-lifecycle.test.ts`

**Interfaces:**
- Produces:

```ts
export function beginCodexAppProgressTurn(
  ds: DaemonSession,
  turnId: string,
  title: string,
): Promise<void>;
```

- Internal operations: `appendCodexAppProgress`、`acceptCodexAppSteer`、`startQueuedCodexAppTurn`、`settleCodexAppProgress`

- [ ] **Step 1: 写首响顺序失败测试**

在 `test/turn-reactions.test.ts` 的 harness 中启用 `codexAppImmediateProgressCard`，记录 `sessionReply` 与 worker `send` 调用顺序：

```ts
await noteTurnReceived(ds, 'om_turn', '检查 Botmux');
expect(sessionReply).toHaveBeenCalledWith(
  expect.any(String),
  expect.stringContaining('已收到，开始处理。'),
  'interactive',
  ds.larkAppId,
  'om_turn',
);
expect(ds.session.codexAppProgressCard?.phase).toBe('running');
```

另测默认关闭、非 `codex-app`、非 `om_` 输入均不建卡；POST 报错时 `noteTurnReceived` resolve 而不是 reject。

- [ ] **Step 2: 写生命周期失败测试**

在新测试中通过 `initWorkerPool` 的伪 worker 触发：

- `progress_output`：PATCH 原卡并增量追加；
- `steer_accepted`：新 turn 加入当前任务，后续进度仍 PATCH 原卡；
- `turn_terminal completed`：状态卡变绿，最终答案 mock 仍独立发送；
- `turn_terminal failed/cancelled/ambiguous`：分别映射失败或中断；
- `codex_app_turn_started`：当 pending turn 是 steer fallback 且旧卡已终态时 POST 新卡；
- daemon session 从持久化状态恢复后 PATCH 原 `messageId`。

- [ ] **Step 3: 运行测试确认失败**

Run:

```bash
pnpm vitest run --project unit test/turn-reactions.test.ts test/codex-app-progress-lifecycle.test.ts
```

Expected: FAIL，worker-pool 尚未接入状态机。

- [ ] **Step 4: 接入首卡**

在 worker-pool 用 `WeakMap<DaemonSession, CodexAppProgressCard>` 管理实例，operations 使用：

```ts
post: (cardJson, turnId) => cb.sessionReply(
  sessionAnchorId(ds),
  cardJson,
  'interactive',
  ds.larkAppId,
  fallbackTurnId(ds, turnId),
),
patch: (messageId, cardJson) => updateMessage(ds.larkAppId, messageId, cardJson),
persist: state => {
  ds.session.codexAppProgressCard = state;
  sessionStore.updateSession(ds.session);
},
```

`beginCodexAppProgressTurn` 内部再次校验 feature flag 与有效 CLI。`noteTurnReceived` 在 reaction 逻辑之前 `await` 该函数，并捕获日志，确保卡片尝试完成后才投递 worker。

- [ ] **Step 5: 接入进展、steer 和终态**

worker-pool 新增消息分支：

```ts
case 'progress_output':
  await progressCardFor(ds).append(msg.turnId, msg.content);
  break;
case 'codex_app_turn_started':
  await progressCardFor(ds).startQueued(msg.turnId);
  break;
```

在既有 `steer_accepted` 分支调用 `acceptSteer`。在通过 session/generation 校验后的 `turn_terminal` 分支先 best-effort `settle`，映射：

```ts
completed -> completed
failed -> failed
cancelled | ambiguous -> interrupted
```

`claude_exit` 仅在没有可信 terminal 且当前卡仍 running 时 best-effort 标记 failed；正常重启不得覆盖已完成状态。

- [ ] **Step 6: 运行定向测试**

Run:

```bash
pnpm vitest run --project unit test/turn-reactions.test.ts test/codex-app-progress-lifecycle.test.ts test/bridge-final-output-retry.test.ts
pnpm exec tsc --noEmit
```

Expected: PASS，且最终答案测试仍验证 fresh message 发送。

- [ ] **Step 7: 提交**

```bash
git add src/core/worker-pool.ts src/daemon.ts test/turn-reactions.test.ts test/codex-app-progress-lifecycle.test.ts
git commit -m "feat: 接入 Codex App 即时进度卡生命周期"
```

---

### Task 6: 回归验证与候选构建

**Files:**
- Modify only if a failing regression requires a scoped fix.

**Interfaces:**
- Consumes all previous task outputs.
- Produces a buildable, test-verified candidate commit; does not deploy.

- [ ] **Step 1: 运行进度卡相关测试集**

```bash
pnpm vitest run --project unit \
  test/bot-config-store.test.ts \
  test/codex-app-progress-card.test.ts \
  test/codex-app-progress.test.ts \
  test/codex-app-turn-controller.test.ts \
  test/codex-app-runner-protocol.test.ts \
  test/codex-app-runner.integration.test.ts \
  test/turn-reactions.test.ts \
  test/codex-app-progress-lifecycle.test.ts \
  test/bridge-final-output-retry.test.ts
```

Expected: PASS。

- [ ] **Step 2: 运行完整 unit 测试**

```bash
pnpm test
```

Expected: PASS。

- [ ] **Step 3: 构建官方候选包**

```bash
pnpm build
```

Expected: TypeScript、Dashboard bundle、dist audit 全部成功。

- [ ] **Step 4: 核对最终差异**

```bash
git diff --check v3.6.0...HEAD
git diff --stat v3.6.0...HEAD
git status --short
```

Expected: 无空白错误；工作区 clean；差异仅包含设计、计划、配置、进度链路及测试。

- [ ] **Step 5: 处理验证结果**

全部通过时不创建空提交。若验证失败，回到引入该行为的 Task，在对应源码与测试文件上重新执行“失败测试 → 最小修复 → 测试通过 → 原 Task 提交”的闭环，然后重新从本 Task Step 1 开始验证。

- [ ] **Step 6: 交付候选版本**

回报：

- 分支名与 HEAD；
- 相对官方 `v3.6.0` 的提交列表；
- 定向测试、完整 unit、build 结果；
- 当前线上仍为官方 3.6.0；
- 部署需要用户单独确认。
