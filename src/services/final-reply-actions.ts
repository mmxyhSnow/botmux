/**
 * 解析模型在最终回复末尾生成的快捷操作协议，并在进入飞书卡片前移除内部标记。
 */

export interface FinalReplyAction {
  label: string;
  prompt: string;
  /** 状态变更动作必须由用户点击显式授权，普通只读动作无需此字段。 */
  authorization?: 'explicit';
}

export interface ExtractedFinalReplyActions {
  content: string;
  actions: FinalReplyAction[];
}

const TERMINAL_ACTION_MARKER = /(?:\r?\n)?<!--botmux-actions:([^\r\n]*?)-->\s*$/;
const MAX_ACTIONS = 3;
const MAX_LABEL_LENGTH = 20;
const MAX_PROMPT_LENGTH = 300;
const FORBIDDEN_ACTION_PATTERN =
  /(?:删除|清空|强推|强制推送|重置|回滚|授权|提权|管理员权限|支付|付款|转账|rm\s+-rf|git\s+reset\s+--hard|push\s+--force|force[- ]?push|delete|drop\s+(?:table|database)|truncate|rollback|grant\s+permission|payment)/i;
const EXPLICIT_AUTHORIZATION_PATTERN =
  /(?:合入|部署|上线|发布|重启|\bmerge\b|\bdeploy\b|\brelease\b|\brestart\b)/i;

/**
 * 判断卡片动作能否作为新用户回合提交。
 * 不可逆危险操作始终拒绝；合入、部署、发布和重启只有在按钮声明显式授权时放行。
 */
export function isSafeFinalReplyActionPrompt(
  prompt: string,
  authorization?: 'explicit',
): boolean {
  const normalized = prompt.trim();
  return normalized.length > 0
    && normalized.length <= MAX_PROMPT_LENGTH
    && !FORBIDDEN_ACTION_PATTERN.test(normalized)
    && (
      !EXPLICIT_AUTHORIZATION_PATTERN.test(normalized)
      || authorization === 'explicit'
    );
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
    const rawAuthorization = (raw as any).authorization;
    if (rawAuthorization !== undefined && rawAuthorization !== 'explicit') continue;
    const authorization = rawAuthorization === 'explicit' ? 'explicit' as const : undefined;
    if (!label || label.length > MAX_LABEL_LENGTH || labels.has(label)) continue;
    if (!isSafeFinalReplyActionPrompt(prompt, authorization)) continue;
    labels.add(label);
    actions.push({
      label,
      prompt,
      ...(authorization ? { authorization } : {}),
    });
    if (actions.length >= MAX_ACTIONS) break;
  }
  return { content, actions };
}
