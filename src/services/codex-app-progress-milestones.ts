/**
 * 摘要里程碑的语义推导与 4–6 条选择。
 *
 * 设计要点：
 * - 里程碑标题只从结构化 overview 差异推导（阶段、完成项、交付、证据、阻塞、
 *   外部作业、终态），不从自由文本 commentary 猜测，也绝不用「过程记录 N」。
 * - 选择时用稳定语义 key 折叠重复阶段噪音，并强制保留关键交付、外部失败与终态，
 *   不做机械的「首条 + 末条」。
 */
import type {
  CodexAppProgressCardPhase,
  CodexAppProgressMilestone,
  CodexAppProgressMilestoneKind,
  CodexAppProgressOverview,
} from '../types.js';
import {
  computeExternalOutcome,
  externalJobLines,
  type ExternalOutcome,
} from './codex-app-progress-external.js';

const MAX_TITLE_CHARS = 60;
const DEFAULT_MIN = 4;
const DEFAULT_MAX = 6;

/** 把 Markdown 链接压成可读文本，避免摘要标题里出现整段 URL 语法。 */
function readableText(value: string): string {
  const linked = value.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1');
  const trimmed = linked.trim();
  return trimmed.length > MAX_TITLE_CHARS
    ? `${trimmed.slice(0, MAX_TITLE_CHARS - 1)}…`
    : trimmed;
}

function newItems(previous: string[] | undefined, next: string[] | undefined): string[] {
  if (!next) return [];
  const seen = new Set(previous ?? []);
  return next.filter(item => !seen.has(item));
}

function terminalTitle(
  phase: Exclude<CodexAppProgressCardPhase, 'running'>,
  outcome: ExternalOutcome,
): string {
  if (phase === 'interrupted') return '本轮已中断';
  if (phase === 'failed') return '本轮处理失败';
  switch (outcome) {
    case 'success':
      return '本轮完成，外部任务均成功';
    case 'failed':
      return '本轮结束，外部任务存在失败';
    case 'pending':
      return '本轮结束，外部任务仍在进行';
    case 'unknown':
      return '本轮结束，外部状态未确认';
    case 'none':
    default:
      return 'AI 本轮执行已结束（未记录外部状态）';
  }
}

/**
 * 从相邻两份 overview 的差异推导一条摘要里程碑。
 * 一条记录只产出一个最显著的里程碑，优先级：终态 > 外部失败 > 交付 > 阻塞 >
 * 完成项 > 证据 > 外部其它变化 > 阶段。
 */
export function deriveProgressMilestone(input: {
  previous: CodexAppProgressOverview | undefined;
  next: CodexAppProgressOverview;
  index: number;
}): CodexAppProgressMilestone {
  const { previous, next, index } = input;
  const make = (
    title: string,
    kind: CodexAppProgressMilestoneKind,
    critical = false,
  ): CodexAppProgressMilestone => ({ index, title: readableText(title), kind, critical });

  const prevOutcome = computeExternalOutcome(previous?.external);
  const nextOutcome = computeExternalOutcome(next.external);
  if (nextOutcome === 'failed' && prevOutcome !== 'failed') {
    return make(`外部任务失败：${externalJobLines(next.external).join('；')}`, 'external', true);
  }

  const addedDelivery = newItems(previous?.delivery, next.delivery);
  if (addedDelivery.length > 0) {
    return make(`交付 ${addedDelivery[addedDelivery.length - 1]}`, 'delivery', true);
  }

  if (next.blocker && next.blocker !== previous?.blocker) {
    return make(`阻塞：${next.blocker}`, 'blocker', true);
  }

  const addedCompleted = newItems(previous?.completed, next.completed);
  if (addedCompleted.length > 0) {
    return make(addedCompleted[addedCompleted.length - 1], 'progress');
  }

  const addedEvidence = newItems(previous?.evidence, next.evidence);
  if (addedEvidence.length > 0) {
    return make(`验证：${addedEvidence[addedEvidence.length - 1]}`, 'evidence');
  }

  if (nextOutcome !== prevOutcome && next.external?.length) {
    return make(`外部状态：${externalJobLines(next.external).join('；')}`, 'external');
  }

  if (next.stage !== previous?.stage) {
    return make(`阶段：${next.stage}`, 'stage');
  }

  return make(next.stage ? `阶段：${next.stage}` : next.current, 'stage');
}

/** 生成终态里程碑，标题按外部整体结论区分而不是笼统「本轮已完成」。 */
export function deriveTerminalMilestone(input: {
  overview: CodexAppProgressOverview | undefined;
  phase: Exclude<CodexAppProgressCardPhase, 'running'>;
  index: number;
}): CodexAppProgressMilestone {
  const outcome = computeExternalOutcome(input.overview?.external);
  return {
    index: input.index,
    title: terminalTitle(input.phase, outcome),
    kind: 'terminal',
    critical: true,
  };
}

/** 稳定语义 key：相同阶段/相同语义标题折叠为一条，抹平重复的阶段噪音。 */
function milestoneKey(milestone: CodexAppProgressMilestone): string {
  return `${milestone.kind}:${milestone.title}`;
}

/**
 * 从全部候选里程碑中选出 4–6 条：
 * 1. 用语义 key 折叠重复（后出现的同 key 覆盖前者，保留其时间位置）。
 * 2. 关键里程碑（交付、外部失败、阻塞、终态）一律保留。
 * 3. 名额不足时用最早的上下文节点 + 最近的普通节点补足，避免机械首末。
 */
export function selectSummaryMilestones(
  milestones: CodexAppProgressMilestone[],
  options: { min?: number; max?: number } = {},
): CodexAppProgressMilestone[] {
  const min = options.min ?? DEFAULT_MIN;
  const max = options.max ?? DEFAULT_MAX;

  const deduped = new Map<string, CodexAppProgressMilestone>();
  for (const milestone of milestones) deduped.set(milestoneKey(milestone), milestone);
  const ordered = [...deduped.values()].sort((a, b) => a.index - b.index);
  if (ordered.length <= max) return ordered;

  const chosen = new Map<number, CodexAppProgressMilestone>();
  for (const milestone of ordered) {
    if (milestone.critical) chosen.set(milestone.index, milestone);
  }

  const nonCritical = ordered.filter(milestone => !milestone.critical);
  // 先放最早的一条普通节点作为任务起点上下文（若它本身不是关键节点）。
  if (chosen.size < max && nonCritical.length > 0) {
    const first = nonCritical[0];
    chosen.set(first.index, first);
  }
  // 其余名额用最近的普通节点补足，保证跨度而非只取首尾。
  for (let i = nonCritical.length - 1; i >= 0 && chosen.size < max; i--) {
    chosen.set(nonCritical[i].index, nonCritical[i]);
  }

  let result = [...chosen.values()].sort((a, b) => a.index - b.index);
  // 关键节点过多导致超额时，保留最近的 max 条（终态天然在最后）。
  if (result.length > max) result = result.slice(result.length - max);
  // 仍不足下限时，用剩余普通节点从近到远补齐。
  if (result.length < min) {
    const present = new Set(result.map(item => item.index));
    for (let i = ordered.length - 1; i >= 0 && result.length < min; i--) {
      if (!present.has(ordered[i].index)) {
        result.push(ordered[i]);
        present.add(ordered[i].index);
      }
    }
    result = result.sort((a, b) => a.index - b.index);
  }
  return result;
}
