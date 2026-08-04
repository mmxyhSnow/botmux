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
// 状态变更关键词：冻结、合入、部署、上线、发布、重启及其英文形式。用 `g` 逐个定位以便判定否定语境。
const AUTHORIZATION_KEYWORD_PATTERN =
  /冻结|合入|部署|上线|发布|重启|\bfreeze\b|\bmerge\b|\bdeploy\b|\brelease\b|\brestart\b/gi;
// 子句强分隔符：跨过它就不再算同一句，避免否定词误跨句作用到后面的肯定关键词。
// 顿号是同一否定列表内的连接符，不能切断“不冻结、部署或重启”里的否定范围。
const CLAUSE_DELIMITER = /[。！？!?；;，,\n\r：:]/;
// 关键词紧邻前缀里的“连接词/其它关键词/空白”噪声；剥掉后才能露出真正的否定词尾。
const AUTHORIZATION_TAIL_NOISE =
  /(?:冻结|合入|部署|上线|发布|重启|freeze|merge|deploy|release|restart|and|or|[、，,和与及或\/\s])+$/i;
// 否定词尾：命中说明该关键词处于“暂不/不/无需…”等否定语境，不构成真正的状态变更意图。
const NEGATION_SUFFIX =
  /(?:暂缓|暂停|暂不|先不|不再|不会|不予|不用|不要|无需|无须|勿|别|未|非|不|no|not|without|never|do(?:es)?\s*n['’]?t|do\s+not|won['’]?t)\s*$/i;
const CUSTOM_RELEASE_FREEZE_ACTION_PATTERN =
  /(?:冻结|freeze)[^<>\r\n]{0,40}(?:release\/v)?\d+\.\d+\.\d+-custom\.\d+/i;

/** 读取 v2 动作契约字段；空白或非字符串字段视为缺失。 */
function actionContractPart(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/**
 * 把 v2 的目标、范围和验收条件组装成可直接回灌的新用户回合。
 * 中文契约使用中文字段名，其余语言使用英文，避免生成依赖额外 locale 状态。
 */
function actionPromptFromContract(raw: Record<string, unknown>): string | undefined {
  const target = actionContractPart(raw.target);
  const scope = actionContractPart(raw.scope);
  const acceptance = actionContractPart(raw.acceptance);
  if (!target || !scope || !acceptance) return undefined;

  const usesChinese = /[\u3400-\u9fff]/.test(`${target}${scope}${acceptance}`);
  return usesChinese
    ? `目标：${target}\n范围：${scope}\n验收：${acceptance}`
    : `Target: ${target}\nScope: ${scope}\nAcceptance: ${acceptance}`;
}

/**
 * 判断某个状态变更关键词是否落在否定语境里。
 * 只在同一子句内向前看：先截到最近的强分隔符之后，再剥掉紧邻的连接词/其它关键词/空白，
 * 若剩余片段以否定词收尾（如“暂不”“不部署或”末尾的“不”），即认定该关键词被否定。
 */
function keywordOccurrenceIsNegated(prefix: string): boolean {
  let clause = prefix;
  for (let i = prefix.length - 1; i >= 0; i--) {
    if (CLAUSE_DELIMITER.test(prefix[i])) {
      clause = prefix.slice(i + 1);
      break;
    }
  }
  const stripped = clause.replace(AUTHORIZATION_TAIL_NOISE, '');
  return NEGATION_SUFFIX.test(stripped);
}

/**
 * 是否存在“肯定语气”的状态变更（冻结/合入/部署/上线/发布/重启）。
 * 逐个关键词判定：只要有一处不在否定语境里，就需要显式授权；
 * 全部处于否定语境（如“暂不合入 custom/dev，不部署或重启”）时返回 false，普通动作即可放行。
 */
export function requiresExplicitAuthorization(prompt: string): boolean {
  const scanner = new RegExp(AUTHORIZATION_KEYWORD_PATTERN.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(prompt)) !== null) {
    if (!keywordOccurrenceIsNegated(prompt.slice(0, match.index))) return true;
  }
  return false;
}

/**
 * 判断卡片动作能否作为新用户回合提交。
 * 不可逆危险操作始终拒绝；合入、部署、发布和重启只有在按钮声明显式授权时放行，
 * 但仅当这些关键词是“肯定语气”时才要求授权——否定表述（暂不合入/不部署重启）不算状态变更。
 */
export function isSafeFinalReplyActionPrompt(
  prompt: string,
  authorization?: 'explicit',
): boolean {
  const normalized = prompt.trim();
  return normalized.length > 0
    && normalized.length <= MAX_PROMPT_LENGTH
    && !FORBIDDEN_ACTION_PATTERN.test(normalized)
    && !CUSTOM_RELEASE_FREEZE_ACTION_PATTERN.test(normalized)
    && (
      !requiresExplicitAuthorization(normalized)
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

  // v2 默认只保留最可能的一个动作；只有明确声明为互斥选项时才允许最多三个。
  const isVersionTwo = (parsed as { version?: unknown }).version === 2;
  const maxActions = isVersionTwo
    && (parsed as { relationship?: unknown }).relationship !== 'alternatives'
    ? 1
    : MAX_ACTIONS;

  const actions: FinalReplyAction[] = [];
  const labels = new Set<string>();
  for (const raw of rawActions) {
    if (!raw || typeof raw !== 'object') continue;
    const label = typeof (raw as any).label === 'string' ? (raw as any).label.trim() : '';
    const prompt = isVersionTwo
      ? actionPromptFromContract(raw as Record<string, unknown>) ?? ''
      : typeof (raw as any).prompt === 'string' ? (raw as any).prompt.trim() : '';
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
    if (actions.length >= maxActions) break;
  }
  return { content, actions };
}
