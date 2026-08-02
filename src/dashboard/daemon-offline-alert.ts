/**
 * Dashboard 侧 daemon 离线告警判定。
 * Registry 已用 90 秒心跳窗口过滤瞬时重启，本模块只对新的离线集合发一次聚合提醒。
 */
import { createHash } from 'node:crypto';

export interface DaemonAlertBot {
  larkAppId: string;
  botName: string;
}

export interface DaemonOfflineAlertState {
  startedAt: number;
  notified: Set<string>;
}

export interface DaemonOfflineAlertResult {
  state: DaemonOfflineAlertState;
  newlyOffline: DaemonAlertBot[];
}

/** Dashboard 刚启动时留出 daemon 注册窗口，避免启动顺序制造假告警。 */
export function initialDaemonOfflineAlertState(startedAt: number): DaemonOfflineAlertState {
  return { startedAt, notified: new Set<string>() };
}

/**
 * 比较配置名册与在线描述符；恢复在线会自动解除去重，下一次真实离线仍能重新告警。
 */
export function evaluateDaemonOfflineAlerts(
  previous: DaemonOfflineAlertState,
  configured: readonly DaemonAlertBot[],
  onlineAppIds: ReadonlySet<string>,
  now: number,
  startupGraceMs = 90_000,
): DaemonOfflineAlertResult {
  const notified = new Set([...previous.notified].filter(appId => !onlineAppIds.has(appId)));
  if (now - previous.startedAt < startupGraceMs) {
    return { state: { ...previous, notified }, newlyOffline: [] };
  }
  const newlyOffline = configured.filter(bot => (
    !onlineAppIds.has(bot.larkAppId) && !notified.has(bot.larkAppId)
  ));
  for (const bot of newlyOffline) notified.add(bot.larkAppId);
  return { state: { ...previous, notified }, newlyOffline };
}

/** 一轮离线只发一条聚合消息；UUID 按离线集合稳定，重启重试也不会重复投递。 */
export function daemonOfflineAlertMessage(bots: readonly DaemonAlertBot[]): {
  text: string;
  uuid: string;
} {
  const sorted = [...bots].sort((a, b) => a.larkAppId.localeCompare(b.larkAppId));
  const names = sorted.map(bot => bot.botName || bot.larkAppId).join('、');
  const digest = createHash('sha256').update(sorted.map(bot => bot.larkAppId).join('\0')).digest('hex').slice(0, 20);
  return {
    text: `⚠️ Botmux daemon 离线告警\n已超过心跳容忍窗口：${names}\n请检查 PM2 status、OOM/系统日志和 daemon 日志。恢复在线后本告警会自动重新布防。`,
    uuid: `botmux_daemon_offline_${digest}`,
  };
}
