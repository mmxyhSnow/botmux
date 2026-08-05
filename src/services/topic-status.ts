/**
 * 话题任务状态的统一格式与路由别名判定。
 *
 * 本模块只做纯计算，不访问飞书或会话存储；消息创建、编辑和持久化由调用方负责。
 */
import type { CodexAppProgressCardSessionState, Session } from '../types.js';
import { computeExternalOutcome } from './codex-app-progress-external.js';

/** Dashboard 单 Bot 可配置的三档展示模式。 */
export type TopicStatusDisplayMode = 'off' | 'reply-preview' | 'bot-root';

/** 用户在话题列表中看到的任务生命周期。 */
export type TopicTaskPhase =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'interrupted';

const STATUS_LABELS: Record<TopicTaskPhase, string> = {
  running: '⏳ 进行中',
  waiting: '🙋 待互动',
  completed: '✅ 已结束',
  failed: '❌ 失败',
  blocked: '⚠️ 受阻',
  interrupted: '⏹️ 已中断',
};
const MAX_STATUS_TITLE_CHARS = 40;

/** 非法或缺省配置统一回落为 off，保证升级后行为不变。 */
export function normalizeTopicStatusDisplayMode(value: unknown): TopicStatusDisplayMode {
  return value === 'reply-preview' || value === 'bot-root' ? value : 'off';
}

/** 把任意提问或 AI 标题压成适合飞书话题列表的一行摘要。 */
export function normalizeTopicStatusTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  const normalized = title || '未命名任务';
  return normalized.length > MAX_STATUS_TITLE_CHARS
    ? `${normalized.slice(0, MAX_STATUS_TITLE_CHARS - 1)}…`
    : normalized;
}

/** 固定输出“状态图标｜一句话摘要”，避免不同投递路径产生不同口径。 */
export function formatTopicStatusLine(phase: TopicTaskPhase, title: unknown): string {
  return `${STATUS_LABELS[phase]}｜${normalizeTopicStatusTitle(title)}`;
}

/** 从权威进度状态推导列表状态；外部作业未终态时不能误标已结束。 */
export function progressStateTopicPhase(
  state: Pick<CodexAppProgressCardSessionState, 'phase' | 'overview'>,
): TopicTaskPhase {
  if (state.phase === 'running') return state.overview?.blocker ? 'blocked' : 'running';
  if (state.phase === 'failed') return 'failed';
  if (state.phase === 'interrupted') return 'interrupted';
  const external = computeExternalOutcome(state.overview?.external);
  if (external === 'failed') return 'failed';
  if (external === 'pending') return 'running';
  if (external === 'unknown') return 'blocked';
  return 'completed';
}

/** 机器人根消息模式的最小持久化会话视图。 */
type TopicAliasSession = Pick<
  Session,
  'status' | 'larkAppId' | 'chatId' | 'scope' | 'rootMessageId' | 'sessionId' | 'topicStatusBinding'
>;

/**
 * 把原用户话题 A 定向到机器人话题 B；只认同 bot、同群、active 且字段自洽的会话。
 */
export function findBotOwnedTopicAlias(
  sessions: readonly TopicAliasSession[],
  originalRootMessageId: string,
  chatId: string,
  larkAppId: string,
): { chatId: string; sessionId: string; anchor: string } | null {
  const hit = sessions.find(session => {
    const binding = session.topicStatusBinding;
    return session.status === 'active'
      && session.larkAppId === larkAppId
      && session.chatId === chatId
      && session.scope === 'thread'
      && binding?.mode === 'bot-root'
      && binding.originalRootMessageId === originalRootMessageId
      && binding.botRootMessageId === session.rootMessageId;
  });
  return hit
    ? { chatId: hit.chatId, sessionId: hit.sessionId, anchor: hit.rootMessageId }
    : null;
}
