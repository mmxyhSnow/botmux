/** 自定义发版阶段时间线：只记录状态进入时间，耗时在展示时按相邻节点计算。 */
import type {
  CustomReleaseEventStatus,
  CustomReleaseTimelineEntry,
} from '../services/custom-release-event.js';

const MAX_ENTRIES = 32;

export function appendReleaseTimeline(
  entries: readonly CustomReleaseTimelineEntry[] | undefined,
  status: CustomReleaseEventStatus,
  at: string,
): CustomReleaseTimelineEntry[] {
  const current = [...(entries ?? [])];
  if (current.at(-1)?.status === status) return current;
  current.push({ status, at });
  return current.slice(-MAX_ENTRIES);
}

export function releaseTimelineDurations(
  entries: readonly CustomReleaseTimelineEntry[] | undefined,
  endAt: string,
): Array<CustomReleaseTimelineEntry & { durationMs: number }> {
  const list = entries ?? [];
  return list.map((entry, index) => ({
    ...entry,
    durationMs: Math.max(0, Date.parse(list[index + 1]?.at ?? endAt) - Date.parse(entry.at)),
  }));
}
