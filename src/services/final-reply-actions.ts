/**
 * 解析模型在最终回复末尾生成的快捷操作协议，并在进入飞书卡片前移除内部标记。
 */

export interface FinalReplyAction {
  label: string;
  prompt: string;
}

export interface ExtractedFinalReplyActions {
  content: string;
  actions: FinalReplyAction[];
}

const TERMINAL_ACTION_MARKER = /(?:\r?\n)?<!--botmux-actions:([^\r\n]*?)-->\s*$/;
const MAX_ACTIONS = 3;
const MAX_LABEL_LENGTH = 20;
const MAX_PROMPT_LENGTH = 300;
const UNSAFE_ACTION_PATTERN =
  /(?:删除|清空|强推|强制推送|重置|回滚|部署|上线|发布|重启|授权|提权|管理员权限|支付|付款|转账|rm\s+-rf|git\s+reset\s+--hard|push\s+--force|force[- ]?push|delete|drop\s+(?:table|database)|truncate|deploy|release|restart|grant\s+permission|payment)/i;

/** 判断卡片动作是否只会发起一个可由会话继续处理的低风险自然语言回合。 */
export function isSafeFinalReplyActionPrompt(prompt: string): boolean {
  const normalized = prompt.trim();
  return normalized.length > 0
    && normalized.length <= MAX_PROMPT_LENGTH
    && !UNSAFE_ACTION_PATTERN.test(normalized);
}

/** 提取末尾结构化动作；畸形标记也会被隐藏，避免内部协议泄漏到用户正文。 */
export function extractFinalReplyActions(text: string): ExtractedFinalReplyActions {
  const match = TERMINAL_ACTION_MARKER.exec(text);
  if (!match) return { content: text, actions: [] };

  const content = text.slice(0, match.index).trimEnd();
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return { content, actions: [] };
  }

  const rawActions = (parsed as { actions?: unknown })?.actions;
  if (!Array.isArray(rawActions)) return { content, actions: [] };

  const actions: FinalReplyAction[] = [];
  const labels = new Set<string>();
  for (const raw of rawActions) {
    if (!raw || typeof raw !== 'object') continue;
    const label = typeof (raw as any).label === 'string' ? (raw as any).label.trim() : '';
    const prompt = typeof (raw as any).prompt === 'string' ? (raw as any).prompt.trim() : '';
    if (!label || label.length > MAX_LABEL_LENGTH || labels.has(label)) continue;
    if (!isSafeFinalReplyActionPrompt(prompt)) continue;
    labels.add(label);
    actions.push({ label, prompt });
    if (actions.length >= MAX_ACTIONS) break;
  }
  return { content, actions };
}
