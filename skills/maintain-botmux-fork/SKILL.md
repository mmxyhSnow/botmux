---
name: maintain-botmux-fork
description: Maintain the mmxyhSnow/botmux custom/prod source deployment while preserving custom features and safely consuming deepcoldy/botmux releases. Use when installing this Botmux fork, onboarding another agent, operating or diagnosing the source checkout, adding and deploying a custom feature, synchronizing an official stable release, resolving upgrade conflicts, rolling back a deployment, or installing and updating this maintenance skill.
---

# 维护 Botmux 自定义分支

维护 `mmxyhSnow/botmux` 的 `custom/prod` 源码部署，并把
`deepcoldy/botmux` 的正式版标签安全合入。以可恢复的 Git 历史、测试证据和运行态回读为完成标准。

## 固定边界

- 把 `origin/custom/prod` 视为自定义生产真源，把 `upstream` 视为官方只读源。
- 只从官方 `vX.Y.Z` 正式标签升级；不要把 canary、PR 分支或未经验证的 `upstream/master`
  直接合入生产。
- 源码部署不要用 `npm update -g botmux` 升级，否则会切回不含自定义功能的官方包。
- 不覆盖 `~/.botmux` 中的机器人配置、凭据和会话数据，不输出 secret。
- 不在 live 生产 checkout 中开发功能；使用隔离分支/worktree，验证后再合入生产分支。
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
git rev-parse origin/custom/prod
git worktree list --porcelain
node --version
pnpm --version
```

要求生产 checkout 位于 `custom/prod`，`origin` 指向 `mmxyhSnow/botmux`，
`upstream` 指向 `deepcoldy/botmux`。发现未提交改动、HEAD 与
`origin/custom/prod` 不一致或远端身份异常时，先查明归属，不要自动清理、覆盖或继续部署。

## 按任务读取操作手册

- 安装源码版、安装本 Skill、更新日常自定义提交、启停和健康检查：读取
  [installation-and-operations.md](references/installation-and-operations.md)。
- 补自定义功能、测试、合入、live 验证和交付：读取
  [custom-development.md](references/custom-development.md)。
- 同步官方正式版、处理冲突、部署标签、失败恢复和回滚：读取
  [official-sync-and-recovery.md](references/official-sync-and-recovery.md)。

组合任务必须读取对应的全部手册。例如“同步官方后继续补一个自定义功能并上线”需要先读官方同步，
再读自定义开发和安装运维手册。

## 验收与交付

根据变更风险至少给出：

- Git：生产/开发分支、最终 commit、与远端同步状态；发生官方同步时再给官方标签、merge commit
  和 `deploy/vX.Y.Z-custom.N`。
- 验证：实际运行的定向测试、`pnpm build`，公共层变更再给 `pnpm test` 或明确说明未执行原因。
- 部署：全局 wrapper 实际指向、daemon/dashboard 状态、关键日志和真实飞书交互结果。
- 风险：未执行的 e2e、未完成的 live 验证、遗留冲突或临时回退状态。

不得把“代码已修改”“构建启动”“正在升级”当成完成。只有目标 commit 已进入准确远端、
要求的验证通过，且用户要求的部署/重启/运行态检查完成，才报告完成。
