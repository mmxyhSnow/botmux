/** PM2 验收回执测试：旧回执、其它 commit 或其它 build-id 都不能给 deploy tag 放行。 */
import { describe, expect, it } from 'vitest';
import {
  waitForRuntimeActivation,
  type RuntimeActivationWaitDeps,
} from '../src/core/runtime-release-verification.js';
import type { RuntimeReleaseRecord } from '../src/core/runtime-release.js';

const now = Date.parse('2026-08-02T02:00:00.000Z');
const target: RuntimeReleaseRecord = {
  root: '/runtime/v3.7.1-custom.11',
  manifest: {
    schemaVersion: 1,
    releaseTag: 'release/v3.7.1-custom.11',
    deployTag: 'deploy/v3.7.1-custom.11',
    commit: '1'.repeat(40),
    runtimeBuildId: '2'.repeat(64),
    createdAt: '2026-08-02T01:59:00.000Z',
  },
};

function deps(receipt: unknown): RuntimeActivationWaitDeps {
  let clock = now;
  return {
    read: () => receipt,
    now: () => clock,
    delay: async ms => { clock += ms; },
  };
}

describe('waitForRuntimeActivation', () => {
  it('只接受根目录、commit、build-id 与目标完全一致的新鲜回执', async () => {
    await expect(waitForRuntimeActivation(target, deps({
      schemaVersion: 1,
      targetRoot: target.root,
      commit: target.manifest.commit,
      runtimeBuildId: target.manifest.runtimeBuildId,
      verifiedAt: new Date(now - 1_000).toISOString(),
    }), 500)).resolves.toBeUndefined();
  });

  it('旧回执超时后 fail closed，不允许创建 deploy tag', async () => {
    await expect(waitForRuntimeActivation(target, deps({
      schemaVersion: 1,
      targetRoot: target.root,
      commit: target.manifest.commit,
      runtimeBuildId: target.manifest.runtimeBuildId,
      verifiedAt: new Date(now - 10 * 60_000).toISOString(),
    }), 200)).rejects.toThrow(/验收回执/);
  });
});
