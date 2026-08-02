# 安装与日常运维

## 目录

1. 安装本 Skill
2. 全新安装自定义源码版
3. 接收 `custom/prod` 的日常更新
4. 日常启停与健康检查
5. 常见安装问题

## 安装本 Skill

通过 Botmux registry 从自定义生产分支安装，显式写 `--path` 和 `--ref`，避免默认分支变化：

```bash
botmux skills install github:mmxyhSnow/botmux \
  --path skills/maintain-botmux-fork \
  --ref custom/prod
botmux skills inspect maintain-botmux-fork
botmux skills doctor
```

把 Skill 附加到需要维护 Botmux 的 bot：

```text
/skills attach maintain-botmux-fork
```

也可以在 Dashboard 的 `Skills` 页面 attach。仅安装、不 attach 时，Skill 已在 registry 中，
但不会成为该 bot 的 priority skill。更新和移除：

```bash
botmux skills update maintain-botmux-fork
botmux skills remove maintain-botmux-fork
```

`update` 会沿安装时记录的 `custom/prod` ref 更新。不要通过复制到多个 CLI 的全局目录维护多份副本。

生产源码部署的 primary daemon 启动后还会校验已安装 Skill：只有 registry 中已存在、来源确认为
`mmxyhSnow/botmux/skills/maintain-botmux-fork` 时，才把内容自动对齐到当前真实运行的
`custom/prod` commit，并继续把 `custom/prod` 保存为跟踪 ref。若同名 Skill 来自其它位置或更新失败，
daemon 不覆盖、不阻塞启动，只向 owner 告警。这样远端生产分支即使先推进，也不会把未来手册提前注入
仍运行旧代码的 daemon。

## 全新安装自定义源码版

### 1. 准备环境

要求 Node.js >= 22，仓库锁定 pnpm 9.5.0：

```bash
node --version
corepack enable
corepack prepare pnpm@9.5.0 --activate
pnpm --version
```

### 2. 克隆并校验双远端

```bash
git clone --branch custom/prod --single-branch \
  git@github.com:mmxyhSnow/botmux.git botmux
cd botmux
git remote add upstream https://github.com/deepcoldy/botmux.git
git fetch origin --prune
git fetch upstream --prune --tags
git symbolic-ref --short HEAD
git remote -v
git rev-parse HEAD
git rev-parse origin/custom/prod
```

预期分支是 `custom/prod`，两个 SHA 一致，双远端身份与
`.botmux-source-update.json` 一致。若 `upstream` 已存在，先回读 URL，再决定是否修改。

### 3. 构建并认领全局命令

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm use:here
```

确保 `~/.botmux/bin` 在 PATH 前部：

```bash
export PATH="$HOME/.botmux/bin:$PATH"
command -v botmux
sed -n '1,5p' "$HOME/.botmux/bin/botmux"
```

首次安装时，`pnpm build` 只构建，`pnpm use:here` 才认领全局 `botmux`。完成首个版本化部署后，
wrapper 会动态跟随 `~/.botmux/runtime/current`，普通更新不得再用 `switch:here` 绕过版本化门禁。

### 4. 首次配置并启动

新机器运行：

```bash
botmux setup
pnpm daemon:start
botmux status
```

已有机器不要重新执行 setup 覆盖配置。保留 `~/.botmux`，只切换程序 checkout，然后重启：

```bash
pnpm daemon:restart
botmux status
```

同一个飞书 app 不要让两台 daemon 同时监听；迁移时先完成新机配置，再明确停旧机。

## 接收 `custom/prod` 的日常更新

这是接收 fork 自定义提交，不是“同步官方版本”。只读检查仍从 canonical checkout 执行：

```bash
git fetch origin --prune
git rev-list --left-right --count HEAD...origin/custom/prod
```

生产更新统一由 HEAD 绑定发版卡完成：隔离构建版本目录、备份、原子切换、重启验收后才写 deploy tag。
不要把 canonical checkout 的手工 `merge/build/use:here/restart` 当作日常上线入口。如果 `rev-list`
显示本地领先或双方分叉，停止并查明提交归属；不要 reset 或强推。

## 日常启停与健康检查

优先从当前 checkout 调用 package script，避免 PATH 中另一个全局 botmux 抢先：

```bash
pnpm daemon:start
pnpm daemon:stop
pnpm daemon:restart
pnpm daemon:status
pnpm daemon:logs
```

部署或重启后至少检查：

```bash
sed -n '1,5p' "$HOME/.botmux/bin/botmux"
readlink -f "$HOME/.botmux/runtime/current"
readlink -f "$HOME/.botmux/runtime/controller"
botmux status
botmux bots
pm2 jlist | jq -r '.[] | [.name,.pm2_env.status,.pm2_env.pm_exec_path] | @tsv'
```

`botmux status` 顶部的 `Live` 身份是版本、commit 与 build-id 的单一出口；Dashboard 与重启通知
复用同一解析器，三处字符串必须一致。确认 `botmux-*` 和 `botmux-dashboard` 为 online，执行路径全部落在 `runtime/current` 指向版本的
`dist`。再检查运行清单 `.botmux-runtime-release.json`、近期日志，
并按变更类型做一次真实飞书消息、卡片交互、Dashboard 或 CLI 会话验证。

## 重启恢复与告警

- 重启后只追溯“精确 turn 在重启时仍运行”的任务；历史、空闲或无法确认归属的 ledger 记录二次扫描后
  静默标记 `suppressed`，不得向原群逐条发“未确认”消息。
- 同一 ASK flow 只在首题发送一次独立 @ 通知，后续问题原卡更新；重启恢复也不得为每一题重复 @。
- 存活 tmux/zellij 会话重挂时，仅当持久化 `quoteTargetId` 与当前回复目标完全一致才恢复 turn 绑定，
  使尚未收到新消息的会话仍可精确执行 `botmux send`；不一致时保持无归属，等待新消息重新绑定。
- Dashboard 对超过 daemon registry 心跳容忍窗口的离线 Bot 聚合私信 primary owner；同一离线集合只提醒
  一次，恢复在线后重新布防。它覆盖 PM2 打满重启、OOM 或进程长期离线；飞书 API 整体不可用时只能
  依赖本地日志和 Dashboard 状态，不能承诺同通道告警送达。
- Web/Riff 能力 URL 写日志时只允许输出不可逆短哈希或显式 `<redacted>`，不得输出 query token 或唯一
  sandbox host。

## 常见安装问题

- `package.json` 显示 `0.0.0`：源码部署的正常状态。官方更新比较取 HEAD 可达的最新正式
  `vX.Y.Z` 标签；维护重启卡优先显示精确指向运行 HEAD 的最新 `release/*` / `deploy/*` 候选版本。
- 修改后功能未生效：先核对 `runtime/current`、运行清单和 PM2 `pm_exec_path`；不要在 live 上补跑
  `use:here`，应修复发版链路或重新部署准确候选。
- 出现多个 `botmux`：用 `type -a botmux`、wrapper 内容和 PM2 `pm_exec_path` 确认实际生效版本。
- `pnpm install --frozen-lockfile` 失败：不要改 lockfile 绕过。先确认 Node/pnpm 版本及当前分支的
  `package.json`、`pnpm-lock.yaml` 是否配套。
- setup 或启动涉及凭据：不要把 AppSecret、token、`bots.json` 内容写进日志、提交或回复。
