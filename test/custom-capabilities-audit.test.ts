/**
 * 自定义能力清单审计契约：保证关键能力可追溯到真实接入点和测试。
 */
import { describe, expect, it } from 'vitest';
import {
  auditCustomCapabilities,
  auditCustomCapabilityManifest,
} from '../scripts/lib/custom-capabilities.mjs';

describe('custom capability audit', () => {
  it('当前清单的接入点、测试和 P0 字段全部有效', () => {
    const result = auditCustomCapabilities(process.cwd());
    expect(result.violations).toEqual([]);
    expect(result.manifest.capabilities.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([
      'progress-card',
      'request-user-input',
      'durable-turn-recovery',
      'custom-release-lifecycle',
      'official-source-update-gates',
    ]));
    expect(result.manifest.capabilities.flatMap((item: { controls?: Array<{ key: string }> }) =>
      item.controls?.map(control => control.key) ?? [])).toEqual([
      'codexAppImmediateProgressCard',
      'askReminderPolicy',
      'topicStatusDisplay',
    ]);
  });

  it('接入符号漂移时阻断升级验收', () => {
    const manifest = structuredClone(auditCustomCapabilities(process.cwd()).manifest);
    manifest.capabilities[0].entrypoints[0].symbols.push('missingUpgradeContractSymbol');
    const result = auditCustomCapabilityManifest(process.cwd(), manifest);
    expect(result.violations).toContain(
      'capability(progress-card) 缺少接入符号 src/core/worker-pool.ts#missingUpgradeContractSymbol',
    );
  });
});
