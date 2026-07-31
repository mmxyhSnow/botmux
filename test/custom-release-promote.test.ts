/** 自定义候选版本推进执行器测试：锁定候选 Tag 与远程生产 HEAD。 */
import { describe, expect, it, vi } from 'vitest';
import type { CustomReleaseEventRecord } from '../src/services/custom-release-event.js';
import {
  runCustomReleasePromote,
  type CustomReleasePromoteDeps,
} from '../src/core/custom-release-promote.js';

const candidateHead = '1'.repeat(40);
const productionHead = '2'.repeat(40);

function record(): CustomReleaseEventRecord {
  return {
    schemaVersion: 1,
    event: {
      schemaVersion: 1,
      eventId: 'a'.repeat(64),
      repository: 'mmxyhSnow/botmux',
      repoRoot: '/workspace/botmux-custom-dev',
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
      status: 'frozen',
      attempts: 1,
      updatedAt: '2026-07-31T08:01:00.000Z',
      messageId: 'om_release',
      candidateTag: 'release/v3.7.1-custom.3',
    },
  };
}

function deps(run: CustomReleasePromoteDeps['run']): CustomReleasePromoteDeps {
  return { run, exists: () => true, realpath: path => path };
}

describe('runCustomReleasePromote', () => {
  it('只用卡片绑定候选 Tag 推进并回读远程生产 HEAD', async () => {
    let reads = 0;
    const run = vi.fn<CustomReleasePromoteDeps['run']>(async (command, args) => {
      if (command === 'git') {
        reads += 1;
        return { code: 0, output: `${reads === 1 ? productionHead : candidateHead}\trefs/heads/custom/prod\n` };
      }
      expect(args).toEqual([
        'release:promote', '--', '--tag', 'release/v3.7.1-custom.3',
      ]);
      return {
        code: 0,
        output: `BOTMUX_CUSTOM_RELEASE_RESULT=${JSON.stringify({
          ok: true,
          action: 'promote',
          releaseTag: 'release/v3.7.1-custom.3',
          commit: candidateHead,
        })}\n`,
      };
    });

    await expect(runCustomReleasePromote(record(), deps(run))).resolves.toEqual({
      productionHead: candidateHead,
    });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('远程生产已被其它候选推进时不执行写操作', async () => {
    const run = vi.fn<CustomReleasePromoteDeps['run']>(async () => ({
      code: 0,
      output: `${'4'.repeat(40)}\trefs/heads/custom/prod\n`,
    }));

    await expect(runCustomReleasePromote(record(), deps(run))).rejects.toThrow(/远端 custom\/prod/);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
