/**
 * Codex App 进度状态的复制、旧数据恢复与摘要事件写入。
 * 摘要只比较已有结构化字段，不引入模型调用或外部请求。
 */
import type {
  CodexAppProgressCardSessionState,
  CodexAppProgressMilestone,
  CodexAppProgressOverview,
} from '../types.js';
import { countProgressCardEntries } from './codex-app-progress-pagination.js';

/** 深复制会被后续更新的数组，避免持久化快照与运行态共享引用。 */
export function cloneCodexAppProgressState(
  state: CodexAppProgressCardSessionState,
): CodexAppProgressCardSessionState {
  return {
    ...state,
    acceptedTurnIds: [...state.acceptedTurnIds],
    pendingTurns: state.pendingTurns.map(turn => ({ ...turn })),
    archivedPages: state.archivedPages?.map(page => ({ ...page })),
    summaryEntryIndexes: state.summaryEntryIndexes
      ? [...state.summaryEntryIndexes]
      : state.summaryEntryIndexes,
    summaryMilestones: state.summaryMilestones
      ? state.summaryMilestones.map(milestone => ({ ...milestone }))
      : state.summaryMilestones,
    overview: state.overview
      ? {
          ...state.overview,
          completed: [...state.overview.completed],
          evidence: state.overview.evidence ? [...state.overview.evidence] : undefined,
          delivery: state.overview.delivery ? [...state.overview.delivery] : undefined,
          risks: state.overview.risks ? [...state.overview.risks] : undefined,
          external: state.overview.external
            ? state.overview.external.map(job => ({ ...job }))
            : undefined,
        }
      : undefined,
  };
}

/** 恢复旧状态时把既有记录全部视为摘要，避免升级后静默隐藏历史。 */
export function restoreCodexAppProgressState(
  state: CodexAppProgressCardSessionState,
): CodexAppProgressCardSessionState {
  const restored = cloneCodexAppProgressState(state);
  restored.pageNumber ??= 1;
  restored.currentEntryCount ??= countProgressCardEntries(restored.content);
  restored.archivedPages ??= [];
  restored.summaryEntryIndexes ??= Array.from(
    { length: restored.currentEntryCount },
    (_, index) => index,
  );
  return restored;
}

function sameList(left: string[] | undefined, right: string[] | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

/** 外部作业按 label+status 逐项比较，任一新增、消失或状态翻转都算变化。 */
function sameExternal(
  left: CodexAppProgressOverview['external'],
  right: CodexAppProgressOverview['external'],
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((job, index) =>
    job.label === right[index]?.label && job.status === right[index]?.status);
}

/**
 * 判定结构化进展是否值得进入摘要：阶段、范围、完成项、阻塞、证据、交付、风险
 * 或外部作业状态发生变化时保留；仅 current/next 的过程推进仍留在“展示所有”中。
 */
export function isCodexAppProgressSummaryEvent(
  previous: CodexAppProgressOverview | undefined,
  next: CodexAppProgressOverview,
): boolean {
  if (!previous) return true;
  return previous.stage !== next.stage
    || previous.total !== next.total
    || previous.blocker !== next.blocker
    || !sameList(previous.completed, next.completed)
    || !sameList(previous.evidence, next.evidence)
    || !sameList(previous.delivery, next.delivery)
    || !sameList(previous.risks, next.risks)
    || !sameExternal(previous.external, next.external);
}

/** 写入完整记录；重点事件同时登记零基索引与语义里程碑。 */
export function appendCodexAppProgressEntry(
  state: CodexAppProgressCardSessionState,
  entry: string,
  summaryEvent: boolean,
  milestone?: CodexAppProgressMilestone,
): void {
  const entryCount = state.currentEntryCount ?? countProgressCardEntries(state.content);
  state.content = state.content ? `${state.content}\n\n${entry}` : entry;
  state.pageNumber = 1;
  state.currentEntryCount = entryCount + 1;
  state.summaryEntryIndexes ??= Array.from({ length: entryCount }, (_, index) => index);
  state.summaryMilestones ??= [];
  if (summaryEvent && !state.summaryEntryIndexes.includes(entryCount)) {
    state.summaryEntryIndexes.push(entryCount);
  }
  if (milestone) {
    const bound = { ...milestone, index: entryCount };
    const existing = state.summaryMilestones.findIndex(item => item.index === entryCount);
    if (existing >= 0) state.summaryMilestones[existing] = bound;
    else state.summaryMilestones.push(bound);
  }
}
