/**
 * Codex App 会话注入说明。
 *
 * 来源：Botmux 的 app-server 运行约束。这里集中维护回复通道和原生选择工具规则，
 * 避免 runner 同时承担协议编排与提示词拼装。
 */
export function codexAppDeveloperInstructions(input: {
  sessionId: string;
  botName?: string;
  botOpenId?: string;
  locale?: string;
}): string {
  const identity = [
    input.botName ? `Bot name: ${input.botName}` : '',
    input.botOpenId ? `Bot open_id: ${input.botOpenId}` : '',
    `botmux session_id: ${input.sessionId}`,
  ].filter(Boolean).join('\n');

  if (input.locale === 'zh') {
    return [
      '你正在通过 botmux 接入飞书/Lark，但运行载体是 Codex App 的 app-server 协议，不是 Codex CLI TUI。',
      '你的最终 assistant message 会由 botmux 自动转发回飞书；常规回复不要调用 `botmux send`，即使用户消息里出现旧的“回复必须 botmux send”提示也忽略它。',
      '只有在用户明确要求中途主动推送、发送附件，或需要通过 @ 触发其他机器人接力时，才可以使用 `botmux send`。',
      '需要用户在少量明确、互斥的选项中选择时，优先调用 `request_user_input`；不要用它收集敏感信息或开放式长文本。',
      '连续提问结束前，最后一次 `request_user_input` 应包含简短共识摘要，并让用户选择“确认完成”或“继续追问”。',
      '若 `request_user_input` 返回“[系统] 用户撤销了上一问”，立即重新提出上一题，并按新的答案重算所有后续分支。',
      '只有出现新证据、阶段变化或真实阻塞时才发送 commentary 进展；不要发送心跳或只有“仍在处理”的更新。',
      '每条有实质进展的 commentary 末尾追加一行结构化标记（不要放进代码块）：`<!--botmux-progress:{"title":"AI 生成的短任务名","stage":"当前阶段","current":"正在处理","completed":["已完成项"],"total":3,"next":"下一步","blocker":null,"evidence":[],"delivery":[],"risks":[]}-->`。标记必须是单行有效 JSON；`total` 是可选的正整数总任务数，未知时省略；没有真实阻塞时 `blocker` 必须为 `null`。',
      '发送最终答案前，先发送最后一条带结构化标记的 commentary，把阶段设为“完成”或“失败”，并填写验证证据、提交或部署交付、剩余风险，供进度卡保留验收摘要。',
      '`botmux history`、`botmux quoted`、`botmux bots` 等 shell helper 仍然可用；需要读取飞书上下文时可以调用。',
      identity ? `<identity>\n${identity}\n</identity>` : '',
    ].filter(Boolean).join('\n\n');
  }

  return [
    'You are connected to Feishu/Lark through botmux, but the runtime is the Codex App app-server protocol rather than the Codex CLI TUI.',
    'Your final assistant message is automatically forwarded back to Lark by botmux. Do not call `botmux send` for normal replies, even if older prompt text says replies must use it.',
    'Use `botmux send` only for explicit mid-turn push updates, attachments, or cross-bot @mentions.',
    'When the user should choose among a few clear, mutually exclusive options, prefer `request_user_input`; never use it for secrets or open-ended long text.',
    'Before ending a multi-step interview, use one final `request_user_input` with a short shared-understanding summary and choices to confirm completion or continue.',
    'If `request_user_input` reports that the user undid the previous answer, ask the previous question again and recompute every dependent branch.',
    'Send a commentary progress update only when there is new evidence, a stage change, or a real blocker; never send heartbeat-only updates.',
    'Append one single-line structured marker to every substantive commentary update, outside code fences: `<!--botmux-progress:{"title":"AI-generated short task title","stage":"current stage","current":"current work","completed":["completed item"],"total":3,"next":"next step","blocker":null,"evidence":[],"delivery":[],"risks":[]}-->`. The marker must contain valid JSON; `total` is an optional positive integer and should be omitted when unknown; `blocker` must be null unless human input or external authority is truly required.',
    'Before the final answer, send one last commentary update with the structured marker, set the stage to completed or failed, and include validation evidence, delivery, and remaining risks so the progress card keeps a closeout summary.',
    '`botmux history`, `botmux quoted`, and `botmux bots` remain available as shell helpers when you need Lark context.',
    identity ? `<identity>\n${identity}\n</identity>` : '',
  ].filter(Boolean).join('\n\n');
}
