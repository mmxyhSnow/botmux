/**
 * 一键回滚编排测试：deploy tag 选版、原子 flip、重启验收和失败自动恢复。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  runRuntimeRollback,
  type RuntimeRollbackDeps,
} from '../src/cli/runtime-rollback.js';
import type { RuntimeReleaseRecord } from '../src/core/runtime-release.js';

function release(custom: number): RuntimeReleaseRecord {
  const version = `v3.7.1-custom.${custom}`;
  return {
    root: `/runtime/${version}`,
    manifest: {
      schemaVersion: 1,
      releaseTag: `release/${version}`,
      deployTag: `deploy/${version}`,
      commit: String(custom).repeat(40).slice(0, 40),
      runtimeBuildId: String(custom).repeat(64).slice(0, 64),
      createdAt: `2026-08-02T01:0${custom}:00.000Z`,
    },
  };
}

function deps(overrides: Partial<RuntimeRollbackDeps> = {}): RuntimeRollbackDeps {
  const releases = [release(11), release(10), release(9)];
  return {
    listReleases: () => releases,
    currentRelease: () => releases[0],
    assertRemoteTag: vi.fn(async () => undefined),
    activate: vi.fn(),
    writeIntent: vi.fn(),
    restart: vi.fn(async () => undefined),
    verify: vi.fn(async () => undefined),
    alignSkill: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('runRuntimeRollback', () => {
  it('--last 选择上一个 deploy tag，并在重启验收后对齐维护 Skill', async () => {
    const wiring = deps();

    const result = await runRuntimeRollback(['--last'], wiring);

    expect(result).toMatchObject({
      action: 'rollback',
      from: 'deploy/v3.7.1-custom.11',
      to: 'deploy/v3.7.1-custom.10',
    });
    expect(wiring.assertRemoteTag).toHaveBeenCalledWith(release(10));
    expect(wiring.writeIntent).toHaveBeenCalledWith(release(11), release(10));
    expect(wiring.activate).toHaveBeenCalledWith(release(10).root);
    expect(wiring.restart).toHaveBeenCalledWith(release(10).root);
    expect(wiring.verify).toHaveBeenCalledWith(release(10));
    expect(wiring.alignSkill).toHaveBeenCalledWith(release(10).root);
  });

  it('目标重启失败时原子切回原版本并再次启动，不能停在半回滚状态', async () => {
    const restart = vi.fn(async (root: string) => {
      if (root === release(10).root) throw new Error('restart failed');
    });
    const wiring = deps({ restart });

    await expect(runRuntimeRollback(['--last'], wiring)).rejects.toThrow(/已恢复原版本/);
    expect(wiring.activate).toHaveBeenNthCalledWith(1, release(10).root);
    expect(wiring.activate).toHaveBeenNthCalledWith(2, release(11).root);
    expect(restart).toHaveBeenNthCalledWith(1, release(10).root);
    expect(restart).toHaveBeenNthCalledWith(2, release(11).root);
    expect(wiring.verify).toHaveBeenCalledWith(release(11));
  });

  it('--list 只读返回保留版本，不执行切换或重启', async () => {
    const wiring = deps();
    const result = await runRuntimeRollback(['--list'], wiring);

    expect(result.action).toBe('list');
    expect(result.releases).toHaveLength(3);
    expect(wiring.activate).not.toHaveBeenCalled();
    expect(wiring.restart).not.toHaveBeenCalled();
  });
});
