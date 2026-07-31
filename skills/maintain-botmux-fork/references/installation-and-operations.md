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

`pnpm build` 只构建，不会悄悄改全局 wrapper；`pnpm use:here` 才会让全局 `botmux`
指向当前 checkout。`pnpm switch:here` 等价于 `build + use:here`。

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

这是接收 fork 自定义提交，不是“同步官方版本”。只在生产 checkout clean 且本地没有独有提交时执行：

```bash
git fetch origin --prune
git rev-list --left-right --count HEAD...origin/custom/prod
git merge --ff-only origin/custom/prod
pnpm install --frozen-lockfile
pnpm build
pnpm use:here
pnpm daemon:restart
```

如果 `rev-list` 显示本地领先或双方分叉，停止自动更新并查明提交归属；不要 reset 或强推。

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
botmux status
botmux bots
pm2 jlist | jq -r '.[] | [.name,.pm2_env.status,.pm2_env.pm_exec_path] | @tsv'
```

确认 `botmux-*` 和 `botmux-dashboard` 为 online，执行路径落在预期生产 checkout。再检查近期日志，
并按变更类型做一次真实飞书消息、卡片交互、Dashboard 或 CLI 会话验证。

## 常见安装问题

- `package.json` 显示 `0.0.0`：源码部署的正常状态。官方更新比较取 HEAD 可达的最新正式
  `vX.Y.Z` 标签；维护重启卡优先显示精确指向运行 HEAD 的最新 `release/*` / `deploy/*` 候选版本。
- 修改后功能未生效：通常是只跑了 `pnpm build`，未 `pnpm use:here`/`switch:here`，
  或 daemon 仍从另一个 checkout 启动。
- 出现多个 `botmux`：用 `type -a botmux`、wrapper 内容和 PM2 `pm_exec_path` 确认实际生效版本。
- `pnpm install --frozen-lockfile` 失败：不要改 lockfile 绕过。先确认 Node/pnpm 版本及当前分支的
  `package.json`、`pnpm-lock.yaml` 是否配套。
- setup 或启动涉及凭据：不要把 AppSecret、token、`bots.json` 内容写进日志、提交或回复。
