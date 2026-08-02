/**
 * 源码部署更新入口：只为仓库内显式声明且远端身份匹配的 fork 开启一键同步。
 * 实际 Git、测试、构建和部署由独立脚本完成，Dashboard 仅负责校验、串行化与收集结果。
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceDeploymentIntent } from '../services/restart-intent-store.js';

export const SOURCE_UPDATE_CONFIG = '.botmux-source-update.json';

export interface SourceUpdateConfig {
  schemaVersion: 1;
  productionBranch: string;
  originRemote: string;
  originRepo: string;
  upstreamRemote: string;
  upstreamRepo: string;
}

export interface SourceUpdatePlan {
  root: string;
  config: SourceUpdateConfig;
  command: string;
}

export interface SourceUpdateResult {
  oldVersion: string;
  newVersion: string;
  changed: boolean;
  branch: string;
  upgradeBranch: string | null;
  releaseTag: string | null;
  deployTag: string | null;
  /** 官方同步完成后 custom/prod 的精确 HEAD，供新 daemon 做运行态验收。 */
  productionHead: string;
  /** 版本化同步完成后已激活的新旧运行目录，只由本机脚本生成并供重启驱动消费。 */
  runtimeRoot?: string;
  rollbackRoot?: string;
}

/**
 * 只把当前 Dashboard 进程刚完成且版本完全匹配的源码同步结果交给 restart intent；
 * 浏览器只能回传版本对，不能自行指定候选 tag 或 commit。
 */
export function sourceDeploymentForRestart(
  result: SourceUpdateResult | undefined,
  oldVersion: string,
  newVersion: string,
): SourceDeploymentIntent | undefined {
  if (!result?.changed || result.oldVersion !== oldVersion || result.newVersion !== newVersion) return undefined;
  if (!result.releaseTag || !/^release\/v\d+\.\d+\.\d+-custom\.\d+$/.test(result.releaseTag)) return undefined;
  if (!/^[0-9a-f]{40}$/.test(result.productionHead)) return undefined;
  return { releaseTag: result.releaseTag, expectedHead: result.productionHead };
}

interface SourceUpdateProbe {
  branch: string;
  originUrl: string;
  upstreamUrl: string;
}

const SAFE_NAME = /^[A-Za-z0-9._/-]+$/;
const RESULT_PREFIX = 'BOTMUX_SOURCE_UPDATE_RESULT=';

/** 解析并约束仓库内配置，拒绝额外命令或异常 ref 名称。 */
export function parseSourceUpdateConfig(value: unknown): SourceUpdateConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cfg = value as Record<string, unknown>;
  if (cfg.schemaVersion !== 1) return null;
  const keys = ['productionBranch', 'originRemote', 'originRepo', 'upstreamRemote', 'upstreamRepo'] as const;
  const allowed = new Set<string>(['schemaVersion', ...keys]);
  if (Object.keys(cfg).some(key => !allowed.has(key))) return null;
  if (keys.some(key => typeof cfg[key] !== 'string' || !SAFE_NAME.test(cfg[key] as string))) return null;
  return {
    schemaVersion: 1,
    productionBranch: cfg.productionBranch as string,
    originRemote: cfg.originRemote as string,
    originRepo: cfg.originRepo as string,
    upstreamRemote: cfg.upstreamRemote as string,
    upstreamRepo: cfg.upstreamRepo as string,
  };
}

/** 把 SSH/HTTPS GitHub 地址归一成 owner/repo，供可信远端比对。 */
export function githubRepoFromRemote(url: string): string | null {
  const match = url.trim().match(/github\.com(?::|\/)([^/\s]+\/[^/\s]+?)(?:\.git)?$/i);
  return match ? match[1] : null;
}

/** 根据已探测的分支与远端构造安全计划；任一身份不符都保持禁用。 */
export function sourceUpdatePlanFromProbe(
  root: string,
  config: SourceUpdateConfig,
  probe: SourceUpdateProbe,
): SourceUpdatePlan | null {
  if (probe.branch !== config.productionBranch) return null;
  if (githubRepoFromRemote(probe.originUrl)?.toLowerCase() !== config.originRepo.toLowerCase()) return null;
  if (githubRepoFromRemote(probe.upstreamUrl)?.toLowerCase() !== config.upstreamRepo.toLowerCase()) return null;
  return {
    root,
    config,
    command: `同步 ${config.upstreamRepo} 最新正式版 → ${config.originRepo}/${config.productionBranch}`,
  };
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** 从 Git 登记中找出唯一 canonical 生产 worktree，版本化 detached runtime 不参与猜测。 */
export function productionWorktreeFromPorcelain(output: string, productionBranch: string): string | null {
  const roots = output.split(/\n\s*\n/).flatMap(block => {
    const lines = block.split(/\r?\n/);
    const worktree = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length);
    const branch = lines.find(line => line.startsWith('branch '))?.slice('branch '.length);
    return worktree && branch === `refs/heads/${productionBranch}` ? [worktree] : [];
  });
  return roots.length === 1 ? roots[0] : null;
}

function configAt(root: string): SourceUpdateConfig | null {
  try {
    return parseSourceUpdateConfig(JSON.parse(readFileSync(join(root, SOURCE_UPDATE_CONFIG), 'utf8')));
  } catch {
    return null;
  }
}

function planAt(root: string, config: SourceUpdateConfig): SourceUpdatePlan | null {
  return sourceUpdatePlanFromProbe(root, config, {
    branch: git(root, ['symbolic-ref', '--short', 'HEAD']),
    originUrl: git(root, ['remote', 'get-url', config.originRemote]),
    upstreamUrl: git(root, ['remote', 'get-url', config.upstreamRemote]),
  });
}

/** 探测当前源码 checkout 是否是受信任的 fork/upstream 生产部署。 */
export function tryResolveSourceUpdatePlan(root: string): SourceUpdatePlan | null {
  const config = configAt(root);
  if (!config) return null;
  try {
    const direct = planAt(root, config);
    if (direct) return direct;
  } catch {
    // detached runtime 的 symbolic-ref 会失败，继续按 Git worktree 登记找 canonical root。
  }
  try {
    const productionRoot = productionWorktreeFromPorcelain(
      git(root, ['worktree', 'list', '--porcelain']),
      config.productionBranch,
    );
    if (!productionRoot || productionRoot === root) return null;
    const productionConfig = configAt(productionRoot);
    if (!productionConfig || JSON.stringify(productionConfig) !== JSON.stringify(config)) return null;
    return planAt(productionRoot, productionConfig);
  } catch {
    return null;
  }
}

/** 启动独立同步脚本并解析唯一的结构化结果行。 */
export function runSourceUpdate(plan: SourceUpdatePlan): Promise<SourceUpdateResult> {
  const script = join(plan.root, 'scripts', 'sync-official-source.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--root', plan.root], {
      cwd: plan.root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const capture = (data: Buffer): void => { tail = (tail + data.toString()).slice(-12_000); };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('源码同步超过 30 分钟，已终止'));
    }, 30 * 60_000);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(tail.trim().slice(-2_000) || `源码同步退出码 ${code}`));
        return;
      }
      const line = tail.split(/\r?\n/).reverse().find(item => item.startsWith(RESULT_PREFIX));
      if (!line) {
        reject(new Error('源码同步缺少结构化结果'));
        return;
      }
      try {
        resolve(JSON.parse(line.slice(RESULT_PREFIX.length)) as SourceUpdateResult);
      } catch {
        reject(new Error('源码同步结果无法解析'));
      }
    });
  });
}
