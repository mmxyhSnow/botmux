/**
 * 外部作业（MR / CI / HAR 等）状态的结构化归类。
 *
 * 关键约束：只消费 AI 显式上报的 `overview.external[]`（label + status），
 * 用一张固定的状态词表把 status 归类为四种确定态，绝不从自由文本 commentary
 * 里猜测外部结果。无法归类的 status 一律落到 `unknown`，走「未确认」措辞，
 * 而不是乐观地当作成功。
 */
import type {
  CodexAppProgressExternalJob,
  CodexAppProgressOverview,
} from '../types.js';

/** 单条外部作业归类后的确定态。 */
export type ExternalJobCategory = 'success' | 'failed' | 'pending' | 'unknown';

/**
 * 一次任务的外部整体结论。
 * - `none`：AI 完全没有上报 external，无法断言外部结果。
 * - 其余四态由所有外部作业按「失败 > 进行中 > 未确认 > 成功」的严重度聚合。
 */
export type ExternalOutcome = 'none' | ExternalJobCategory;

const FAILED_TOKENS = [
  'fail', 'failure', 'error', 'reject', 'abort', 'cancel', 'broke', 'timeout',
  'timed out', 'crash', 'denied', 'declined',
];
const PENDING_TOKENS = [
  'run', 'queue', 'pending', 'progress', 'upgrad', 'build', 'open', 'wait',
  'process', 'start', 'none', 'null', 'ongoing', 'active', 'created', 'trigger',
];
const SUCCESS_TOKENS = [
  'success', 'succeed', 'succeeded', 'passed', 'pass', 'done', 'complete',
  'completed', 'merged', 'finished', 'ok', 'green', 'ready', 'available',
  'published', 'released',
];

/**
 * 把平台回读到的 status 文本归类为确定态。
 * 词表匹配失败时返回 `unknown`，交由上层用「未确认」措辞保守表达。
 */
export function classifyExternalJobStatus(status: string): ExternalJobCategory {
  const normalized = status.trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (FAILED_TOKENS.some(token => normalized.includes(token))) return 'failed';
  if (SUCCESS_TOKENS.some(token => normalized.includes(token))) return 'success';
  if (PENDING_TOKENS.some(token => normalized.includes(token))) return 'pending';
  return 'unknown';
}

/** 按严重度聚合所有外部作业；缺失整段 external 时返回 `none`。 */
export function computeExternalOutcome(
  external: CodexAppProgressExternalJob[] | undefined,
): ExternalOutcome {
  if (external === undefined) return 'none';
  if (external.length === 0) return 'unknown';
  const categories = external.map(job => classifyExternalJobStatus(job.status));
  if (categories.includes('failed')) return 'failed';
  if (categories.includes('pending')) return 'pending';
  if (categories.includes('unknown')) return 'unknown';
  return 'success';
}

/**
 * 终态卡片/报告的一行结论文案。
 * 严格区分「AI 本轮执行结束」与「外部任务终态」：external 未终态或失败时，
 * 绝不输出笼统的「本轮已完成」。
 */
export function externalTerminalHeadline(outcome: ExternalOutcome): string {
  switch (outcome) {
    case 'success':
      return '本轮已完成，外部任务均已成功。';
    case 'failed':
      return 'AI 执行动作已结束，外部任务存在失败。';
    case 'pending':
      return 'AI 执行动作已结束，外部任务仍在进行。';
    case 'unknown':
      return 'AI 执行动作已结束，外部状态未确认。';
    case 'none':
    default:
      return 'AI 本轮执行已结束（未记录外部任务状态）。';
  }
}

/** 外部作业逐条明细，例如 `MR 8293313：running`；供卡片和报告并列展示。 */
export function externalJobLines(
  external: CodexAppProgressExternalJob[] | undefined,
): string[] {
  return (external ?? []).map(job => `${job.label}：${job.status}`);
}

/** 从 overview 直接算出外部整体结论的便捷入口。 */
export function overviewExternalOutcome(
  overview: CodexAppProgressOverview | undefined,
): ExternalOutcome {
  return computeExternalOutcome(overview?.external);
}
