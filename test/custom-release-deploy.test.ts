/** 候选版本一键部署测试：锁定 canonical checkout、构建顺序和重启后部署留痕。 */
import { describe, expect, it, vi } from 'vitest';
import type { CustomReleaseEventRecord } from '../src/services/custom-release-event.js';
import {
  finalizeCustomReleaseDeployment,
  runCustomReleaseDeployment,
  type CustomReleaseDeployDeps,
} from '../src/core/custom-release-deploy.js';

const candidateHead = '1'.repeat(40);
const productionHead = '2'.repeat(40);
const devRoot = '/workspace/botmux-custom-dev';
const prodRoot = '/workspace/botmux-custom-prod';
const releaseRoot = '/home/botmux/releases/v3.7.1-custom.3';
const rollbackRoot = '/home/botmux/releases/v3.7.1-custom.2';
const releaseTag = 'release/v3.7.1-custom.3';

function record(): CustomReleaseEventRecord {
  return {
    schemaVersion: 1,
    event: {
      schemaVersion: 1,
      eventId: 'a'.repeat(64),
      repository: 'mmxyhSnow/botmux',
      repoRoot: devRoot,
      createdAt: '2026-07-31T08:00:00.000Z',
      source: { ref: 'origin/fix/release-card', head: '3'.repeat(40), title: '发布后续操作' },
      integration: {
        branch: 'custom/dev',
        previousHead: productionHead,
        head: candidateHead,
        mergeCommit: candidateHead,
      },
      production: { branch: 'custom/prod', head: productionHead },
      release: {
        pendingVersion: '3.7.1-custom.3',
        baseRef: 'custom/prod',
        baseHead: productionHead,
      },
      current: { commits: 1, files: 1, insertions: 1, deletions: 0 },
      cumulative: [{ title: '发布后续操作', mergeCommit: candidateHead, sourceHead: '3'.repeat(40) }],
      totals: { commits: 1, files: 1, insertions: 1, deletions: 0 },
    },
    state: {
      status: 'deploying',
      attempts: 1,
      updatedAt: '2026-07-31T08:01:00.000Z',
      messageId: 'om_release',
      candidateTag: releaseTag,
    },
  };
}

function worktrees(): string {
  return [
    `worktree ${devRoot}`,
    'branch refs/heads/custom/dev',
    '',
    `worktree ${prodRoot}`,
    'branch refs/heads/custom/prod',
  ].join('\n');
}

function deps(overrides: Partial<CustomReleaseDeployDeps> = {}): CustomReleaseDeployDeps {
  return {
    run: async () => ({ code: 0, output: '' }),
    promote: async () => ({ productionHead: candidateHead }),
    exists: () => true,
    realpath: path => path,
    activePackageRoot: () => rollbackRoot,
    currentRuntimeRoot: () => releaseRoot,
    runtimeRelease: root => ({
      root,
      manifest: {
        schemaVersion: 1,
        releaseTag,
        deployTag: 'deploy/v3.7.1-custom.3',
        commit: candidateHead,
        runtimeBuildId: '4'.repeat(64),
        createdAt: '2026-08-02T01:00:00.000Z',
      },
    }),
    verifyActivation: async () => undefined,
    prepareRuntime: async () => ({
      releaseRoot,
      rollbackRoot,
      rollbackDeployTag: 'deploy/v3.7.1-custom.2',
    }),
    backupRuntime: async () => '/home/botmux/backups/runtime-v3.7.1-custom.2',
    activateRuntime: async () => undefined,
    activateController: () => undefined,
    cleanupRuntimes: async () => undefined,
    startRestart: () => undefined,
    ...overrides,
  };
}

describe('runCustomReleaseDeployment', () => {
  it('按钮回调先隔离构建，再推进源码，并在备份后原子切换运行目录', async () => {
    const calls: string[] = [];
    const run = vi.fn<CustomReleaseDeployDeps['run']>(async (command, args, cwd) => {
      calls.push(`${cwd}:${command} ${args.join(' ')}`);
      if (command === 'git' && args[0] === 'worktree') return { code: 0, output: worktrees() };
      if (command === 'git' && args[0] === 'rev-parse') return { code: 0, output: `${candidateHead}\n` };
      return { code: 0, output: '' };
    });
    const prepareRuntime = vi.fn(async () => {
      calls.push('prepare-runtime');
      return {
        releaseRoot,
        rollbackRoot,
        rollbackDeployTag: 'deploy/v3.7.1-custom.2',
      };
    });
    const promote = vi.fn(async () => {
      calls.push('promote');
      return { productionHead: candidateHead };
    });
    const backupRuntime = vi.fn(async () => {
      calls.push('backup-runtime');
      return '/home/botmux/backups/runtime-v3.7.1-custom.2';
    });
    const activateRuntime = vi.fn(async () => { calls.push('activate-runtime'); });
    const startRestart = vi.fn();

    await runCustomReleaseDeployment(record(), deps({
      run,
      prepareRuntime,
      promote,
      backupRuntime,
      activateRuntime,
      startRestart,
    }));

    expect(promote).toHaveBeenCalledOnce();
    expect(prepareRuntime).toHaveBeenCalledWith(prodRoot, releaseTag, candidateHead, rollbackRoot);
    expect(backupRuntime).toHaveBeenCalledWith(rollbackRoot, 'deploy/v3.7.1-custom.2');
    expect(activateRuntime).toHaveBeenCalledWith(releaseRoot);
    expect(calls).toEqual([
      `${devRoot}:git worktree list --porcelain`,
      `${prodRoot}:git status --porcelain`,
      'prepare-runtime',
      'promote',
      `${prodRoot}:git fetch origin --prune --tags`,
      `${prodRoot}:git merge --ff-only origin/custom/prod`,
      `${prodRoot}:git rev-parse HEAD`,
      'backup-runtime',
      'activate-runtime',
    ]);
    expect(startRestart).toHaveBeenCalledWith(releaseRoot, releaseTag, rollbackRoot);
  });

  it('隔离构建失败时不推进生产分支，也不触碰 current', async () => {
    const promote = vi.fn(async () => ({ productionHead: candidateHead }));
    const activateRuntime = vi.fn(async () => undefined);
    const run = vi.fn<CustomReleaseDeployDeps['run']>(async (_command, args) => (
      args[0] === 'worktree'
        ? { code: 0, output: worktrees() }
        : { code: 0, output: '' }
    ));

    await expect(runCustomReleaseDeployment(record(), deps({
      run,
      promote,
      activateRuntime,
      prepareRuntime: async () => { throw new Error('smoke failed'); },
    }))).rejects.toThrow(/smoke failed/);
    expect(promote).not.toHaveBeenCalled();
    expect(activateRuntime).not.toHaveBeenCalled();
  });

  it('生产 checkout 脏时在远端推进前停止', async () => {
    const promote = vi.fn(async () => ({ productionHead: candidateHead }));
    const run = vi.fn<CustomReleaseDeployDeps['run']>(async (_command, args) => (
      args[0] === 'worktree'
        ? { code: 0, output: worktrees() }
        : { code: 0, output: ' M src/daemon.ts\n' }
    ));

    await expect(runCustomReleaseDeployment(record(), deps({ run, promote }))).rejects.toThrow(/未提交改动/);
    expect(promote).not.toHaveBeenCalled();
  });
});

describe('finalizeCustomReleaseDeployment', () => {
  it('新 daemon 验证实际运行 checkout 与远端 HEAD 后记录同号 deploy 标签', async () => {
    const run = vi.fn<CustomReleaseDeployDeps['run']>(async (command, args) => {
      if (command === 'git' && args[0] === 'worktree') return { code: 0, output: worktrees() };
      if (command === 'git' && args[0] === 'rev-parse') return { code: 0, output: candidateHead };
      if (command === 'git' && args[0] === 'ls-remote') {
        return { code: 0, output: `${candidateHead}\trefs/heads/custom/prod\n` };
      }
      expect(args).toEqual(['release:record-deploy', '--', '--tag', releaseTag]);
      return {
        code: 0,
        output: `BOTMUX_CUSTOM_RELEASE_RESULT=${JSON.stringify({
          ok: true,
          action: 'record-deploy',
          releaseTag,
          deployTag: 'deploy/v3.7.1-custom.3',
          commit: candidateHead,
        })}\n`,
      };
    });

    const activateController = vi.fn();
    const cleanupRuntimes = vi.fn(async () => undefined);
    const verifyActivation = vi.fn(async () => undefined);
    await expect(finalizeCustomReleaseDeployment(record(), deps({
      run,
      activePackageRoot: () => releaseRoot,
      activateController,
      cleanupRuntimes,
      verifyActivation,
    }))).resolves.toEqual({
      productionHead: candidateHead,
      deployTag: 'deploy/v3.7.1-custom.3',
    });
    expect(verifyActivation).toHaveBeenCalledOnce();
    expect(activateController).toHaveBeenCalledWith(releaseRoot);
    expect(cleanupRuntimes).toHaveBeenCalledWith(releaseRoot);
  });

  it('实际执行路径不是生产 checkout 时不创建部署标签', async () => {
    const run = vi.fn<CustomReleaseDeployDeps['run']>(async () => ({ code: 0, output: worktrees() }));
    await expect(finalizeCustomReleaseDeployment(record(), deps({
      run,
      activePackageRoot: () => devRoot,
    }))).rejects.toThrow(/实际执行路径/);
    expect(run).toHaveBeenCalledOnce();
  });
});
