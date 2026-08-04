import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  customReleaseEventId,
  customReleaseChangeKind,
  executeCustomReleaseJoin,
  inheritReleaseJoinTransportConfig,
  joinCustomRelease,
  queueCustomReleaseEvent,
  selectCustomReleaseBase,
  summarizeNumstat,
} from '../scripts/lib/custom-release-join.mjs';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function releaseRepo() {
  const root = mkdtempSync(join(tmpdir(), 'botmux-release-join-git-'));
  tempDirs.push(root);
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  git(root, 'init', '--bare', origin);
  git(root, 'init', repo);
  git(repo, 'config', 'user.name', 'Release Test');
  git(repo, 'config', 'user.email', 'release-test@example.com');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', 'base.txt');
  git(repo, 'commit', '-m', 'chore: baseline');
  git(repo, 'branch', 'custom/prod');
  git(repo, 'branch', 'custom/dev');
  git(repo, 'checkout', '-b', 'refactor/release-card');
  writeFileSync(join(repo, 'feature.txt'), 'release card\n');
  git(repo, 'add', 'feature.txt');
  git(repo, 'commit', '-m', 'refactor(release): 增加私聊汇总卡');
  const sourceHead = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', 'custom/dev');
  const productionHead = git(repo, 'rev-parse', 'custom/prod');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', 'origin', 'custom/prod', 'custom/dev', 'refactor/release-card');
  git(repo, 'fetch', 'origin');
  return { root, origin, repo, dataDir, sourceHead, productionHead };
}

/** 发布合入纯函数测试：固定版本窗口、diff 汇总与通知幂等键。 */
describe('custom release join helpers', () => {
  it('优先选择 custom/dev 第一父链上最近的冻结边界', () => {
    expect(selectCustomReleaseBase({
      firstParentCommits: ['head', 'release-3', 'prod', 'old'],
      productionHead: 'prod',
      taggedHeads: [
        { ref: 'release/v3.7.1-custom.3', head: 'release-3' },
        { ref: 'deploy/v3.7.1-custom.2', head: 'prod' },
      ],
    })).toEqual({ ref: 'release/v3.7.1-custom.3', head: 'release-3' });
  });

  it('没有更新候选标签时回退到生产 HEAD', () => {
    expect(selectCustomReleaseBase({
      firstParentCommits: ['head', 'prod', 'old'],
      productionHead: 'prod',
      taggedHeads: [{ ref: 'release/v3.6.0-custom.1', head: 'old' }],
    })).toEqual({ ref: 'custom/prod', head: 'prod' });
  });

  it('汇总文本和二进制文件的 numstat', () => {
    expect(summarizeNumstat('10\t2\tsrc/a.ts\n-\t-\timage.png\n3\t0\tREADME.md\n')).toEqual({
      files: 3,
      insertions: 13,
      deletions: 2,
    });
  });

  it('按源分支与 Conventional Commit 归一化累计改动类型', () => {
    expect(customReleaseChangeKind({ sourceRef: 'origin/feat/card-tag' })).toBe('feat');
    expect(customReleaseChangeKind({ sourceRef: 'origin/bugfix/card-tag' })).toBe('bugfix');
    expect(customReleaseChangeKind({ sourceSubject: 'refactor(card): 调整标签' })).toBe('opt');
    expect(customReleaseChangeKind({ title: '无法判断的中文标题' })).toBeUndefined();
  });

  it('同仓库同 integration HEAD 生成稳定幂等键', () => {
    const first = customReleaseEventId('mmxyhSnow/botmux', 'a'.repeat(40));
    expect(first).toBe(customReleaseEventId('mmxyhSnow/botmux', 'a'.repeat(40)));
    expect(first).not.toBe(customReleaseEventId('mmxyhSnow/botmux', 'b'.repeat(40)));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('一次性 clone 继承规范 checkout 的 SSH 传输配置', () => {
    const fixture = releaseRepo();
    const staging = join(fixture.root, 'staging');
    git(fixture.root, 'init', staging);
    git(fixture.repo, 'config', 'core.sshCommand', 'ssh -i /safe/release-key -o IdentitiesOnly=yes');

    inheritReleaseJoinTransportConfig(fixture.repo, staging);

    expect(git(staging, 'config', '--get', 'core.sshCommand'))
      .toBe('ssh -i /safe/release-key -o IdentitiesOnly=yes');
  });

  it('在临时 clone 中正常合入、回读远端并生成可消费事件', () => {
    const fixture = releaseRepo();
    const joined = joinCustomRelease({
      repoRoot: fixture.repo,
      remote: 'origin',
      sourceRef: 'origin/refactor/release-card',
      expectedHead: fixture.sourceHead,
      title: '增加待发版私聊汇总卡',
    });
    expect(git(fixture.repo, 'rev-parse', 'HEAD')).toBe(joined.integrationHead);
    expect(git(fixture.repo, 'ls-remote', 'origin', 'refs/heads/custom/dev').split(/\s+/)[0])
      .toBe(joined.integrationHead);

    const queued = queueCustomReleaseEvent({
      repoRoot: fixture.repo,
      repository: 'mmxyhSnow/botmux',
      productionHead: fixture.productionHead,
      pendingVersion: '3.7.1-custom.3',
      joined,
      dataDir: fixture.dataDir,
    });
    const record = JSON.parse(readFileSync(join(
      fixture.dataDir,
      'custom-release-notifications',
      'events',
      `${queued.eventId}.json`,
    ), 'utf8'));
    expect(record.state.status).toBe('queued');
    expect(record.event.source).toMatchObject({
      ref: 'origin/refactor/release-card',
      head: fixture.sourceHead,
      title: '增加待发版私聊汇总卡',
    });
    expect(record.event.current).toMatchObject({ commits: 2, files: 1, insertions: 1, deletions: 0 });
    expect(record.event.cumulative).toEqual([
      expect.objectContaining({ sourceHead: fixture.sourceHead, kind: 'opt' }),
    ]);

    record.event.createdAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(join(
      fixture.dataDir,
      'custom-release-notifications',
      'events',
      `${queued.eventId}.json`,
    ), `${JSON.stringify(record, null, 2)}\n`);
    expect(queueCustomReleaseEvent({
      repoRoot: fixture.repo,
      repository: 'mmxyhSnow/botmux',
      productionHead: fixture.productionHead,
      pendingVersion: '3.7.1-custom.3',
      joined,
      dataDir: fixture.dataDir,
    })).toEqual({ eventId: queued.eventId, status: 'queued' });
  });

  it('开发分支远端 HEAD 不匹配时不推进 custom/dev', () => {
    const fixture = releaseRepo();
    const before = git(fixture.repo, 'ls-remote', 'origin', 'refs/heads/custom/dev').split(/\s+/)[0];
    expect(() => joinCustomRelease({
      repoRoot: fixture.repo,
      remote: 'origin',
      sourceRef: 'refactor/release-card',
      expectedHead: 'f'.repeat(40),
      title: '不应合入',
    })).toThrow(/HEAD 已变化/);
    expect(git(fixture.repo, 'ls-remote', 'origin', 'refs/heads/custom/dev').split(/\s+/)[0]).toBe(before);
  });

  it('custom/prod 偏离 custom/dev 时在任何 push 前拒绝合入', () => {
    const integrationHead = '1'.repeat(40);
    expect(() => executeCustomReleaseJoin({
      repoRoot: '/unused',
      config: { originRemote: 'origin' },
      args: [
        '--source', 'origin/refactor/release-card',
        '--expected-head', '2'.repeat(40),
        '--title', '不应执行',
      ],
      assertClean: () => undefined,
      fetchState: () => undefined,
      releaseState: () => ({ integrationHead, productionIsAncestor: false }),
      localHead: () => integrationHead,
    })).toThrow(/必须先修复发布分支关系，未执行合入/);
  });
});
