/**
 * 生产维护 Skill 对齐器：源码部署启动后，把维护手册锁定到当前真实运行的
 * custom/prod commit，同时保留 custom/prod 作为后续 update 的跟踪 ref。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { botmuxInstallRoot } from '../utils/install-info.js';
import { githubRepoFromRemote } from '../utils/source-update.js';
import {
  installGitSkillAsync,
  readSkillRegistry,
} from '../services/skill-registry-store.js';
import type { SkillPackage, SkillSource } from './skills/types.js';

const execFileAsync = promisify(execFile);
const SKILL_NAME = 'maintain-botmux-fork';
const REPOSITORY = 'mmxyhSnow/botmux';
const SKILL_PATH = 'skills/maintain-botmux-fork';
const PRODUCTION_REF = 'custom/prod';
const GIT_URL = `https://github.com/${REPOSITORY}.git`;

export type ProductionSkillSyncStatus = 'skipped' | 'aligned' | 'repaired' | 'failed';

export interface ProductionSkillSyncResult {
  status: ProductionSkillSyncStatus;
  runtimeCommit?: string;
  previousCommit?: string;
  installedCommit?: string;
  reason?: string;
}

export interface ProductionSkillSyncDeps {
  activePackageRoot: () => string;
  readRegistry: () => { skills: Record<string, SkillPackage> };
  runGit: (root: string, args: string[]) => Promise<string>;
  install: (opts: {
    url: string;
    path: string;
    ref: string;
    sourceOverride: SkillSource;
  }) => Promise<SkillPackage>;
}

async function runGit(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return String(result.stdout ?? '').trim();
}

const PRODUCTION_DEPS: ProductionSkillSyncDeps = {
  activePackageRoot: botmuxInstallRoot,
  readRegistry: readSkillRegistry,
  runGit,
  install: installGitSkillAsync,
};

/** 只认可 fork 自身的维护 Skill，遇到同名异源包时拒绝自动覆盖。 */
function isTrustedSource(source: SkillSource): boolean {
  if (source.type === 'github') {
    return `${source.owner}/${source.repo}`.toLowerCase() === REPOSITORY.toLowerCase()
      && source.path === SKILL_PATH;
  }
  if (source.type === 'git') {
    return githubRepoFromRemote(source.url)?.toLowerCase() === REPOSITORY.toLowerCase()
      && source.path === SKILL_PATH;
  }
  return false;
}

/**
 * 对齐已安装维护 Skill。只有当前运行 checkout 经分支和 origin 身份双重证明为
 * custom/prod 时才写 registry；缺少 Skill 时保持不安装，尊重机器原有策略。
 */
export async function reconcileProductionMaintenanceSkill(
  deps: ProductionSkillSyncDeps = PRODUCTION_DEPS,
): Promise<ProductionSkillSyncResult> {
  const current = deps.readRegistry().skills[SKILL_NAME];
  if (!current) return { status: 'skipped', reason: 'not_installed' };
  if (!isTrustedSource(current.source)) return { status: 'failed', reason: 'source_mismatch' };

  try {
    const root = deps.activePackageRoot();
    const [branch, originUrl, runtimeCommit] = await Promise.all([
      deps.runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      deps.runGit(root, ['remote', 'get-url', 'origin']),
      deps.runGit(root, ['rev-parse', 'HEAD']),
    ]);
    if (branch !== PRODUCTION_REF) return { status: 'skipped', reason: 'not_production_branch' };
    if (githubRepoFromRemote(originUrl)?.toLowerCase() !== REPOSITORY.toLowerCase()) {
      return { status: 'failed', runtimeCommit, reason: 'runtime_origin_mismatch' };
    }

    const previousCommit = current.source.type === 'github' || current.source.type === 'git'
      ? current.source.commit
      : undefined;
    const requestedRef = current.source.type === 'github' || current.source.type === 'git'
      ? current.source.ref
      : undefined;
    if (requestedRef === PRODUCTION_REF && previousCommit === runtimeCommit) {
      return { status: 'aligned', runtimeCommit, previousCommit, installedCommit: previousCommit };
    }

    // checkout 使用当前运行 commit，避免远端分支先推进时把未来手册提前装进旧 daemon；
    // registry 则保留 custom/prod，确保常规 skills update 继续跟随生产线。
    const installed = await deps.install({
      url: GIT_URL,
      path: SKILL_PATH,
      ref: runtimeCommit,
      sourceOverride: {
        type: 'github',
        owner: 'mmxyhSnow',
        repo: 'botmux',
        path: SKILL_PATH,
        ref: PRODUCTION_REF,
      },
    });
    const installedCommit = installed.source.type === 'github' || installed.source.type === 'git'
      ? installed.source.commit
      : undefined;
    const installedRef = installed.source.type === 'github' || installed.source.type === 'git'
      ? installed.source.ref
      : undefined;
    if (installedCommit !== runtimeCommit || installedRef !== PRODUCTION_REF) {
      return { status: 'failed', runtimeCommit, previousCommit, installedCommit, reason: 'repair_mismatch' };
    }
    return { status: 'repaired', runtimeCommit, previousCommit, installedCommit };
  } catch (error) {
    return {
      status: 'failed',
      previousCommit: current.source.type === 'github' || current.source.type === 'git'
        ? current.source.commit
        : undefined,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 生成不包含仓库凭据和本机路径的 owner 通知。 */
export function productionSkillSyncNotice(result: ProductionSkillSyncResult): string | null {
  if (result.status === 'repaired') {
    return `✅ Botmux 维护 Skill 已自动对齐生产版本\n\n${result.previousCommit?.slice(0, 8) ?? '未知'} → ${result.installedCommit?.slice(0, 8) ?? '未知'}\n跟踪分支：custom/prod`;
  }
  if (result.status === 'failed') {
    return `⚠️ Botmux 维护 Skill 与生产版本对齐失败\n\n原因：${result.reason ?? '未知错误'}\n已保持现有 Skill，不影响 daemon 启动；请运行 botmux skills doctor 后人工核对。`;
  }
  return null;
}
