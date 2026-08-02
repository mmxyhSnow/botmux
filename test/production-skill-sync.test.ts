/** 生产维护 Skill 对齐测试：覆盖正常同版、旧 commit 修复与异源拒绝。 */
import { describe, expect, it, vi } from 'vitest';
import {
  productionSkillSyncNotice,
  reconcileProductionMaintenanceSkill,
  type ProductionSkillSyncDeps,
} from '../src/core/production-skill-sync.js';
import type { SkillPackage } from '../src/core/skills/types.js';

const oldCommit = '1'.repeat(40);
const runtimeCommit = '2'.repeat(40);

function skill(ref = 'custom/prod', commit = runtimeCommit): SkillPackage {
  return {
    id: 'maintain-botmux-fork',
    name: 'maintain-botmux-fork',
    tags: [],
    rootDir: '/skills/maintain-botmux-fork',
    entrypoint: '/skills/maintain-botmux-fork/SKILL.md',
    source: {
      type: 'github',
      owner: 'mmxyhSnow',
      repo: 'botmux',
      path: 'skills/maintain-botmux-fork',
      ref,
      commit,
    },
  };
}

function deps(current: SkillPackage, installed = skill()): ProductionSkillSyncDeps {
  return {
    activePackageRoot: () => '/runtime',
    runtimeRelease: () => null,
    readRegistry: () => ({ skills: { 'maintain-botmux-fork': current } }),
    runGit: async (_root, args) => {
      if (args[0] === 'symbolic-ref') return 'custom/prod';
      if (args[0] === 'remote') return 'git@github.com:mmxyhSnow/botmux.git';
      return runtimeCommit;
    },
    install: vi.fn(async () => installed),
  };
}

describe('reconcileProductionMaintenanceSkill', () => {
  it('同版且跟踪 custom/prod 时不重复安装', async () => {
    const wiring = deps(skill());
    await expect(reconcileProductionMaintenanceSkill(wiring)).resolves.toMatchObject({ status: 'aligned' });
    expect(wiring.install).not.toHaveBeenCalled();
  });

  it('把固定在旧 commit 的 Skill 修复到运行 HEAD，并保留分支跟踪 ref', async () => {
    const wiring = deps(skill(oldCommit, oldCommit));
    const result = await reconcileProductionMaintenanceSkill(wiring);

    expect(result).toMatchObject({
      status: 'repaired',
      previousCommit: oldCommit,
      installedCommit: runtimeCommit,
    });
    expect(wiring.install).toHaveBeenCalledWith(expect.objectContaining({
      ref: runtimeCommit,
      sourceOverride: expect.objectContaining({ ref: 'custom/prod' }),
    }));
    expect(productionSkillSyncNotice(result)).toContain('已自动对齐生产版本');
  });

  it('detached 版本化运行目录按 manifest commit 对齐 Skill', async () => {
    const wiring = deps(skill(oldCommit, oldCommit));
    wiring.runtimeRelease = root => ({
      root,
      manifest: {
        schemaVersion: 1,
        releaseTag: 'release/v3.7.1-custom.11',
        deployTag: 'deploy/v3.7.1-custom.11',
        commit: runtimeCommit,
        runtimeBuildId: '3'.repeat(64),
        createdAt: '2026-08-02T01:00:00.000Z',
      },
    });
    wiring.runGit = async (_root, args) => {
      if (args[0] === 'symbolic-ref') throw new Error('detached');
      if (args[0] === 'remote') return 'git@github.com:mmxyhSnow/botmux.git';
      return runtimeCommit;
    };

    await expect(reconcileProductionMaintenanceSkill(wiring)).resolves.toMatchObject({
      status: 'repaired',
      installedCommit: runtimeCommit,
    });
  });

  it('拒绝覆盖同名异源 Skill，并生成告警', async () => {
    const current = skill();
    current.source = { type: 'local-link', path: '/another/skill' };
    const wiring = deps(current);
    const result = await reconcileProductionMaintenanceSkill(wiring);

    expect(result).toEqual({ status: 'failed', reason: 'source_mismatch' });
    expect(wiring.install).not.toHaveBeenCalled();
    expect(productionSkillSyncNotice(result)).toContain('对齐失败');
  });
});
