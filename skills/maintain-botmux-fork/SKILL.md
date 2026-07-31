---
name: maintain-botmux-fork
description: Maintain the mmxyhSnow/botmux custom/dev integration and custom/prod source deployment while preserving custom features and safely consuming deepcoldy/botmux releases. Use when a user message begins with /feat, /opt, or /fix to request a Botmux feature, optimization, or bug fix; or when installing this Botmux fork, onboarding another agent, operating or diagnosing the source checkout, adding and deploying a custom feature, preparing or promoting a custom release, synchronizing an official stable release, resolving upgrade conflicts, rolling back a deployment, or installing and updating this maintenance skill.
---

# 维护 Botmux 自定义分支

维护 `mmxyhSnow/botmux` 的 `custom/dev` 集成线与 `custom/prod` 源码部署，并把
`deepcoldy/botmux` 的正式版标签安全合入。以不可变版本标签、可恢复 Git 历史、测试证据和运行态回读
为完成标准。

## 约定式开发命令

当用户消息的首个非空内容是以下前缀时，直接把它路由为 Botmux 自定义开发任务：

- `/feat <目标>`：新增 Botmux 功能，默认使用 `feat` 提交类型。
- `/opt <目标>`：优化现有体验、性能、稳定性或代码结构；默认保持现有外部行为，提交类型按实际改动
  选择 `perf` 或 `refactor`。
- `/fix <问题>`：诊断并修复 Botmux 缺陷或回归，默认使用 `fix` 提交类型。

前缀只负责声明任务类型，前缀后的全部内容都是需求正文。正文清晰且风险可控时直接按
[custom-development.md](references/custom-development.md) 实施、验证、提交并推送；涉及多模块取舍、
验收口径不清或高风险行为时，先使用当前环境提供的需求澄清能力与用户收敛范围。只有前缀没有正文时，
只追问目标，不自行猜测需求。

这三个前缀授权需求范围内的源码修改、测试和正常 Git 提交/推送，但不自动授权把开发分支合入
`custom/dev`、冻结候选版本、推进 `custom/prod`、生产部署、daemon 重启、同步上游、强推或历史重写。
只有正文明确要求相应动作时才执行。

每个 `/feat`、`/opt`、`/fix` 完成并 push 开发分支后，先运行 `pnpm release:status` 回读当前待发版本，
再在最终卡片末尾主动给用户两个选项：

- `加入待发版 <version>`：把本次已验证的准确分支和 commit 合入 `custom/dev`，push 并回读远端；
  这是合入状态变更，`botmux-actions` 必须带 `"authorization":"explicit"`。
- `暂不加入`：保持 `custom/dev`、`custom/prod` 和版本标签不变，继续保留独立开发分支。

两个 action 的 prompt 必须包含开发分支、commit、目标 `custom/dev` 和待发版本，不能只写“继续”。
用户没有选择前，不得默认加入待发版。

用户授权加入后必须走 `pnpm release:join` 统一入口。远端 `custom/dev` push 并回读成功后，primary daemon
会给 Bot owner 新发一张私聊汇总卡，展示本次合入和当前待发版累计改动，卡片末尾提供 HEAD 绑定的
“冻结 `<version>`”按钮。原任务线程只报告合入和通知排队结果，不得再附冻结按钮；冻结、推进生产、
部署和重启仍是各自独立授权。

```html
<!--botmux-actions:{"actions":[{"label":"加入待发版 3.7.1-custom.3","prompt":"请核对开发分支 refactor/example 的远端 HEAD 仍为 <commit>，将该提交正常合入 custom/dev，push 后回读远端 HEAD 和待发版本；不要推进 custom/prod 或部署。","authorization":"explicit"},{"label":"暂不加入","prompt":"请保持 refactor/example@<commit> 为独立开发分支，确认 custom/dev、custom/prod 和版本标签均不变。"}]}-->
```

## 固定边界

- 把 `origin/custom/dev` 视为待发集成真源，把 `origin/custom/prod` 视为自定义生产真源，
  把 `upstream` 视为官方只读源。
- 日常需求从最新 `origin/custom/dev` 开发，只允许显式加入 `custom/dev`；禁止直接合入
  `custom/prod`。
- `release/vX.Y.Z-custom.N` 固定候选版本，`deploy/vX.Y.Z-custom.N` 记录同版本真实部署快照；
  两类 annotated tag 都不可移动、覆盖或删除。
- 只从官方 `vX.Y.Z` 正式标签升级；不要把 canary、PR 分支或未经验证的 `upstream/master`
  直接合入生产。
- 源码部署不要用 `npm update -g botmux` 升级，否则会切回不含自定义功能的官方包。
- 不覆盖 `~/.botmux` 中的机器人配置、凭据和会话数据，不输出 secret。
- 不在 live 生产 checkout 中开发功能；使用隔离分支/worktree，验证后由用户决定是否加入待发集成线。
- 不强推、重写或回退 `custom/prod` 历史。回滚优先新增 `revert` 提交。
- 同步官方、切换全局 wrapper、重启 daemon 和创建部署标签都会改变生产状态；仅在用户明确要求
  升级、部署、重启或回滚时执行。

## 先做身份与状态校验

在任何写操作前定位目标 checkout，并回读以下结果：

```bash
git symbolic-ref --short HEAD
git status --short
git remote -v
git rev-parse HEAD
git rev-parse origin/custom/dev
git rev-parse origin/custom/prod
git worktree list --porcelain
node --version
pnpm --version
```

要求生产 checkout 位于 `custom/prod`，`origin` 指向 `mmxyhSnow/botmux`，
`upstream` 指向 `deepcoldy/botmux`。开发任务还必须确认 `origin/custom/prod` 是
`origin/custom/dev` 的祖先。发现未提交改动、生产 HEAD 与 `origin/custom/prod` 不一致、分支分叉或
远端身份异常时，先查明归属，不要自动清理、覆盖或继续发布。

## 按任务读取操作手册

- 安装源码版、安装本 Skill、更新日常自定义提交、启停和健康检查：读取
  [installation-and-operations.md](references/installation-and-operations.md)。
- 补自定义功能、加入待发版、冻结候选、推进生产、live 验证和交付：读取
  [custom-development.md](references/custom-development.md)。
- 同步官方正式版、处理冲突、部署标签、失败恢复和回滚：读取
  [official-sync-and-recovery.md](references/official-sync-and-recovery.md)。

组合任务必须读取对应的全部手册。例如“同步官方后继续补一个自定义功能并上线”需要先读官方同步，
再读自定义开发和安装运维手册。

## 验收与交付

根据变更风险至少给出：

- Git：开发分支、最终 commit、`custom/dev` / `custom/prod` 状态、待发版本；正式发布时再给
  `release/vX.Y.Z-custom.N` 和 `deploy/vX.Y.Z-custom.N`。
- 验证：实际运行的定向测试、`pnpm build`，公共层变更再给 `pnpm test` 或明确说明未执行原因。
- 部署：全局 wrapper 实际指向、daemon/dashboard 状态、关键日志和真实飞书交互结果。
- 风险：未执行的 e2e、未完成的 live 验证、遗留冲突或临时回退状态。

不得把“代码已修改”“构建启动”“正在升级”当成完成。只有目标 commit 已进入准确远端、
要求的验证通过，且用户要求的部署/重启/运行态检查完成，才报告完成。
