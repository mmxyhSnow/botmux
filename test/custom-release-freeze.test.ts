/** 自定义发版冻结执行器测试：锁定远端 HEAD、版本参数和失败时不误认旧卡。 */
import { describe, expect, it, vi } from 'vitest';
import type { CustomReleaseEventRecord } from '../src/services/custom-release-event.js';
import {
  runCustomReleaseFreeze,
  type CustomReleaseFreezeDeps,
} from '../src/core/custom-release-freeze.js';
import { StaleCustomReleaseHeadError } from '../src/core/custom-release-notifier-types.js';

const head = '1'.repeat(40);

function record(): CustomReleaseEventRecord {
  return {
    schemaVersion: 1,
    event: {
      schemaVersion: 1,
      eventId: 'a'.repeat(64),
      repository: 'mmxyhSnow/botmux',
      repoRoot: '/workspace/botmux-custom-dev',
      createdAt: '2026-07-31T08:00:00.000Z',
      source: { ref: 'origin/refactor/release-card', head: '2'.repeat(40), title: '发版私聊卡' },
      integration: {
        branch: 'custom/dev',
        previousHead: '3'.repeat(40),
        head,
        mergeCommit: head,
      },
      production: { branch: 'custom/prod', head: '3'.repeat(40) },
      release: {
        pendingVersion: '3.7.1-custom.3',
        baseRef: 'custom/prod',
        baseHead: '3'.repeat(40),
      },
      current: { commits: 2, files: 1, insertions: 1, deletions: 0 },
      cumulative: [{ title: '发版私聊卡', mergeCommit: head, sourceHead: '2'.repeat(40) }],
      totals: { commits: 2, files: 1, insertions: 1, deletions: 0 },
    },
    state: { status: 'delivered', attempts: 1, updatedAt: '2026-07-31T08:01:00.000Z' },
  };
}

function deps(run: CustomReleaseFreezeDeps['run']): CustomReleaseFreezeDeps {
  return { run, exists: () => true, realpath: path => path };
}

describe('runCustomReleaseFreeze', () => {
  it('把卡片绑定的 HEAD 和版本传给唯一冻结入口', async () => {
    const run = vi.fn<CustomReleaseFreezeDeps['run']>(async (command, args) => {
      if (command === 'git') return { code: 0, output: `${head}\trefs/heads/custom/dev\n` };
      expect(args).toEqual([
        'release:prepare', '--',
        '--expected-head', head,
        '--expected-version', '3.7.1-custom.3',
      ]);
      return {
        code: 0,
        output: `BOTMUX_CUSTOM_RELEASE_RESULT=${JSON.stringify({
          ok: true,
          action: 'prepare',
          integrationHead: head,
          candidateTag: 'release/v3.7.1-custom.3',
        })}\n`,
      };
    });

    await expect(runCustomReleaseFreeze(record(), deps(run))).resolves.toEqual({
      candidateTag: 'release/v3.7.1-custom.3',
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('首次回读发现新合入时不启动冻结命令', async () => {
    const run = vi.fn<CustomReleaseFreezeDeps['run']>(async () => ({
      code: 0,
      output: `${'4'.repeat(40)}\trefs/heads/custom/dev\n`,
    }));

    await expect(runCustomReleaseFreeze(record(), deps(run))).rejects.toBeInstanceOf(StaleCustomReleaseHeadError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('冻结门禁失败且远端已变化时把旧卡判为过期', async () => {
    let calls = 0;
    const run = vi.fn<CustomReleaseFreezeDeps['run']>(async (command) => {
      calls += 1;
      if (command !== 'git') return { code: 1, output: 'tests failed' };
      return {
        code: 0,
        output: `${calls === 1 ? head : '5'.repeat(40)}\trefs/heads/custom/dev\n`,
      };
    });

    await expect(runCustomReleaseFreeze(record(), deps(run))).rejects.toBeInstanceOf(StaleCustomReleaseHeadError);
    expect(run).toHaveBeenCalledTimes(3);
  });
});
