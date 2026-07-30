# 自定义功能开发与上线

## 目录

1. 建立隔离开发面
2. 影响面设计
3. 实现与测试
4. 合入生产分支
5. live 验证与部署标记
6. 交付证据

## 建立隔离开发面

不要在 daemon 正在使用的 `custom/prod` checkout 直接开发。先校验生产真源：

```bash
git fetch origin --prune
git symbolic-ref --short HEAD
git status --short
git rev-parse HEAD
git rev-parse origin/custom/prod
```

从最新 `origin/custom/prod` 建立单一职责分支和隔离 worktree。分支名使用仓库现有约定，例如
`feat/<topic>` 或 `fix/<topic>`：

```bash
git worktree add <approved-path> -b feat/<topic> origin/custom/prod
cd <approved-path>
pnpm install --frozen-lockfile
```

若同名分支/worktree 已存在，先检查其中的用户改动和 upstream，不要覆盖或重建。

## 影响面设计

先读目标 checkout 的 `AGENTS.md` 和直接相关代码。明确以下回归矩阵，只保留与改动有关的组合：

- 平台：Linux 生产环境，以及涉及路径、进程、PTY、编码时的 macOS 行为。
- CLI：目标 adapter 与至少一个共享路径消费者；公共 adapter 工具可能影响全部 CLI。
- 后端/会话：PTY、tmux、普通话题、群会话、adopt/restore、sandbox。
- 公共层：`core/`、`config.ts`、`bot-registry.ts`、`im/lark/`、worker/daemon 生命周期。
- 自定义热点：Codex app-server 进度卡、ASK 回灌、final outbox/重启恢复、源码同步。

新增功能应尽量落到边界清晰的模块，并为状态转换、重启恢复、重复事件和并发竞态设计幂等语义。
不得仅为解决当前用例破坏其它 CLI 或会话类型。

## 实现与测试

保持最小 diff，先写或补与行为同层的测试。常用命令：

```bash
pnpm exec vitest run --project unit test/<target>.test.ts
pnpm build
```

改公共层、生命周期、持久化或消息投递时，再运行：

```bash
pnpm test
```

真实 CLI、浏览器或飞书交互按风险补对应 e2e。不要用“类型通过”替代行为测试，也不要声称执行了
未实际运行的测试。

提交前检查：

```bash
git status --short
git diff --check
git diff --stat
git diff --cached
```

只暂存目标文件。commit/PR 标题遵循 `type(scope): 中文描述`，PR 中文说明动机、实现、跨平台/
CLI/后端影响面与实际测试结果；UI 改动附截图。

## 合入生产分支

1. push 开发分支并通过 review/CI。
2. 把已验证 commit 合入 `custom/prod`，保留可审计历史。
3. 回到 canonical 生产 checkout，确认 clean 后执行：

```bash
git fetch origin --prune
git merge --ff-only origin/custom/prod
pnpm install --frozen-lockfile
pnpm build
pnpm use:here
```

如果远端尚未包含目标 commit，不要从未推送的临时 worktree直接宣称生产已更新。

## live 验证与部署标记

只有用户明确要求部署或变更必须 live 验证时，才切换所有 bot：

```bash
pnpm daemon:restart
botmux status
```

重启后核对 wrapper、PM2 执行路径和日志，再做与功能相符的真实飞书/Dashboard/CLI 验证。临时从
开发 worktree live 验证时使用：

```bash
pnpm switch:here
pnpm daemon:restart
```

验证结束后必须回到 canonical `custom/prod` checkout，重新 `pnpm switch:here` 并重启，避免临时
worktree 删除后 wrapper 失效。

需要标记已部署快照时，基于 HEAD 可达的最新官方正式标签创建下一个
`deploy/vX.Y.Z-custom.N` annotated tag。先列出已有编号，禁止覆盖标签：

```bash
git tag --merged HEAD --list 'v*' --sort=-v:refname
git tag --list 'deploy/v*-custom.*' --sort=-v:refname
git tag -a deploy/vX.Y.Z-custom.N -m 'deploy: vX.Y.Z custom.N'
git push origin refs/tags/deploy/vX.Y.Z-custom.N
```

`deploy/*` 是 fork 的部署追踪标签，不是官方 npm 发版标签。不要修改 `package.json.version`，
也不要为自定义生产分支创建 `v*` 正式发布标签。

## 交付证据

至少报告：

- 开发分支、生产分支、commit 和远端链接。
- 运行过的定向测试、全量测试/构建及退出结果。
- 是否部署；若部署，给 wrapper 路径、PM2/daemon 状态和 live 验证。
- 是否创建 `deploy/*` 标签。
- 未覆盖的 CLI、平台、e2e 或待观察风险。
