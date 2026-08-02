/**
 * 当前运行版本的统一身份出口。
 * 版本化源码部署优先读取 dist 内 manifest；其它安装方式安全降级到已有版本与 build-id。
 */
import { execFileSync } from 'node:child_process';
import { botmuxInstallRoot } from './install-info.js';
import { resolveCurrentDeploymentVersion } from './install-diagnostics.js';
import { runtimeBuildIdentity } from './runtime-build-id.js';
import { readRuntimeRelease } from '../core/runtime-release.js';

export interface LiveIdentity {
  version: string;
  commit: string | null;
  buildId: string | null;
  deployTag: string | null;
  display: string;
}

export interface LiveIdentityOptions {
  root?: string;
  fallbackVersion?: () => string;
  fallbackCommit?: (root: string) => string | null;
  fallbackBuildId?: () => string | null;
}

function fallbackCommit(root: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function fallbackBuildId(): string | null {
  const identity = runtimeBuildIdentity();
  return identity.status === 'known' ? identity.id : null;
}

/** 保持同一字符串格式供 CLI、Dashboard 与重启报告直接复用。 */
export function formatLiveIdentity(input: Omit<LiveIdentity, 'display'>): string {
  return [
    input.version,
    input.commit ? input.commit.slice(0, 8) : 'commit unknown',
    input.buildId ? `build ${input.buildId.slice(0, 12)}` : 'build unknown',
  ].join(' | ');
}

export function resolveLiveIdentity(options: LiveIdentityOptions = {}): LiveIdentity {
  const root = options.root ?? botmuxInstallRoot();
  const runtime = readRuntimeRelease(root);
  const version = runtime
    ? runtime.manifest.deployTag.slice('deploy/v'.length)
    : (options.fallbackVersion ?? resolveCurrentDeploymentVersion)();
  const commit = runtime?.manifest.commit
    ?? (options.fallbackCommit ?? fallbackCommit)(root);
  const buildId = runtime?.manifest.runtimeBuildId
    ?? (options.fallbackBuildId ?? fallbackBuildId)();
  const deployTag = runtime?.manifest.deployTag ?? null;
  const base = { version, commit, buildId, deployTag };
  return { ...base, display: formatLiveIdentity(base) };
}
