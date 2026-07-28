# Codex App Progress Card Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 达到 8 个内容块或 1800 字时，把 Codex App 长任务进展续到新卡，并把旧卡冻结为可恢复的归档页。

**Architecture:** 新增独立分页判断模块，卡片状态保留当前页并增加归档页列表。内容写入仍由 `CodexAppProgressCard` 串行化；换页后先 POST 最新页，再 PATCH 旧页为灰色归档，失败状态持久化供下一次同步重试。

**Tech Stack:** TypeScript、Vitest、Lark interactive card JSON、现有 Botmux session 持久化

## Global Constraints

- 每页最多 8 个内容块或 1800 字，任一先到即在下一内容块写入前换页。
- 不拆分单个内容块；单条超长内容独占一页。
- 新页优先可见，旧页随后归档；任一网络失败不得丢内容。
- 现有单页状态必须无迁移脚本兼容。
- 最终答案通道、时间戳、steer、去重与当前页撤回补发语义不变。
- 先写失败测试，再写最小实现。

---

### Task 1: 分页边界与持久化页状态

**Files:**
- Create: `src/services/codex-app-progress-pagination.ts`
- Modify: `src/types.ts`
- Create: `test/codex-app-progress-pagination.test.ts`

**Interfaces:**
- Produces: `PROGRESS_CARD_PAGE_MAX_ENTRIES = 8`
- Produces: `PROGRESS_CARD_PAGE_MAX_CHARS = 1800`
- Produces: `countProgressCardEntries(content: string): number`
- Produces: `shouldStartProgressCardPage(input: { currentContent: string; currentEntryCount: number; nextEntry: string }): boolean`
- Produces: `CodexAppProgressCardArchivedPage`

- [ ] **Step 1: 写分页失败测试**

```ts
expect(shouldStartProgressCardPage({
  currentContent: Array(8).fill('[19:00:00] 进展。').join('\n\n'),
  currentEntryCount: 8,
  nextEntry: '[19:01:00] 下一条。',
})).toBe(true);

expect(shouldStartProgressCardPage({
  currentContent: '[19:00:00] 开始。',
  currentEntryCount: 1,
  nextEntry: `[...] ${'长'.repeat(1800)}`,
})).toBe(true);

expect(shouldStartProgressCardPage({
  currentContent: '',
  currentEntryCount: 0,
  nextEntry: '长'.repeat(2000),
})).toBe(false);
```

- [ ] **Step 2: 运行测试并确认缺少分页模块**

```bash
corepack pnpm vitest run --project unit test/codex-app-progress-pagination.test.ts
```

Expected: FAIL，模块或导出不存在。

- [ ] **Step 3: 实现分页纯函数和页类型**

```ts
export const PROGRESS_CARD_PAGE_MAX_ENTRIES = 8;
export const PROGRESS_CARD_PAGE_MAX_CHARS = 1800;

export function shouldStartProgressCardPage(input: {
  currentContent: string;
  currentEntryCount: number;
  nextEntry: string;
}): boolean {
  if (!input.currentContent) return false;
  if (input.currentEntryCount >= PROGRESS_CARD_PAGE_MAX_ENTRIES) return true;
  return `${input.currentContent}\n\n${input.nextEntry}`.length > PROGRESS_CARD_PAGE_MAX_CHARS;
}
```

在 `src/types.ts` 增加：

```ts
export interface CodexAppProgressCardArchivedPage {
  pageNumber: number;
  messageId: string;
  content: string;
  archivedSynced?: boolean;
}
```

并给 `CodexAppProgressCardSessionState` 增加可选 `pageNumber`、`currentEntryCount` 和 `archivedPages`，保证旧状态仍可读取。

- [ ] **Step 4: 运行分页测试和类型检查**

```bash
corepack pnpm vitest run --project unit test/codex-app-progress-pagination.test.ts
corepack pnpm exec tsc --noEmit
```

Expected: 分页纯函数测试通过，TypeScript 无错误。

### Task 2: 卡片续页、归档和失败恢复

**Files:**
- Modify: `src/services/codex-app-progress-card.ts`
- Modify: `test/codex-app-progress-card.test.ts`

**Interfaces:**
- Consumes: Task 1 的分页常量、判断函数和 `CodexAppProgressCardArchivedPage`。
- Produces: `renderCodexAppProgressCard(state, { content, pageNumber, archived })`。
- Produces: `CodexAppProgressCard` 可恢复的多页同步行为。

- [ ] **Step 1: 写多页行为失败测试**

测试必须覆盖：

```ts
await card.accept('om_turn', '长任务');
for (let index = 1; index <= 8; index++) {
  await card.append('om_turn', `第 ${index} 条进展。`);
}
expect(posts).toHaveLength(2);
expect(card.snapshot()).toMatchObject({
  pageNumber: 2,
  currentEntryCount: 1,
  archivedPages: [{
    pageNumber: 1,
    archivedSynced: true,
  }],
});
expect(JSON.parse(posts[1].cardJson).header.title.content)
  .toContain('进度 2');
```

另写独立用例验证：

- 超过 1800 字换页且超长单条不截断。
- 新页 POST 失败后 `pageNumber`、当前内容和归档页仍保留，下一次更新重试。
- 归档 PATCH 失败时新页已经可见，归档页保持 `archivedSynced !== true`。
- 终态只把最新页渲染为绿色，历史页为灰色。
- 旧单页状态恢复后从第 1 页继续。

- [ ] **Step 2: 运行卡片测试并确认缺少续页行为**

```bash
corepack pnpm vitest run --project unit test/codex-app-progress-card.test.ts
```

Expected: FAIL，仍只 POST 一张卡或缺少分页状态。

- [ ] **Step 3: 实现最小多页状态机**

新增集中写入方法：

```ts
private appendEntry(entry: string): void {
  const pageNumber = this.state?.pageNumber ?? 1;
  const entryCount = this.state?.currentEntryCount
    ?? countProgressCardEntries(this.state?.content ?? '');
  const canArchive = Boolean(this.state?.messageId);
  if (canArchive && shouldStartProgressCardPage({
    currentContent: this.state!.content,
    currentEntryCount: entryCount,
    nextEntry: entry,
  })) {
    this.state!.archivedPages ??= [];
    this.state!.archivedPages.push({
      pageNumber,
      messageId: this.state!.messageId!,
      content: this.state!.content,
    });
    this.state!.pageNumber = pageNumber + 1;
    this.state!.messageId = undefined;
    this.state!.content = entry;
    this.state!.currentEntryCount = 1;
    return;
  }
  this.state!.content = `${this.state!.content}\n\n${entry}`;
  this.state!.currentEntryCount = entryCount + 1;
}
```

`syncCard()` 按以下顺序执行：

1. POST 或 PATCH 当前页并持久化当前消息 ID。
2. 遍历 `archivedSynced !== true` 的归档页，PATCH 灰色归档标题。
3. PATCH 成功后逐页设置 `archivedSynced = true` 并持久化。
4. 归档页已撤回时直接视为同步完成；其它错误保留未同步状态并抛出，供下一次调用重试。

- [ ] **Step 4: 运行卡片、生命周期和配置回归**

```bash
corepack pnpm vitest run --project unit \
  test/codex-app-progress-pagination.test.ts \
  test/codex-app-progress-card.test.ts \
  test/codex-app-progress.test.ts \
  test/session-lifecycle-hooks.test.ts \
  test/bot-config-store.test.ts
corepack pnpm exec tsc --noEmit
```

Expected: 所有定向测试通过，TypeScript 无错误。

- [ ] **Step 5: 构建、审计并提交**

```bash
shim_dir=$(mktemp -d /tmp/botmux-corepack.XXXXXX)
corepack enable --install-directory "$shim_dir" pnpm
PATH="$shim_dir:$PATH" corepack pnpm build
git add src/types.ts src/services/codex-app-progress-pagination.ts \
  src/services/codex-app-progress-card.ts \
  test/codex-app-progress-pagination.test.ts \
  test/codex-app-progress-card.test.ts
kmp-cli scan --rule script-size --root . --staged
git commit -m "feat: 支持进度卡自动分页"
```

Expected: build、domain audit、dist audit 和脚本行数门禁通过。

- [ ] **Step 6: 仅重启 Youc 并验证**

重启 `botmux-0` 后确认：

- Youc 使用新 runtime build，状态为 online。
- `botmux-1`、`botmux-2` 和 Dashboard PID 不变。
- 普通短任务仍只创建一张卡。
- 测试阈值任务产生第 2 张卡，第 1 张卡变为灰色归档。
