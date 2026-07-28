# Codex App Progress Card Timestamps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Codex App 即时进度卡的首条确认、每次真实进展和终态增加固定的北京时间 `[HH:mm:ss]` 前缀。

**Architecture:** 在 `CodexAppProgressCard` 写入内容时通过可注入时钟生成时间前缀，持久化完整文本，使卡片 PATCH 和进程重启不改变旧时间。原始 assistant 文本继续独立计算指纹，避免时间戳破坏去重。

**Tech Stack:** TypeScript、Vitest、Lark interactive card JSON、Node.js `Intl.DateTimeFormat`

## Global Constraints

- 时间格式固定为 `Asia/Shanghai`、24 小时制 `[HH:mm:ss]`。
- 首条确认、真实进展、完成/失败/中断终态分别记录事件发生时间。
- 已有无时间戳状态保持原样，只格式化新写入内容。
- 不修改持久化状态结构、卡片协议或最终答案发送通道。
- 先写失败测试，再写最小实现。

---

### Task 1: 为进度卡新增稳定的事件时间戳

**Files:**
- Modify: `test/codex-app-progress-card.test.ts`
- Modify: `src/services/codex-app-progress-card.ts`

**Interfaces:**
- Consumes: `CodexAppProgressCardOperations` 的现有 POST、PATCH 与持久化操作。
- Produces: 可选 `CodexAppProgressCardOperations.now(): Date` 测试时钟，以及内部 `timestampedContent(content: string, now: Date): string`。

- [ ] **Step 1: 写入失败测试**

在测试 harness 给操作对象注入按调用顺序返回的固定时间，并断言：

```ts
const h = harness(undefined, [
  '2026-07-28T11:11:58.000Z',
  '2026-07-28T11:12:07.000Z',
  '2026-07-28T11:13:09.000Z',
]);
await h.card.accept('om_turn', '时间测试');
await h.card.append('om_turn', '源码差异已经定位。');
await h.card.settle('om_turn', 'completed');
expect(h.card.snapshot()?.content).toBe(
  '[19:11:58] 已收到，开始处理。'
  + '\n\n[19:12:07] 源码差异已经定位。'
  + '\n\n[19:13:09] 本轮已完成，最终结果见最新回复。',
);
```

再用一份旧状态初始化卡片，断言旧内容不变而新增进展带时间：

```ts
expect(h.card.snapshot()?.content).toBe(
  '已收到，开始处理。\n\n[19:12:07] 新进展。',
);
```

- [ ] **Step 2: 运行测试并确认先失败**

Run:

```bash
pnpm vitest run --project unit test/codex-app-progress-card.test.ts
```

Expected: FAIL，实际内容缺少 `[19:11:58]` 等前缀。

- [ ] **Step 3: 写入最小实现**

给 operations 增加可选时钟并集中格式化：

```ts
now?(): Date;

const PROGRESS_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function timestampedContent(content: string, now: Date): string {
  return `[${PROGRESS_TIME_FORMATTER.format(now)}] ${content}`;
}
```

在 `startState`、`append`、`settle` 以及 `turnStarted` 关闭上一回合的终态处调用：

```ts
private now(): Date {
  return this.operations.now?.() ?? new Date();
}

this.state.content = `${this.state.content}\n\n${timestampedContent(trimmed, this.now())}`;
```

- [ ] **Step 4: 运行定向测试和类型检查**

Run:

```bash
pnpm vitest run --project unit test/codex-app-progress-card.test.ts test/codex-app-progress.test.ts test/session-lifecycle-hooks.test.ts
pnpm exec tsc --noEmit
```

Expected: 所有定向测试通过，TypeScript 无错误。

- [ ] **Step 5: 构建候选版本**

Run:

```bash
pnpm build
```

Expected: 构建、domain audit、Dashboard bundle 和 dist audit 全部通过，`dist/.runtime-build-id` 更新。

- [ ] **Step 6: 提交实现**

```bash
git add src/services/codex-app-progress-card.ts test/codex-app-progress-card.test.ts
git commit -m "feat: 为进度卡增加北京时间"
```

- [ ] **Step 7: 仅重启 Youc 并回读**

用当前 `/root/.botmux/ecosystem.config.json` 的 `botmux-0` 候选路径重建 Youc PM2 条目，确认：

```text
botmux-0       -> 候选 dist/index-daemon.js，online，新 runtime build id
botmux-1/2     -> 官方 3.6.0，PID 不变
botmux-dashboard -> 官方 3.6.0，PID 不变
```

下一条真实飞书消息应立即出现带 `[HH:mm:ss]` 的首条卡片；后续 commentary 和终态 PATCH 到同一张卡。
