/** 官方源码同步部署留痕测试：锁定运行态校验顺序和失败时不写 deploy 标签。 */
import { describe, expect, it, vi } from 'vitest';
import {
  finalizeSourceUpdateDeployment,
  type SourceUpdateDeployDeps,
} from '../src/core/source-update-deploy.js';

const expectedHead = 'a'.repeat(40);
const releaseTag = 'release/v3.8.0-custom.1';
const runtimeRoot = '/runtime/releases/v3.8.0-custom.1';
const productionRoot = '/repo/custom-prod';

function worktrees(): string {
  return [
    `worktree ${productionRoot}`,
    'branch refs/heads/custom/prod',
    '',
    `worktree ${runtimeRoot}`,
    `HEAD ${expectedHead}`,
    'detached',
  ].join('\n');
}

function deps(run: SourceUpdateDeployDeps['run']): SourceUpdateDeployDeps {
  return {
    activePackageRoot: () => runtimeRoot,
    runtimeRelease: root => ({
      root,
      manifest: {
        schemaVersion: 1,
        releaseTag,
        deployTag: 'deploy/v3.8.0-custom.1',
        commit: expectedHead,
        runtimeBuildId: 'b'.repeat(64),
        createdAt: '2026-08-02T02:00:00.000Z',
      },
    }),
    verifyActivation: async () => undefined,
    activateController: () => undefined,
    run,
  };
}

describe('finalizeSourceUpdateDeployment', () => {
  it('运行、候选与远端 HEAD 一致后才复用 record-deploy', async () => {
    const calls: string[] = [];
    const activateController = vi.fn();
    const run = vi.fn<SourceUpdateDeployDeps['run']>(async (command, args, cwd) => {
      calls.push(`${cwd}:${command} ${args.join(' ')}`);
      if (command === 'git' && args[0] === 'worktree') return { code: 0, output: worktrees() };
      if (command === 'git' && args[0] === 'ls-remote') return { code: 0, output: `${expectedHead}\trefs/heads/custom/prod` };
      if (command === 'git') return { code: 0, output: expectedHead };
      return {
        code: 0,
        output: `BOTMUX_CUSTOM_RELEASE_RESULT=${JSON.stringify({
          ok: true,
          action: 'record-deploy',
          releaseTag,
          deployTag: 'deploy/v3.8.0-custom.1',
          commit: expectedHead,
        })}`,
      };
    });

    await expect(finalizeSourceUpdateDeployment(releaseTag, expectedHead, {
      ...deps(run),
      activateController,
    })).resolves.toEqual({
      productionHead: expectedHead,
      deployTag: 'deploy/v3.8.0-custom.1',
    });
    expect(calls.at(-1)).toBe(`${productionRoot}:pnpm release:record-deploy -- --tag ${releaseTag}`);
    expect(activateController).toHaveBeenCalledWith(runtimeRoot);
  });

  it('重启后的运行 HEAD 不符时不调用 record-deploy', async () => {
    const run = vi.fn<SourceUpdateDeployDeps['run']>(async (_command, args) => {
      if (args[0] === 'worktree') return { code: 0, output: worktrees() };
      return { code: 0, output: 'c'.repeat(40) };
    });

    await expect(finalizeSourceUpdateDeployment(releaseTag, expectedHead, deps(run)))
      .rejects.toThrow(/运行 HEAD/);
    expect(run.mock.calls.some(([command]) => command === 'pnpm')).toBe(false);
  });
});
