/** 运行 worktree 清理测试：dry-run 零写入，apply 也只删除计划内版本。 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupRuntimeReleaseWorktrees } from '../src/core/runtime-release-cleanup.js';
import { runtimeReleaseRoot, writeRuntimeReleaseManifest } from '../src/core/runtime-release.js';

const roots: string[] = [];

function release(configRoot: string, custom: number): string {
  const version = `v3.7.1-custom.${custom}`;
  const root = runtimeReleaseRoot(configRoot, `release/${version}`);
  const commit = String(custom % 10).repeat(40);
  const build = String(custom % 10).repeat(64);
  mkdirSync(join(root, 'dist'), { recursive: true });
  for (const entry of ['cli.js', 'index-daemon.js', 'dashboard.js']) {
    writeFileSync(join(root, 'dist', entry), 'ok');
  }
  writeFileSync(join(root, 'dist', '.runtime-build-id'), `${build}\n`);
  writeRuntimeReleaseManifest(root, {
    schemaVersion: 1,
    releaseTag: `release/${version}`,
    deployTag: `deploy/${version}`,
    commit,
    runtimeBuildId: build,
    createdAt: '2026-08-02T00:00:00.000Z',
  });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runtime release cleanup', () => {
  it('默认 dry-run 不调用 git，apply 逐项删除并 prune', async () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'botmux-cleanup-'));
    roots.push(configRoot);
    for (const custom of [8, 9, 10, 11]) release(configRoot, custom);
    const run = vi.fn(async () => ({ code: 0, output: '' }));

    const dryRun = await cleanupRuntimeReleaseWorktrees(
      configRoot,
      '/repo',
      { keep: 3 },
      { run },
    );
    expect(dryRun.planned).toEqual([join(configRoot, 'releases', 'v3.7.1-custom.8')]);
    expect(run).not.toHaveBeenCalled();

    const applied = await cleanupRuntimeReleaseWorktrees(
      configRoot,
      '/repo',
      { keep: 3, apply: true },
      { run },
    );
    expect(applied.removed).toEqual(dryRun.planned);
    expect(run).toHaveBeenNthCalledWith(1, 'git', ['worktree', 'remove', dryRun.planned[0]], '/repo');
    expect(run).toHaveBeenNthCalledWith(2, 'git', ['worktree', 'prune'], '/repo');
  });
});
