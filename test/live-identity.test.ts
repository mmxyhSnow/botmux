/** 统一 live 身份测试：版本、commit 与 build-id 必须来自同一份运行 manifest。 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeRuntimeReleaseManifest } from '../src/core/runtime-release.js';
import { resolveLiveIdentity } from '../src/utils/live-identity.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('live identity', () => {
  it('版本化运行目录只使用同一 manifest 的完整身份', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-live-id-'));
    roots.push(root);
    mkdirSync(join(root, 'dist'), { recursive: true });
    const commit = 'a'.repeat(40);
    const buildId = 'b'.repeat(64);
    for (const entry of ['cli.js', 'index-daemon.js', 'dashboard.js']) {
      writeFileSync(join(root, 'dist', entry), 'ok');
    }
    writeFileSync(join(root, 'dist', '.runtime-build-id'), `${buildId}\n`);
    writeRuntimeReleaseManifest(root, {
      schemaVersion: 1,
      releaseTag: 'release/v3.7.1-custom.11',
      deployTag: 'deploy/v3.7.1-custom.11',
      commit,
      runtimeBuildId: buildId,
      createdAt: '2026-08-02T00:00:00.000Z',
    });

    expect(resolveLiveIdentity({ root })).toEqual({
      version: '3.7.1-custom.11',
      commit,
      buildId,
      deployTag: 'deploy/v3.7.1-custom.11',
      display: '3.7.1-custom.11 | aaaaaaaa | build bbbbbbbbbbbb',
    });
  });

  it('非版本化安装保持可诊断降级，不伪造 commit 或 build-id', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-live-id-fallback-'));
    roots.push(root);
    expect(resolveLiveIdentity({
      root,
      fallbackVersion: () => '3.7.1',
      fallbackCommit: () => null,
      fallbackBuildId: () => null,
    }).display).toBe('3.7.1 | commit unknown | build unknown');
  });
});
