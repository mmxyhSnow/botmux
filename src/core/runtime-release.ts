/**
 * 版本化运行目录的身份与原子切换原语。
 * release/deploy tag 是目录身份真源；current/controller 只保存可原子替换的指针。
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const RELEASE_TAG = /^release\/(v\d+\.\d+\.\d+-custom\.(\d+))$/;
const DEPLOY_TAG = /^deploy\/(v\d+\.\d+\.\d+-custom\.(\d+))$/;
const COMMIT = /^[0-9a-f]{40}$/;
const BUILD_ID = /^[0-9a-f]{64}$/;
const MANIFEST_FILE = '.botmux-runtime-release.json';

export interface RuntimeReleaseManifest {
  schemaVersion: 1;
  releaseTag: string;
  deployTag: string;
  commit: string;
  runtimeBuildId: string;
  createdAt: string;
}

export interface RuntimeReleaseRecord {
  root: string;
  manifest: RuntimeReleaseManifest;
}

export interface RuntimeActivationResult {
  currentRoot: string;
  previousRoot?: string;
}

/** 把候选标签收敛为不含斜杠的版本目录名，拒绝路径穿越。 */
export function runtimeReleaseVersion(releaseTag: string): string {
  const match = releaseTag.match(RELEASE_TAG);
  if (!match) throw new Error(`候选标签无效：${releaseTag}`);
  return match[1];
}

/** 返回某个候选版本唯一、稳定的运行目录。 */
export function runtimeReleaseRoot(configRoot: string, releaseTag: string): string {
  return join(resolve(configRoot), 'releases', runtimeReleaseVersion(releaseTag));
}

export function runtimeCurrentLink(configRoot: string): string {
  return join(resolve(configRoot), 'runtime', 'current');
}

export function runtimeControllerLink(configRoot: string): string {
  return join(resolve(configRoot), 'runtime', 'controller');
}

export function runtimeReleaseManifestPath(root: string): string {
  return join(resolve(root), 'dist', MANIFEST_FILE);
}

/** 只接受 release/deploy 同号、commit/build-id 完整的运行身份。 */
export function normalizeRuntimeReleaseManifest(raw: unknown): RuntimeReleaseManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const release = typeof value.releaseTag === 'string' ? value.releaseTag.match(RELEASE_TAG) : null;
  const deploy = typeof value.deployTag === 'string' ? value.deployTag.match(DEPLOY_TAG) : null;
  if (
    value.schemaVersion !== 1
    || !release
    || !deploy
    || release[1] !== deploy[1]
    || typeof value.commit !== 'string'
    || !COMMIT.test(value.commit)
    || typeof value.runtimeBuildId !== 'string'
    || !BUILD_ID.test(value.runtimeBuildId)
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))
  ) return null;
  return {
    schemaVersion: 1,
    releaseTag: value.releaseTag as string,
    deployTag: value.deployTag as string,
    commit: value.commit,
    runtimeBuildId: value.runtimeBuildId,
    createdAt: value.createdAt,
  };
}

/** 构建完成后写入 dist 内的身份清单；dist 被清理重建时旧清单会自然失效。 */
export function writeRuntimeReleaseManifest(root: string, manifest: RuntimeReleaseManifest): void {
  const normalized = normalizeRuntimeReleaseManifest(manifest);
  if (!normalized) throw new Error('运行版本身份清单无效');
  const path = runtimeReleaseManifestPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/** 回读一个版本目录，并同时校验关键运行入口与 build-id。 */
export function readRuntimeRelease(root: string): RuntimeReleaseRecord | null {
  const canonicalRoot = resolve(root);
  try {
    const manifest = normalizeRuntimeReleaseManifest(
      JSON.parse(readFileSync(runtimeReleaseManifestPath(canonicalRoot), 'utf8')),
    );
    if (!manifest) return null;
    const buildId = readFileSync(join(canonicalRoot, 'dist', '.runtime-build-id'), 'utf8').trim();
    if (buildId !== manifest.runtimeBuildId) return null;
    for (const entry of ['cli.js', 'index-daemon.js', 'dashboard.js']) {
      if (!existsSync(join(canonicalRoot, 'dist', entry))) return null;
    }
    return { root: realpathSync(canonicalRoot), manifest };
  } catch {
    return null;
  }
}

function readLinkedRelease(link: string): RuntimeReleaseRecord | null {
  try {
    if (!lstatSync(link).isSymbolicLink()) return null;
    return readRuntimeRelease(realpathSync(link));
  } catch {
    return null;
  }
}

export function readCurrentRuntimeRelease(configRoot: string): RuntimeReleaseRecord | null {
  return readLinkedRelease(runtimeCurrentLink(configRoot));
}

export function readControllerRuntimeRelease(configRoot: string): RuntimeReleaseRecord | null {
  return readLinkedRelease(runtimeControllerLink(configRoot));
}

/**
 * 先创建同目录临时 symlink，再用 rename 覆盖 current/controller；读者只会看到旧指针或新指针。
 */
function activateLink(link: string, targetRoot: string): RuntimeActivationResult {
  const target = readRuntimeRelease(targetRoot);
  if (!target) throw new Error(`目标不是完整运行版本：${targetRoot}`);
  mkdirSync(dirname(link), { recursive: true });
  const previous = readLinkedRelease(link);
  const tmp = `${link}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  try {
    symlinkSync(target.root, tmp, 'dir');
    renameSync(tmp, link);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return { currentRoot: target.root, ...(previous ? { previousRoot: previous.root } : {}) };
}

export function activateRuntimeRelease(configRoot: string, targetRoot: string): RuntimeActivationResult {
  return activateLink(runtimeCurrentLink(configRoot), targetRoot);
}

export function activateRuntimeController(configRoot: string, targetRoot: string): RuntimeActivationResult {
  return activateLink(runtimeControllerLink(configRoot), targetRoot);
}

/** 列出完整版本目录，按 official semver 与 custom 序号从新到旧排序。 */
export function listRuntimeReleases(configRoot: string): RuntimeReleaseRecord[] {
  const root = join(resolve(configRoot), 'releases');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      const record = readRuntimeRelease(join(root, entry.name));
      return record ? [record] : [];
    })
    .sort((left, right) => compareDeployTags(right.manifest.deployTag, left.manifest.deployTag));
}

function deployParts(tag: string): [number, number, number, number] {
  const match = tag.match(/^deploy\/v(\d+)\.(\d+)\.(\d+)-custom\.(\d+)$/);
  if (!match) return [0, 0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

function compareDeployTags(left: string, right: string): number {
  const a = deployParts(left);
  const b = deployParts(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
}

/** `--last` 只允许选择严格早于当前 deploy tag 的最近完整版本。 */
export function selectPreviousRuntimeRelease(
  releases: readonly RuntimeReleaseRecord[],
  currentDeployTag: string,
): RuntimeReleaseRecord | null {
  return releases.find(item => compareDeployTags(item.manifest.deployTag, currentDeployTag) < 0) ?? null;
}

/** 仅供 wrapper 诊断：返回 symlink 的原始目标，不把普通文件误当成运行指针。 */
export function readRuntimeLinkTarget(link: string): string | null {
  try {
    return lstatSync(link).isSymbolicLink() ? readlinkSync(link) : null;
  } catch {
    return null;
  }
}
