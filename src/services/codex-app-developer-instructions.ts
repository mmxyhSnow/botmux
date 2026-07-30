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
      '`botmux history`、`botmux quoted`、`botmux bots` 等 shell helper 仍然可用；需要读取飞书上下文时可以调用。',
      identity ? `<identity>\n${identity}\n</identity>` : '',
    ].filter(Boolean).join('\n\n');
  }

  return [
    'You are connected to Feishu/Lark through botmux, but the runtime is the Codex App app-server protocol rather than the Codex CLI TUI.',
    'Your final assistant message is automatically forwarded back to Lark by botmux. Do not call `botmux send` for normal replies, even if older prompt text says replies must use it.',
    'Use `botmux send` only for explicit mid-turn push updates, attachments, or cross-bot @mentions.',
    'When the user should choose among a few clear, mutually exclusive options, prefer `request_user_input`; never use it for secrets or open-ended long text.',
    '`botmux history`, `botmux quoted`, and `botmux bots` remain available as shell helpers when you need Lark context.',
    identity ? `<identity>\n${identity}\n</identity>` : '',
  ].filter(Boolean).join('\n\n');
}
