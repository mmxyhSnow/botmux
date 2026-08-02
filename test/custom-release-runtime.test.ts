/**
 * 版本化运行准备器测试：当前 deploy tag 和候选 tag 都必须形成完整、可回读的独立目录。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backupCustomReleaseRuntime,
  prepareCustomReleaseRuntime,
  type CustomReleaseRuntimeDeps,
} from '../src/core/custom-release-runtime.js';
import { readRuntimeRelease } from '../src/core/runtime-release.js';

const roots: string[] = [];
const oldCommit = '1'.repeat(40);
const newCommit = '2'.repeat(40);
const oldRelease = 'release/v3.7.1-custom.10';
const newRelease = 'release/v3.7.1-custom.11';

function buildRuntime(root: string, seed: string): void {
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  for (const file of ['cli.js', 'index-daemon.js', 'dashboard.js']) {
    writeFileSync(join(dist, file), 'export {};\n');
  }
  writeFileSync(join(dist, '.runtime-build-id'), `${seed.repeat(64)}\n`);
}

function fixture(): {
  configRoot: string;
  productionRoot: string;
  activeRoot: string;
  deps: CustomReleaseRuntimeDeps;
} {
  const configRoot = mkdtempSync(join(tmpdir(), 'botmux-runtime-prepare-'));
  roots.push(configRoot);
  const productionRoot = join(configRoot, 'production');
  const activeRoot = join(configRoot, 'legacy-live');
  mkdirSync(productionRoot, { recursive: true });
  buildRuntime(activeRoot, '9');
  const run = vi.fn<CustomReleaseRuntimeDeps['run']>(async (command, args, cwd) => {
    if (command === 'git' && args[0] === 'tag') {
      return { code: 0, output: 'deploy/v3.7.1-custom.10\n' };
    }
    if (command === 'git' && args[0] === 'worktree') {
      mkdirSync(args[3], { recursive: true });
      return { code: 0, output: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      if (args[1] === `${oldRelease}^{commit}`) return { code: 0, output: oldCommit };
      if (args[1] === `${newRelease}^{commit}`) return { code: 0, output: newCommit };
      if (args[1] === 'HEAD') {
        return { code: 0, output: cwd === activeRoot || basename(cwd).endsWith('.10') ? oldCommit : newCommit };
      }
    }
    if (command === 'pnpm' && args[0] === 'build') {
      buildRuntime(cwd, basename(cwd).endsWith('.10') ? 'a' : 'b');
    }
    return { code: 0, output: '' };
  });
  return {
    configRoot,
    productionRoot,
    activeRoot,
    deps: {
      configRoot: () => configRoot,
      exists: existsSync,
      run,
      now: () => new Date('2026-08-02T02:00:00.000Z'),
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('custom release runtime', () => {
  it('先准备当前 deploy 回滚点，再准备候选版本，两者身份均可回读', async () => {
    const { configRoot, productionRoot, activeRoot, deps } = fixture();
    const result = await prepareCustomReleaseRuntime(
      productionRoot,
      newRelease,
      newCommit,
      activeRoot,
      deps,
    );

    expect(result).toEqual({
      releaseRoot: join(configRoot, 'releases', 'v3.7.1-custom.11'),
      rollbackRoot: join(configRoot, 'releases', 'v3.7.1-custom.10'),
      rollbackDeployTag: 'deploy/v3.7.1-custom.10',
    });
    expect(readRuntimeRelease(result.rollbackRoot)?.manifest.commit).toBe(oldCommit);
    expect(readRuntimeRelease(result.releaseRoot)?.manifest.commit).toBe(newCommit);
  });

  it('在 current 切换前复制真实活跃 dist 并记录 deploy tag', async () => {
    const { configRoot, activeRoot, deps } = fixture();
    const backup = await backupCustomReleaseRuntime(
      activeRoot,
      'deploy/v3.7.1-custom.10',
      deps,
    );

    expect(backup.startsWith(join(configRoot, 'backups'))).toBe(true);
    expect(readFileSync(join(backup, 'dist', 'cli.js'), 'utf8')).toContain('export');
    expect(JSON.parse(readFileSync(join(backup, 'metadata.json'), 'utf8')).deployTag)
      .toBe('deploy/v3.7.1-custom.10');
  });
});
