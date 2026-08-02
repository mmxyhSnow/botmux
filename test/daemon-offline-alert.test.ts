/** Dashboard daemon 离线告警：覆盖启动宽限、聚合去重与恢复后重新布防。 */
import { describe, expect, it } from 'vitest';
import {
  daemonOfflineAlertMessage,
  evaluateDaemonOfflineAlerts,
  initialDaemonOfflineAlertState,
} from '../src/dashboard/daemon-offline-alert.js';

const bots = [
  { larkAppId: 'cli_a', botName: 'Youc' },
  { larkAppId: 'cli_b', botName: '张三金' },
];

describe('daemon offline alert', () => {
  it('启动宽限内不告警，宽限后把同一批离线聚合且只提醒一次', () => {
    let state = initialDaemonOfflineAlertState(1_000);
    let result = evaluateDaemonOfflineAlerts(state, bots, new Set(['cli_a']), 10_000, 90_000);
    expect(result.newlyOffline).toEqual([]);

    result = evaluateDaemonOfflineAlerts(result.state, bots, new Set(['cli_a']), 100_000, 90_000);
    expect(result.newlyOffline.map(item => item.larkAppId)).toEqual(['cli_b']);
    state = result.state;
    expect(evaluateDaemonOfflineAlerts(state, bots, new Set(['cli_a']), 110_000, 90_000).newlyOffline).toEqual([]);
  });

  it('恢复在线后解除去重，下一次离线可再次告警', () => {
    let result = evaluateDaemonOfflineAlerts(
      initialDaemonOfflineAlertState(0), bots, new Set(['cli_a']), 100_000, 0,
    );
    result = evaluateDaemonOfflineAlerts(result.state, bots, new Set(['cli_a', 'cli_b']), 110_000, 0);
    expect(result.state.notified.size).toBe(0);
    result = evaluateDaemonOfflineAlerts(result.state, bots, new Set(['cli_a']), 120_000, 0);
    expect(result.newlyOffline.map(item => item.larkAppId)).toEqual(['cli_b']);
  });

  it('消息隐藏 App ID 并为同一离线集合生成稳定 UUID', () => {
    const first = daemonOfflineAlertMessage(bots);
    const second = daemonOfflineAlertMessage([...bots].reverse());
    expect(first.text).toContain('Youc、张三金');
    expect(first.text).not.toContain('cli_a');
    expect(first.uuid).toBe(second.uuid);
  });
});
