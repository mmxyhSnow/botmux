/**
 * 官方同步分段门禁契约：verify 失败不得改变保护分支或 runtime/current。
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSourceUpdatePromotable,
  verifyPreparedSourceUpdate,
} from '../scripts/lib/source-update-phases.mjs';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'botmux-source-update-'));
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Botmux Test']);
  git(root, ['config', 'user.email', 'botmux-test@example.com']);
  writeFileSync(join(root, 'README.md'), 'baseline\n', 'utf8');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'baseline']);
  git(root, ['branch', 'custom/dev']);
  git(root, ['branch', 'custom/prod']);
  const runtimeA = join(root, 'runtime-a');
  const runtimeB = join(root, 'runtime-b');
  const current = join(root, 'current');
  mkdirSync(runtimeA);
  mkdirSync(runtimeB);
  symlinkSync(runtimeA, current);
  const snapshot = () => ({
    rootHead: git(root, ['rev-parse', 'HEAD']),
    integrationHead: git(root, ['rev-parse', 'refs/heads/custom/dev']),
    productionHead: git(root, ['rev-parse', 'refs/heads/custom/prod']),
    runtimeRoot: realpathSync(current),
    runtimeHead: git(root, ['rev-parse', 'HEAD']),
  });
  return { root, current, runtimeB, snapshot };
}

function preparedState(snapshot: ReturnType<ReturnType<typeof fixture>['snapshot']>) {
  return {
    schemaVersion: 1,
    status: 'prepared',
    candidateHead: snapshot.rootHead,
    snapshot,
  };
}

describe('source update phase gates', () => {
  it('verify 门禁失败后两个保护分支和 runtime/current 全部不变', async () => {
    const env = fixture();
    const before = env.snapshot();
    const state = preparedState(before);
    const operations = {
      snapshot: async () => env.snapshot(),
      candidate: async () => ({ head: before.rootHead, clean: true }),
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      runGates: async () => { throw new Error('模拟契约测试失败'); },
    };

    await expect(verifyPreparedSourceUpdate(state, operations)).rejects.toThrow('模拟契约测试失败');
    expect(env.snapshot()).toEqual(before);
    expect(realpathSync(env.current)).not.toBe(env.runtimeB);
    expect(state.status).toBe('prepared');
    await expect(assertSourceUpdatePromotable(state, operations)).rejects.toThrow('不能执行 promote');
  });

  it('只有 verify 成功且快照未漂移的候选可以 promote', async () => {
    const env = fixture();
    const before = env.snapshot();
    const operations = {
      snapshot: async () => env.snapshot(),
      candidate: async () => ({ head: before.rootHead, clean: true }),
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      runGates: async () => undefined,
    };
    const verified = await verifyPreparedSourceUpdate(preparedState(before), operations);
    expect(verified.status).toBe('verified');
    await expect(assertSourceUpdatePromotable(verified, operations)).resolves.toBeUndefined();
    git(env.root, ['commit', '--allow-empty', '-m', 'drift']);
    await expect(assertSourceUpdatePromotable(verified, operations)).rejects.toThrow('rootHead');
  });
});
