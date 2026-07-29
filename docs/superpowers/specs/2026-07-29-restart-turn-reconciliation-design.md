# Botmux 重启后工作线程追溯与结论补偿设计

## 背景与故障证据

Botmux 已通过 tmux 保留重启期间仍在运行的 CLI，但 Worker 与 Daemon 的内存态会丢失。2026-07-29 的 `humanizer-zh` 安装任务复现了一个明确缺口：

- Botmux 在任务执行中重启；
- Codex 持久化 rollout 中存在该轮 `final_answer`；
- 飞书原线程中只有进度卡，没有最终回复；
- 恢复 Worker 观察到旧 Runner 已空闲后将其替换，但没有追溯已经落盘、尚未投递的 final。

因此，“CLI 进程仍存活”不等于“用户交付连续”。恢复逻辑还需要知道每个工作轮次是否已经产出结论、是否已经投递，以及重启后应继续跟踪还是补发结论。

## 目标

- 覆盖所有 Bot、CLI 和普通工作线程，不只修复 Codex App。
- 重启后自动追溯重启前未闭环的轮次。
- 已存在可靠 final 且未投递时，在原线程补发原结论。
- 任务仍在运行时，恢复进度跟踪并在结束后正常投递结论。
- CLI 已结束且没有可靠 final 时，基于原任务、最后进展和实际证据执行只读恢复检查，给出成功、失败或未完成结论。
- 恢复失败不得静默；原线程必须收到一次明确的恢复失败说明。
- 连续重启或“发送成功但本地回执尚未落盘”不得造成重复结论。

## 非目标

- 不重放重启前未确认完成的外部副作用。
- 不把进度卡 PATCH 当成最终回复投递。
- 不依靠模型猜测外部系统状态。
- 不在本次改动中统一重写各 CLI 的 transcript 解析器。
- 不恢复已关闭、已撤回或明确静默执行的轮次。

## 方案选择

采用“持久化交付账本 + 启动恢复器”。

仅扫描 transcript 无法证明结果是否已投递到飞书；重启后直接让模型重新执行又可能重复外部操作。持久化账本负责表达轮次状态与投递回执，各 CLI 现有 transcript 或原生事件只作为可靠结果源。恢复器只补偿账本中缺失的阶段。

## 状态模型

每个可见工作轮次用以下稳定键标识：

`larkAppId + sessionId + turnId + dispatchAttempt`

账本记录：

- 原线程和原消息路由；
- 原始任务摘要及最近一次可见进展；
- CLI 类型、原生会话标识和持久化结果源位置；
- `accepted`：任务已被 Botmux 接收；
- `running`：CLI 已确认开始执行；
- `final_observed`：可靠 final 已落盘，包含正文、结果类型和内容摘要；
- `delivery_pending`：final 等待投递；
- `delivered`：飞书返回 message id，结论已可见；
- `recovery_required`：重启后需要恢复判定；
- `recovery_failed`：恢复无法继续，包含可展示的原因。

状态只能前进。重复事件以稳定键和内容摘要去重；`delivered` 是用户交付闭环的唯一成功终态，进度卡变绿或 CLI 空闲都不能替代它。

## 组件边界

### TurnDeliveryLedger

独立持久化服务，负责原子写入、状态单调性、容量清理和按 Bot 隔离。账本使用 Botmux dataDir 下的版本化 JSONL/快照，不修改现有 session 主文件的大对象结构。

### TurnResultSource

统一各 CLI 的恢复查询接口：

- Codex App：读取 Codex rollout 中按 `clientUserMessageId` 绑定的 `final_answer`；
- 已有结构化 transcript 的 CLI：复用现有 parser 和原生 session id；
- 持久后端仍在运行：返回 `running`，由恢复 Worker 继续跟踪；
- 没有可靠结果源：返回 `unknown`，不得把终端画面或空闲提示猜成 final。

### RestartTurnReconciler

Daemon 完成 session 恢复后扫描所有 Bot 的非终态账本条目。每个条目先获取 session 级恢复租约，避免多 Daemon 或连续重启并发补偿。

判定顺序：

1. 已有 `delivered`：跳过。
2. 已有 `final_observed`：进入幂等投递。
3. 结果源返回可靠 final：写入 `final_observed` 后投递。
4. 结果源返回 `running`：恢复 Worker/进度订阅，等待原任务结束。
5. 进程已结束且结果未知：创建只读恢复检查，不执行写操作或外部副作用。
6. 无法恢复：写入 `recovery_failed`，在原线程发送一次明确说明。

### IdempotentFinalDelivery

最终回复使用由稳定轮次键派生的 provider 幂等键。发送前先写 `delivery_pending`；收到飞书 message id 后写 `delivered`。若进程在二者之间崩溃，恢复器使用相同幂等键重试并回收同一 provider 结果。

现有 `deliverFinalOutput` 继续作为统一出站入口，但其成功回执必须进入账本；显式 `botmux send` 若承担该轮最终回复，也必须以同一轮次键登记 `delivered`。普通中途进度发送不能关闭账本。

## 恢复检查约束

只读恢复检查只允许：

- 读取原任务、Botmux history、CLI transcript、Git 状态、构建状态和其它已有证据；
- 汇总已确认结果；
- 判断任务成功、失败或未完成。

它不得自动重复安装、提交、发布、删除、重启或其它可能重复产生副作用的操作。若任务实际未完成，结论必须写清剩余步骤，由正常后续轮次继续处理。

## 用户可见行为

- 已有 final：原线程收到缺失的原结论，不额外发送“Botmux 已重启”噪音。
- 仍在运行：保留原进度卡，恢复后续进展和最终结论。
- 需要只读追溯：原线程先收到一次“重启后恢复检查”状态，随后收到明确结论。
- 恢复失败：原线程收到已确认进度、缺失证据和下一步，不静默结束。
- 所有补偿消息只进入原线程，不集中发到 owner 私聊。

## 数据保留与安全

- `delivered` 条目保留有限时间后清理，未闭环条目不得因普通容量清理丢失。
- 账本不保存 Token、凭据、完整终端输出或附件内容。
- 不跨 Bot 读取 session 或发送回复。
- 已关闭、已撤回、静默调度、HTTP wait/async trigger 等非普通可见轮次沿用现有专用终态，不进入通用补发。

## 测试与验收

单元测试覆盖：

- 状态单调性与稳定键；
- final 已存在但无投递回执；
- 发送成功、回执落盘前再次重启；
- 运行中、未知、恢复失败和已关闭分支；
- 多 Bot 隔离、连续重启和恢复租约竞争。

集成测试覆盖：

- Codex App 在 final marker 前、后重启；
- 一个复用现有 transcript bridge 的非 Codex App CLI；
- tmux 仍运行与 CLI 已退出两类恢复；
- 显式最终发送和普通进度发送的闭环差异。

Live 验收使用受控线程：

1. 发起包含可验证只读结果的长任务；
2. 中途执行 Botmux 重启；
3. 验证原线程继续收到进展；
4. 验证最终结论只出现一次；
5. 再次重启，确认不重复补发；
6. 用本次 `humanizer-zh` 故障数据作为 transcript 已有 final、飞书无回执的回归样例。

## 发布与回滚

先在测试 dataDir 运行故障注入，再构建并部署当前 checkout。Live 重启前保留旧版本指向；若恢复器出现重复回复或跨线程路由，关闭恢复器开关并切回旧 build。账本为新增旁路数据，回滚不影响现有 session 恢复。
