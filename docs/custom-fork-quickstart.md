# Botmux 自定义版 5 分钟接入

本文面向希望独立部署 `mmxyhSnow/botmux` 自定义版的使用者。每个人在自己的机器上运行独立
daemon，使用自己的飞书应用、CLI 登录态、工作目录和会话数据；大家通过公开 GitHub 仓库共享代码，
也可以把各自的机器人拉进同一个群协作。

## 先理解四个分支角色

- `mmxyhSnow/botmux:custom/dev`：已确认加入待发版的需求集成线，候选版本从这里冻结。
- `mmxyhSnow/botmux:custom/prod`：自定义版生产真源，新部署和日常更新都跟随它。
- `mmxyhSnow/botmux:master`：只跟随官方代码，不包含全部自定义能力。
- `deepcoldy/botmux`：官方只读上游，只由维护者按正式版本标签同步。

自定义版不要通过 `npm install -g botmux` 安装或升级；该命令安装的是官方 npm 包。

## 需要准备

- Linux 或 macOS 机器，Node.js 22 或更高版本。
- Git，以及可以长期运行 daemon 的用户账号。
- 一个已安装并登录的 Agent CLI，例如 Codex、Claude Code、Trae、Gemini。
- 可扫码登录飞书开放平台的飞书账号；也可以使用自己已有应用的 App ID 和 App Secret。
- 仅部署无需 GitHub 写权限；参与共同维护时，再准备 GitHub 账号和 SSH 公钥。

任何 App Secret、Token、SSH 私钥、`bots.json` 或 Dashboard 凭证都只留在自己的机器上，不要通过
群聊、GitHub Issue、PR 或文档传递。

## 已有官方版：原地无感迁移

已有官方 npm 版时，不需要重建飞书应用，也不要重新运行 `botmux setup`。自定义版与官方版都从
同一位系统用户的 `~/.botmux` 读取配置和数据；原来的机器人 App ID、App Secret、owner、工作目录、
会话记录、附件、Dashboard 配置以及 CLI 登录态都会继续使用。

当前 `custom/prod` 包含官方最新稳定版 `v3.7.1`。从官方稳定版迁移可以直接切换；如果当前版本带
`canary`、`beta` 或 `rc` 后缀，或版本高于 `v3.7.1`，先停止并比较配置兼容性，不要直接降级。

### 1. 迁移前留证和备份

必须使用原来运行官方 Botmux 的同一位系统用户：

```bash
botmux --version
botmux status
botmux setup list
type -a botmux

migration_backup="$HOME/botmux-migration-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -C "$HOME" -czf "$migration_backup" .botmux
chmod 600 "$migration_backup"
```

备份包含飞书凭证和会话数据，只能保留在本机，不要上传或分享。

### 2. 在新目录构建自定义版

不要覆盖或卸载现有官方包，先并行准备源码 checkout：

```bash
git clone --branch custom/prod --single-branch \
  https://github.com/mmxyhSnow/botmux.git botmux-custom
cd botmux-custom
git remote add upstream https://github.com/deepcoldy/botmux.git

corepack enable
corepack prepare pnpm@9.5.0 --activate
pnpm install --frozen-lockfile
pnpm build
```

### 3. 切换程序并重建 daemon

下面两条命令只切换程序入口和 PM2 进程，不会改写 `~/.botmux/bots.json`：

```bash
pnpm use:here
pnpm daemon:restart
```

迁移包含一次短暂 daemon 重启，因此“无感”指机器人身份、配置和会话连续，不代表完全零中断。
不要在切换前执行 `npm uninstall -g botmux`；旧包先保留，方便回滚。

### 4. 迁移后验收

```bash
botmux status
botmux setup list
type -a botmux
sed -n '1,5p' "$HOME/.botmux/bin/botmux"
pm2 jlist | jq -r '.[] | select(.name | startswith("botmux")) | [.name,.pm2_env.status,.pm2_env.pm_exec_path] | @tsv'
```

验收标准：

- 机器人数量、App ID、CLI、owner 和工作目录与迁移前一致。
- `botmux-*` 与 `botmux-dashboard` 全部 online。
- PM2 的 `pm_exec_path` 指向新源码 checkout 的 `dist/`。
- 原来的机器人私聊、群聊 @、Dashboard 和一条已有会话都能继续使用。

验证通过前不要删除旧官方包或本地备份。如果失败，配置没有被改写；使用 `type -a botmux` 留存的
旧官方可执行文件重新启动原版本即可回滚。

## 全新部署

下面步骤只适用于尚未配置过 Botmux 的机器。已有官方版请使用上一节的原地迁移流程。

## 1. 获取自定义版源码

只部署、不向仓库推送代码时可以使用 HTTPS：

```bash
git clone --branch custom/prod --single-branch \
  https://github.com/mmxyhSnow/botmux.git botmux
cd botmux
git remote add upstream https://github.com/deepcoldy/botmux.git
```

已经获得仓库协作权限、需要推送代码时，将 `origin` 改为自己的 GitHub SSH 身份：

```bash
git remote set-url origin git@github.com:mmxyhSnow/botmux.git
ssh -T git@github.com
```

校验当前分支和双远端：

```bash
git symbolic-ref --short HEAD
git remote -v
git rev-parse HEAD
git rev-parse origin/custom/prod
```

预期分支为 `custom/prod`，后两个 SHA 完全一致。

## 2. 构建并启用当前源码

仓库锁定 pnpm 9.5.0：

```bash
corepack enable
corepack prepare pnpm@9.5.0 --activate
pnpm install --frozen-lockfile
pnpm build
pnpm use:here
```

确认全局 `botmux` 已指向当前 checkout：

```bash
command -v botmux
sed -n '1,5p' "$HOME/.botmux/bin/botmux"
```

## 3. 创建自己的飞书机器人

推荐直接运行交互式向导，扫码创建飞书应用并自动配置权限、长连接事件和发布版本：

```bash
botmux setup
```

向导中选择：

1. 自己已登录的 Agent CLI。
2. 允许机器人访问的工作目录。
3. 至少一位 owner；使用完整邮箱、`union_id` 或 `open_id`。

如果使用已有飞书应用，也在向导里录入自己的 App ID 和 App Secret。不要复用其他部署者的飞书
应用；同一个飞书应用不能同时被两台 daemon 监听。

## 4. 启动并验收

```bash
botmux start
botmux status
botmux bots
```

然后完成三项真实验证：

1. 私聊机器人发送一条消息，确认能够收到流式回复卡片。
2. 把机器人拉入目标群并 @ 一次，确认群消息能触发。
3. 打开 Dashboard，确认机器人、会话和工作目录正确。

建议开启当前用户的开机自启：

```bash
botmux autostart enable
```

## 5. 安装共同维护规范

维护者和希望自动识别本 fork 运维任务的机器人安装同一份 Skill：

```bash
botmux skills install github:mmxyhSnow/botmux \
  --path skills/maintain-botmux-fork \
  --ref custom/prod
botmux skills inspect maintain-botmux-fork
botmux skills doctor
```

再在 Dashboard 的 `Skills` 页面附加 `maintain-botmux-fork`，或对机器人发送：

```text
/skills attach maintain-botmux-fork
```

## 日常更新

只在生产 checkout 没有未提交改动和本地独有提交时更新：

```bash
git fetch origin --prune
git rev-list --left-right --count HEAD...origin/custom/prod
git merge --ff-only origin/custom/prod
pnpm install --frozen-lockfile
pnpm build
pnpm use:here
pnpm daemon:restart
botmux status
```

`rev-list` 预期为 `0 0` 或仅远端领先。本地领先、双方分叉或工作区不干净时先停止，查明提交归属；
不要用 reset、强推或覆盖配置解决。

## 参与共同维护

仓库公开可读，因此普通部署不需要邀请。需要直接推送开发分支时：

1. 把 GitHub 用户名发给仓库 owner，由 owner 邀请为 collaborator。
2. 在自己的 GitHub 账号添加 SSH 公钥，私钥始终保留在本机。
3. 从最新 `origin/custom/dev` 创建单一职责的 `feat/*`、`fix/*`、`refactor/*` 或 `docs/*` 分支。
4. 开发分支验证并 push 后，由需求提出者选择是否加入当前待发版；只有确认后才合入 `custom/dev`。
5. 不直接向 `custom/prod` 提交开发 PR；生产分支只接收已冻结的候选版本。

共同遵守以下分支约定：

- `master`：官方镜像。
- `custom/dev`：待发需求集成真源。
- `custom/prod`：自定义生产真源。
- `upgrade/vX.Y.Z`：合入官方正式版的临时升级分支。
- `release/vX.Y.Z-custom.N`：通过测试和构建的不可变候选版本。
- `deploy/vX.Y.Z-custom.N`：同号候选版本的已部署快照标签。

查看待发状态、冻结候选、推进生产和部署留痕分别使用：

```bash
pnpm release:status
pnpm release:prepare
pnpm release:promote -- --tag release/vX.Y.Z-custom.N
pnpm release:record-deploy -- --tag release/vX.Y.Z-custom.N
```

`release:prepare` 在 `custom/dev` 执行全量 unit 与构建后才打候选标签；`release:promote` 只把准确候选
commit fast-forward 到 `custom/prod`，不会部署或重启；`release:record-deploy` 只能在真实运行态验收后
执行。各部署者仍只拉取 `custom/prod`，官方升级、候选冻结、生产推进、部署标签和回滚由维护者串行操作。

## 常见问题

- `package.json` 版本显示 `0.0.0`：源码部署的正常状态，不代表安装失败。
- 修改后未生效：通常是漏了 `pnpm use:here`，或 daemon 仍指向另一个 checkout。
- 收不到飞书消息：检查应用是否已发布、事件与回调是否使用长连接，以及是否订阅
  `im.message.receive_v1`。
- `pnpm install --frozen-lockfile` 失败：先确认 Node.js、pnpm 版本和当前分支，不要修改 lockfile
  绕过。
- 机器迁移：先配置并验证新机器，再停止旧 daemon；不要让两台机器监听同一个飞书应用。
