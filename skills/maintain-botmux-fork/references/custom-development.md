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

最终卡片末尾必须给出“加入待发版 `<pendingVersion>`”和“暂不加入”两个动作。加入动作的 prompt
必须写明准确开发分支、commit、目标 `custom/dev` 和待发版本，并带显式授权；用户未选择前不得合入。

收到加入授权后，在专用 `custom/dev` checkout 重新 fetch，确认用户点选的 commit 仍是开发分支远端
HEAD，再把它合入最新 `origin/custom/dev`。并发需求必须保留各自提交和可审计 merge，不得强推或
覆盖其它已加入需求：

```bash
git fetch origin --prune
git merge --ff-only origin/custom/dev
git merge --no-ff origin/<development-branch> -m 'merge: 加入待发版 <version>'
git push origin HEAD:refs/heads/custom/dev
git ls-remote origin refs/heads/custom/dev
pnpm release:status
```

若 push 竞态失败，重新 fetch、核对新加入内容后再正常 merge；禁止 `--force`。

## 冻结候选版本

只有用户明确要求切候选版本时，才在 clean 且与远端一致的 `custom/dev` checkout 执行：

```bash
pnpm release:prepare
```

脚本运行 unit 全量和 `pnpm build`，然后把当前 `custom/dev` HEAD 固定为
`release/vX.Y.Z-custom.N` annotated tag 并回读远端。`X.Y.Z` 来自 HEAD 可达的最新 upstream
正式标签，`N` 同时避让已有 `release/*` 与 `deploy/*` 编号。不要修改 `package.json.version`，
不要创建 fork 所有的裸 `v*` 标签。

候选 tag 创建后内容不可再修改。后续新需求继续加入 `custom/dev` 时自然进入下一个 `custom.N`。

## 推进生产与部署

推进生产、部署和重启都是独立的显式授权边界。先用准确候选标签推进远端生产分支：

```bash
pnpm release:promote -- --tag release/vX.Y.Z-custom.N
```

脚本只允许 `custom/prod` fast-forward 到该候选 commit，不切换本机 wrapper、不重启。收到部署授权后，
回 canonical `custom/prod` checkout：

```bash
git fetch origin --prune --tags
git merge --ff-only origin/custom/prod
pnpm install --frozen-lockfile
pnpm build
pnpm use:here
pnpm daemon:restart
botmux status
```

核对 wrapper、PM2 执行路径、近期日志和与变更相符的真实飞书/Dashboard/CLI 交互。全部验收通过后才
记录同号部署快照：

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
- 未覆盖的 CLI、平台、e2e 或待观察风险。
