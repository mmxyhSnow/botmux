# 自定义功能开发与版本化上线

## 目录

1. 建立隔离开发面
2. 实现、验证并 push
3. 询问是否加入待发版
4. 冻结候选版本
5. 推进生产与部署
6. 交付证据

## 建立隔离开发面

不要在 daemon 正在使用的 `custom/prod` checkout 开发，也不要再从生产分支直接切日常需求。先校验
双分支和生产真源：

```bash
git fetch origin --prune --tags
git status --short
git rev-parse origin/custom/dev
git rev-parse origin/custom/prod
git merge-base --is-ancestor origin/custom/prod origin/custom/dev
pnpm release:status
```

从最新 `origin/custom/dev` 建立单一职责分支和隔离 worktree。分支名使用仓库现有约定，例如
`feat/<topic>`、`fix/<topic>` 或 `refactor/<topic>`：

```bash
git worktree add <approved-path> -b feat/<topic> origin/custom/dev
cd <approved-path>
pnpm install --frozen-lockfile
```

若同名分支/worktree 已存在，先检查其中的用户改动和 upstream，不要覆盖或重建。

## 实现、验证并 push

先读目标 checkout 的 `AGENTS.md` 和直接相关代码。明确与变更有关的平台、CLI、后端/会话、公共层和
自定义热点回归矩阵。保持最小 diff，为状态转换、重启恢复、重复事件和并发竞态设计幂等语义。

先写或补与行为同层的测试。常用命令：

```bash
pnpm exec vitest run --project unit test/<target>.test.ts
pnpm build
```

改公共层、生命周期、持久化或消息投递时，再运行 `pnpm test`。提交前检查：

```bash
git status --short
git diff --check
git diff --stat
git diff --cached
```

只暂存目标文件。commit/PR 标题遵循 `type(scope): 中文描述`。push 开发分支并回读远端 commit；
到这里仍未进入待发版，更未改变生产。

## 询问是否加入待发版

开发分支 push 后运行：

```bash
pnpm release:status
```

`release:status` 默认只读本地 refs 与运行清单，不访问网络，适合日常秒级确认；只有确实要刷新
origin/upstream 时才运行 `pnpm release:status -- --remote`。输出必须标明 `source=local|remote`，
不要把离线机器上的本地状态误报成远端已确认。

最终卡片末尾必须给出“加入待发版 `<pendingVersion>`”和“暂不加入”两个动作。加入动作的 prompt
必须写明准确开发分支、commit、目标 `custom/dev` 和待发版本，并带显式授权；用户未选择前不得合入。

收到加入授权后，在专用 `custom/dev` checkout 使用统一入口。命令会在一次性隔离 clone 中重新 fetch，
确认用户点选的 commit 仍是开发分支远端 HEAD，再把它合入最新 `origin/custom/dev`；push 竞态会从新
远端基线无污染重试。成功后回读远端、快进规范 checkout，并把私聊通知事件原子排入持久化队列：

```bash
pnpm release:join -- \
  --source origin/<development-branch> \
  --expected-head <commit> \
  --title '<本次合入的简明标题>'
```

命令的 `BOTMUX_CUSTOM_RELEASE_RESULT` 必须包含新的 `integrationHead`、`pendingVersion` 和
`notification.eventId/status`。原任务线程只报告合入结果和通知状态，不附冻结按钮，也不把
`notification.status=queued` 误报成已送达。

primary daemon 只向当前 Bot 的 primary owner 维护一张当前待发私聊卡：

- “本次合入”来自本次 merge 前后 Git 差异；“当前版本累计”来自最近候选/部署边界到新 HEAD 的
  第一父链 merge 和 diff，不依赖 AI 临时记忆。
- 上一事件仍待冻结且原卡可更新时，直接把同一 messageId 更新为最新待发事件；原卡不可更新时才新发
  替代卡。已冻结或已进入独立候选生命周期的卡保留，不与下一待发版本混用。
- 旧事件始终在服务端标为过期；即使视觉更新失败，回调也会拒绝旧 eventId。
- 投递以仓库与 `custom/dev` HEAD 为幂等键；失败保留在持久化队列，由 daemon 重试。
- 卡片状态变化会保留有界阶段时间线和每阶段耗时；重复写同一状态不新增节点，避免重启恢复时膨胀。
- 冻结、推进、部署成功或失败都只回写这张发版卡，不再补发独立文本通知。

## 冻结候选版本

冻结入口默认只出现在每次合入后的 owner 私聊汇总卡末尾，不在各任务线程重复发送。用户点击后，
daemon 立即把卡片改成“正在冻结”，后台在 clean 且与远端一致的 `custom/dev` checkout 执行：

```bash
pnpm release:prepare -- \
  --expected-head <卡片绑定的-custom/dev-HEAD> \
  --expected-version <卡片绑定的-pendingVersion>
```

冻结、官方同步和版本化运行构建都会先执行同一个 Node/pnpm 门禁；也可独立诊断：

```bash
node scripts/check-release-toolchain.mjs
```

Node 必须满足 `package.json.engines`，pnpm 必须与 `packageManager` 精确一致，失败时不得继续 install/build。

脚本运行 unit 全量和 `pnpm build`，然后把当前 `custom/dev` HEAD 固定为
`release/vX.Y.Z-custom.N` annotated tag 并回读远端。`X.Y.Z` 来自 HEAD 可达的最新 upstream
正式标签，`N` 同时避让已有 `release/*` 与 `deploy/*` 编号。不要修改 `package.json.version`，
不要创建 fork 所有的裸 `v*` 标签。

候选 tag 创建后内容不可再修改。后续新需求继续加入 `custom/dev` 时自然进入下一个 `custom.N`。
测试和构建结束、创建 tag 之前必须再次 fetch 并核对 HEAD 与版本；期间若有新合入，只把旧卡标为过期，
不得为旧 HEAD 创建候选标签。

## 推进生产与部署

owner 收到 HEAD 绑定的私聊汇总卡后，点击“推进并部署 X.Y.Z-custom.N”本身就是针对该候选 Tag 的
完整显式授权，不再要求回到任务对话补发“授权”。卡片回调按顺序完成：

1. 再次核对卡片 messageId、owner、候选 Tag 与远端 HEAD。
2. 在 `~/.botmux/releases/<版本>/` 创建精确候选 tag 的 detached worktree，独立安装、构建和 smoke；
   同时把当前 deploy tag 准备为 O(1) 回滚点，活跃 `dist` 不被改写。
3. 快进 `custom/prod` 与 canonical checkout；在切换前备份真实 live `dist`，再原子更新
   `~/.botmux/runtime/current`，用脱离式驱动重启。
4. 目标启动失败时驱动自动切回旧 `current` 并恢复服务；成功时新 daemon 校验运行清单、PM2 执行路径、
   本地/远端生产 HEAD，创建同号 `deploy/*` 标签，更新稳定 `controller` 并回写原卡。

任一步失败都保留可重试状态，运行态未验收通过时不得创建 deploy 标签。命令行人工路径仍可拆分执行，
先用准确候选标签推进远端生产分支：

```bash
pnpm release:promote -- --tag release/vX.Y.Z-custom.N
```

脚本只允许 `custom/prod` fast-forward 到该候选 commit，不切换 live、不重启。版本化运行目录准备、
备份、原子切换、失败恢复和部署留痕是一条整体门禁；不要再手敲旧的
`build → use:here → daemon:restart` 旁路。卡片不可用时先修复卡片或执行器，不要跳过门禁上线。

全部验收通过后才记录同号部署快照；私聊卡自动路径由新 daemon 执行同一门禁：

```bash
pnpm release:record-deploy -- --tag release/vX.Y.Z-custom.N
```

该命令要求本地生产 HEAD、远端生产 HEAD 与候选提交完全一致，并创建
`deploy/vX.Y.Z-custom.N`。它只负责不可变 Git 留痕，不能替代实际运行态验收。

## 交付证据

至少报告：

- 开发分支、commit、远端链接，以及是否已加入 `custom/dev`。
- `pendingVersion`、候选 `release/*`、生产 `custom/prod` 和部署 `deploy/*` 的准确状态。
- 实际运行的定向测试、全量测试/构建及退出结果。
- 是否部署；若部署，给 wrapper 路径、PM2/daemon 状态和 live 验证。
- 若发生失败恢复，给目标/恢复 deploy tag、`current` 回读和恢复后的进程路径。
- 未覆盖的 CLI、平台、e2e 或待观察风险。
