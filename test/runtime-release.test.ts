/**
 * 版本化运行目录测试：锁定 deploy tag 身份、current 原子切换和回滚目标选择。
 */
import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activateRuntimeController,
  activateRuntimeRelease,
  listRuntimeReleases,
  planRuntimeReleaseCleanup,
  readCurrentRuntimeRelease,
  runtimeReleaseRoot,
  selectPreviousRuntimeRelease,
  writeRuntimeReleaseManifest,
} from '../src/core/runtime-release.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-runtime-release-'));
  roots.push(root);
  return root;
}

function createRelease(
  configRoot: string,
  version: string,
  commit: string,
): string {
  const releaseTag = `release/${version}`;
  const root = runtimeReleaseRoot(configRoot, releaseTag);
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
  writeFileSync(join(root, 'dist', 'index-daemon.js'), 'export {};\n');
  writeFileSync(join(root, 'dist', 'dashboard.js'), 'export {};\n');
  writeFileSync(join(root, 'dist', '.runtime-build-id'), `${commit.padEnd(64, '0').slice(0, 64)}\n`);
  writeRuntimeReleaseManifest(root, {
    schemaVersion: 1,
    releaseTag,
    deployTag: `deploy/${version}`,
    commit,
    runtimeBuildId: commit.padEnd(64, '0').slice(0, 64),
    createdAt: '2026-08-02T01:00:00.000Z',
  });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runtime release identity', () => {
  it('用 release tag 生成受限版本目录并拒绝任意路径', () => {
    const root = tempRoot();
    expect(runtimeReleaseRoot(root, 'release/v3.7.1-custom.11')).toBe(
      join(root, 'releases', 'v3.7.1-custom.11'),
    );
    expect(() => runtimeReleaseRoot(root, 'release/../../escape')).toThrow(/候选标签/);
  });

  it('原子切换 current，并保留可回读的前一个运行目录', () => {
    const configRoot = tempRoot();
    const oldRoot = createRelease(configRoot, 'v3.7.1-custom.10', '1'.repeat(40));
    const newRoot = createRelease(configRoot, 'v3.7.1-custom.11', '2'.repeat(40));
    const runtimeDir = join(configRoot, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    symlinkSync(oldRoot, join(runtimeDir, 'current'), 'dir');

    const result = activateRuntimeRelease(configRoot, newRoot);

    expect(result.previousRoot).toBe(oldRoot);
    expect(readlinkSync(join(runtimeDir, 'current'))).toBe(newRoot);
    expect(readCurrentRuntimeRelease(configRoot)?.manifest.deployTag).toBe(
      'deploy/v3.7.1-custom.11',
    );
  });

  it('只列出完整有效的版本目录，并按 deploy 版本选择上一个', () => {
    const configRoot = tempRoot();
    createRelease(configRoot, 'v3.7.1-custom.9', '1'.repeat(40));
    createRelease(configRoot, 'v3.7.1-custom.10', '2'.repeat(40));
    createRelease(configRoot, 'v3.7.1-custom.11', '3'.repeat(40));
    mkdirSync(join(configRoot, 'releases', 'broken'), { recursive: true });

    const releases = listRuntimeReleases(configRoot);
    const previous = selectPreviousRuntimeRelease(releases, 'deploy/v3.7.1-custom.11');

    expect(releases.map(item => item.manifest.deployTag)).toEqual([
      'deploy/v3.7.1-custom.11',
      'deploy/v3.7.1-custom.10',
      'deploy/v3.7.1-custom.9',
    ]);
    expect(previous?.manifest.deployTag).toBe('deploy/v3.7.1-custom.10');
  });

  it('清理计划保留最新三个，并额外保护 current/controller', () => {
    const configRoot = tempRoot();
    const v8 = createRelease(configRoot, 'v3.7.1-custom.8', '1'.repeat(40));
    createRelease(configRoot, 'v3.7.1-custom.9', '2'.repeat(40));
    createRelease(configRoot, 'v3.7.1-custom.10', '3'.repeat(40));
    createRelease(configRoot, 'v3.7.1-custom.11', '4'.repeat(40));
    const v12 = createRelease(configRoot, 'v3.7.1-custom.12', '5'.repeat(40));
    activateRuntimeRelease(configRoot, v12);
    activateRuntimeController(configRoot, v8);

    const plan = planRuntimeReleaseCleanup(configRoot, 3);

    expect(plan.retained.map(item => item.manifest.deployTag)).toEqual([
      'deploy/v3.7.1-custom.12',
      'deploy/v3.7.1-custom.11',
      'deploy/v3.7.1-custom.10',
      'deploy/v3.7.1-custom.8',
    ]);
    expect(plan.removable.map(item => item.manifest.deployTag)).toEqual([
      'deploy/v3.7.1-custom.9',
    ]);
  });
});
