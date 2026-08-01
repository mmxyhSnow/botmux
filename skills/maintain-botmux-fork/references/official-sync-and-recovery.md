# 官方同步、失败恢复与回滚

## 目录

1. 同步前门禁
2. 首选 Dashboard 同步
3. 命令行同步
4. 自动同步器的真实行为
5. 冲突处理
6. 失败恢复
7. 回滚

## 同步前门禁

同步官方会 push `upgrade/vX.Y.Z`、快进 `origin/custom/prod`、替换生产 `dist` 并创建部署标签，
属于生产写入。只在用户明确要求升级时执行。

在 canonical 生产 checkout 检查：

```bash
git symbolic-ref --short HEAD
git status --short
git remote -v
git fetch origin --prune
git fetch upstream --prune --tags
git rev-parse HEAD
git rev-parse origin/custom/dev
git rev-parse origin/custom/prod
cat .botmux-source-update.json
```

必须同时满足：

- 当前分支是 `custom/prod`，tracked 文件 clean。
- 本地 HEAD 与 `origin/custom/prod` 完全一致。
- `origin/custom/dev` 与 `origin/custom/prod` 完全一致，没有尚未发布的集成改动。
- `origin=mmxyhSnow/botmux`，`upstream=deepcoldy/botmux`。
- 配置只含 schemaVersion、生产分支和双远端身份字段。
- 没有另一轮升级或重启正在持锁。

先查看当前对齐版本和官方最新正式标签：

```bash
git tag --merged HEAD --list 'v*' --sort=-v:refname | head
git ls-remote --tags upstream
```

只认 `^v[0-9]+\.[0-9]+\.[0-9]+$`；canary/beta/rc 和 `deploy/*` 不算官方对齐版本。

## 首选 Dashboard 同步

对已运行的 canonical 源码部署，优先使用 Dashboard `设置 → 版本与更新` 中标记为“源码同步”
的更新动作。它会：

1. 调用受信任源码同步器。
2. 成功后请求维护重启。
3. 把旧版 → 新版和重启结果反馈到界面。

不要在 Dashboard 请求仍在运行时并行启动命令行同步。界面显示更新成功但重启失败时，代码和
`dist` 已更新；只需从 canonical checkout 运行 `pnpm daemon:restart` 并做健康检查，不要重复同步。

## 命令行同步

需要直接观察完整日志或 Dashboard 不可用时，从 canonical 生产 checkout 执行：

```bash
node scripts/sync-official-source.mjs --root "$(pwd)"
```

只接受包含以下唯一结构化终态的成功结果：

```text
BOTMUX_SOURCE_UPDATE_RESULT={"oldVersion":"...","newVersion":"...","changed":...}
```

`changed:false` 表示已对齐，无需制造新 merge/tag。`changed:true` 后，命令行路径还需显式认领
生产 checkout 并重启：

```bash
pnpm use:here
pnpm daemon:restart
botmux status
```

再核对 PM2 执行路径、近期日志与一条真实飞书交互。确认运行 HEAD、远端生产 HEAD 与同步结果中的
`releaseTag` / `productionHead` 一致后，显式记录部署快照：

```bash
pnpm release:record-deploy -- --tag release/vX.Y.Z-custom.N
```

Dashboard 路径会把这两个字段写入 restart intent，由新 daemon 自动执行同一验收和留痕；失败时不创建
deploy 标签，并在维护通知中告警。

## 自动同步器的真实行为

`scripts/sync-official-source.mjs` 按顺序执行：

1. 校验生产分支、clean 状态、双远端身份、本地/远端 HEAD，并拒绝覆盖 `custom/dev` 待发改动。
2. 找出 HEAD 已对齐的最新官方正式标签和 upstream 最新正式标签。
3. 在仓库公共根的 `.worktrees/upgrade-X.Y.Z` 创建或复用 `upgrade/vX.Y.Z`。
4. 用 `--no-ff` 把官方 `vX.Y.Z` 合入自定义生产基线。
5. `pnpm install --frozen-lockfile`，运行兼容宿主的 unit 全量，再执行 `pnpm build`。
6. 创建 `release/vX.Y.Z-custom.1` 候选标签，push upgrade 分支，再依次把 `custom/dev` 和
   `custom/prod` 快进到同一 merge commit。
7. canonical checkout `--ff-only` 跟进远端，安装依赖，并用同文件系统 rename 原子替换 `dist`；
   旧 `dist` 备份到生产目录同级的 `.botmux-dist-backups/source-update-*`。
8. 输出包含 `releaseTag`、`productionHead` 且 `deployTag=null` 的结构化结果；Dashboard 发起重启后，
   新 daemon 验证真实运行 checkout、本地/远端 HEAD 与候选标签，最后复用 `release:record-deploy`
   创建并回读同号 `deploy/vX.Y.Z-custom.1`。

脚本不会自行处理 merge conflict，也不会替冲突升级选择新的部署标签编号。

## 冲突处理

合并冲突后，脚本会失败并保留 upgrade worktree。不要删除 worktree、reset 生产分支或盲目重跑。

在 upgrade worktree：

```bash
git status --short
git diff --name-only --diff-filter=U
```

逐文件比较：

- upstream 修复/接口变化的真实意图；
- fork 自定义行为及对应测试；
- 公共层对其它 CLI、后端和会话类型的影响。

优先把自定义能力适配到新官方接口，而不是整块保留旧文件或整块采用 upstream。解决后：

```bash
git add <resolved-files>
git commit
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

确认 merge commit 的第一父是旧 `custom/prod`，第二父是官方标签。随后人工完成：

```bash
git push origin HEAD:refs/heads/upgrade/vX.Y.Z
git tag -a release/vX.Y.Z-custom.N -m 'release: vX.Y.Z custom.N'
git push origin refs/tags/release/vX.Y.Z-custom.N
git push origin HEAD:refs/heads/custom/dev
git push origin HEAD:refs/heads/custom/prod
```

回 canonical 生产 checkout：

```bash
git fetch origin --prune
git merge --ff-only origin/custom/prod
pnpm install --frozen-lockfile
pnpm switch:here
pnpm daemon:restart
```

live 验证通过后，列出已有 `deploy/vX.Y.Z-custom.*`，创建下一个未占用的 annotated tag 并 push。
不要固定复用 `custom.1`。

## 失败恢复

按失败发生点判断，不要把整条链路从头重放：

- merge/test/build 前失败：`custom/dev`、`custom/prod` 均未推进。保留 upgrade worktree，修复根因后
  重新验证。
- 候选标签或 `custom/dev` 已 push、生产分支未 push：核对 merge commit 与远端分支后只补缺失步骤。
- upgrade 分支已 push、生产分支未 push：核对 merge commit 后只补生产 push。
- `origin/custom/prod` 已推进、canonical 未快进：fetch 后 `merge --ff-only`。
- 源码已快进、`dist` 切换失败：在 canonical checkout 重新安装、`pnpm switch:here`，再重启。
- 更新成功、重启失败：只重启并检查运行态；确认三方 HEAD 后补 `release:record-deploy`。
- 重启成功、部署留痕失败：不要重跑同步。按维护通知核对运行 HEAD、远端生产 HEAD 与候选标签，
  修复后只补 `release:record-deploy`。
- 标签冲突：列出远端已有标签，使用下一个 `custom.N`；不要删除或覆盖旧标签。

每次恢复前先回读远端 SHA、当前分支、worktree 状态和进程执行路径。

## 回滚

首选 Git 历史可审计回滚：

1. 定位导致问题的自定义 commit 或官方 merge commit。
2. 在隔离修复分支创建 `git revert`；回退官方 merge时使用 `git revert -m 1 <merge-commit>`。
3. 运行受影响测试、`pnpm test`、`pnpm build`。
4. review 后合入 `custom/prod`，canonical checkout 快进、切换 wrapper、重启并 live 验证。
5. 创建新的 `deploy/vX.Y.Z-custom.N`，不要移动旧标签。

只有服务完全不可用且用户明确授权应急恢复时，才临时使用
`.botmux-dist-backups/source-update-*` 的旧 `dist`。该动作只回退运行产物，不回退源码，必须记录
备份路径，恢复服务后立即补 Git revert/修复提交，使源码、dist 和远端重新一致。
