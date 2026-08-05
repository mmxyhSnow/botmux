/**
 * Host-side CLI runtime update monitor.
 *
 * `cliId` selects an adapter protocol; a configured runtime identifies the
 * concrete distribution that implements that protocol.  Keeping those axes
 * separate is especially important for Codex-compatible forks: their release
 * stream must never be compared with @openai/codex merely because they reuse
 * the Codex adapter.
 *
 * Every probe is read-only.  Botmux persists status and may notify the owner,
 * but never executes an update command.
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { get as httpsGet } from 'node:https';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { ProxyAgent } from 'proxy-agent';
import { isNewerVersion, parseVersion } from './update-check.js';
import { githubAuthHeaders } from './github-auth.js';
import { localeForBot, t, type Locale } from '../i18n/index.js';
import {
  isValidNpmPackageName,
  type CliRuntimeConfig,
  type CliRuntimeUpdateConfig,
} from '../adapters/cli/runtime.js';

export const CLI_RUNTIME_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const CLI_RUNTIME_UPDATE_TICK_MS = 60 * 60 * 1_000;
export const CLI_RUNTIME_UPDATE_INITIAL_DELAY_MS = 20_000;

export type CliRuntimeUpdateProvider = 'internal' | 'auto' | 'self' | 'npm';

export interface CliRuntimeUpdateTarget {
  cliId: 'codex';
  runtimeId: string;
  displayName: string;
  binPath: string;
  provider: CliRuntimeUpdateProvider;
  /** Explicit npm source, or the exact owner discovered for an auto target. */
  packageName?: string;
  /** Package root discovered for an auto target; never user-controlled. */
  packageRoot?: string;
}

export interface ConfiguredCliRuntime {
  cliId: string;
  cliPathOverride?: string;
  wrapperCli?: string;
  cliRuntime?: CliRuntimeConfig;
}

export interface CliRuntimeUpdateEntry {
  cliId: 'codex';
  runtimeId: string;
  displayName: string;
  binPath: string;
  provider: CliRuntimeUpdateProvider;
  /** Explicit npm source, when configured. Persisted so source changes can
   * invalidate the TTL/status cache instead of inheriting another package. */
  packageName?: string;
  /** Stable identity of the configured update source (provider + npm package). */
  sourceFingerprint: string;
  managed: boolean;
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  updateCommand: string | null;
  installTarget?: string;
  lastCheckedAt: number;
  lastNotifiedVersion?: string;
}

export interface CliRuntimeUpdateStore {
  entries: Record<string, CliRuntimeUpdateEntry>;
}

export interface CliRuntimeUpdateProbeResult {
  current: string;
  latest: string | null;
  managed: boolean;
  updateCommand: string | null;
  /** Exact npm owner selected by auto provenance. */
  packageName?: string;
  installTarget?: string;
}

/** Backward-compatible name retained for importers/tests written when only the
 * official Codex distribution was supported. */
export type CodexUpdateProbeResult = CliRuntimeUpdateProbeResult;

export interface NpmPackageProvenance {
  packageName: string;
  packageRoot: string;
}

export interface CodexUpdateProbeDeps {
  runFile?: (bin: string, args: string[], timeoutMs: number) => Promise<string>;
  /** Legacy official-Codex registry injection. */
  fetchLatest?: () => Promise<string | null>;
  fetchNpmLatest?: (packageName: string) => Promise<string | null>;
  resolveNpmPackage?: (binPath: string) => NpmPackageProvenance | null;
}

/** Codex 官方发布页中适合直接展示给用户的高层更新摘要。 */
export interface CodexReleaseNotes {
  summary: string;
  url: string;
}

export interface CodexReleaseNotesDeps {
  fetchImpl?: typeof fetch;
  fetchHtml?: (url: string) => Promise<string>;
  timeoutMs?: number;
}

export interface CliRuntimeUpdateAuditDeps {
  now: () => number;
  targets: () => CliRuntimeUpdateTarget[];
  readStore: () => CliRuntimeUpdateStore;
  writeStore: (store: CliRuntimeUpdateStore) => void;
  probe: (target: CliRuntimeUpdateTarget) => Promise<CliRuntimeUpdateProbeResult>;
  /** Cheap local provenance refresh used before applying the 24h network TTL. */
  resolveAutoPackage?: (binPath: string) => NpmPackageProvenance | null;
  notify?: (entry: CliRuntimeUpdateEntry) => Promise<void>;
  log?: (message: string) => void;
}

export interface CliRuntimeUpdateMonitorWiring {
  dataDir: string;
  primaryLarkAppId: string;
  ownerOpenId: () => string | undefined;
  dashboardUrl?: () => string | undefined;
  targets: () => CliRuntimeUpdateTarget[];
  sendCard: (openId: string, cardJson: string) => Promise<void>;
  log?: (message: string) => void;
}

const STORE_FILE = 'cli-runtime-updates.json';
const STORE_NEEDS_REWRITE = Symbol('cli-runtime-update-store-needs-rewrite');

type CliRuntimeUpdateStoreWithMigration = CliRuntimeUpdateStore & {
  [STORE_NEEDS_REWRITE]?: true;
};

interface ValidatedStoreEntry {
  entry: CliRuntimeUpdateEntry;
  needsRewrite: boolean;
}

type CliRuntimeUpdatePolicyProvider = CliRuntimeUpdateProvider | 'none';

type CliRuntimeUpdateCandidate = Omit<CliRuntimeUpdateTarget, 'provider'> & {
  provider: CliRuntimeUpdatePolicyProvider;
};

function updateSourceFingerprint(
  provider: CliRuntimeUpdatePolicyProvider,
  packageName?: string,
): string {
  return JSON.stringify([
    provider,
    provider === 'npm' || provider === 'auto' ? packageName ?? '' : '',
  ]);
}

export function cliRuntimeUpdateStorePathIn(dataDir: string): string {
  return join(dataDir, STORE_FILE);
}

function validEntry(raw: unknown): ValidatedStoreEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (v.cliId !== 'codex' || typeof v.binPath !== 'string' || !v.binPath) return null;
  if (typeof v.lastCheckedAt !== 'number' || !Number.isFinite(v.lastCheckedAt)) return null;
  const current = typeof v.current === 'string' && parseVersion(v.current) ? v.current : null;
  const runtimeId = typeof v.runtimeId === 'string' && v.runtimeId ? v.runtimeId : 'codex';
  const displayName = typeof v.displayName === 'string' && v.displayName ? v.displayName : 'Codex';
  const provider: CliRuntimeUpdateProvider = v.provider === 'auto'
    || v.provider === 'self'
    || v.provider === 'npm'
    || v.provider === 'internal'
    ? v.provider
    // Missing fields are v1 official entries. Any non-official identity fails
    // safe to auto instead of inheriting the OpenAI registry.
    : runtimeId === 'codex' ? 'internal' : 'auto';
  const packageName = (provider === 'npm' || provider === 'auto')
    && typeof v.packageName === 'string'
    && isValidNpmPackageName(v.packageName)
    ? v.packageName
    : undefined;
  // An auto row without its proven npm owner predates package-aware
  // fingerprints (or is corrupt). It cannot safely retain a latest version,
  // command, install target, or notification watermark from an unknown stream.
  const autoUnmanaged = provider === 'auto' && !packageName;
  const latest = !autoUnmanaged && typeof v.latest === 'string' && parseVersion(v.latest)
    ? v.latest
    : null;
  // npm bin ownership identifies a release stream, not the package manager
  // that installed it. Strip commands persisted by older auto probes instead
  // of continuing to suggest an unproven `npm install -g` action.
  const persistedUpdateCommand = typeof v.updateCommand === 'string' && v.updateCommand.trim()
    ? v.updateCommand.trim()
    : null;
  const updateCommand = provider !== 'auto' && !autoUnmanaged
    ? persistedUpdateCommand
    : null;
  return {
    needsRewrite: provider === 'auto' && persistedUpdateCommand !== null,
    entry: {
      cliId: 'codex',
      runtimeId,
      displayName,
      binPath: v.binPath,
      provider,
      ...(packageName ? { packageName } : {}),
      // Recompute instead of trusting persisted input. Besides hardening corrupted
      // stores, this migrates v1/v2 entries onto the current fingerprint format.
      sourceFingerprint: updateSourceFingerprint(provider, packageName),
      // v1 stores predate this field and represented official Codex, which is
      // managed.  Preserve that behavior while reading them.
      managed: autoUnmanaged
        ? false
        : typeof v.managed === 'boolean'
          ? v.managed
          : provider === 'internal' || provider === 'npm' || (provider === 'auto' && !!packageName),
      current,
      latest,
      updateAvailable: !!current && !!latest && isNewerVersion(latest, current),
      updateCommand,
      ...(!autoUnmanaged && typeof v.installTarget === 'string' && v.installTarget
        ? { installTarget: v.installTarget }
        : {}),
      lastCheckedAt: v.lastCheckedAt,
      ...(!autoUnmanaged && typeof v.lastNotifiedVersion === 'string' && parseVersion(v.lastNotifiedVersion)
        ? { lastNotifiedVersion: v.lastNotifiedVersion }
        : {}),
    },
  };
}

export function readCliRuntimeUpdateStoreFrom(dataDir: string): CliRuntimeUpdateStore {
  const path = cliRuntimeUpdateStorePathIn(dataDir);
  if (!existsSync(path)) return { entries: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { entries?: unknown };
    if (!raw?.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) return { entries: {} };
    const entries: Record<string, CliRuntimeUpdateEntry> = {};
    let needsRewrite = false;
    for (const [key, value] of Object.entries(raw.entries as Record<string, unknown>)) {
      const validated = validEntry(value);
      if (!validated) continue;
      entries[key] = validated.entry;
      needsRewrite ||= validated.needsRewrite;
    }
    const store: CliRuntimeUpdateStoreWithMigration = { entries };
    if (needsRewrite) {
      Object.defineProperty(store, STORE_NEEDS_REWRITE, { value: true });
    }
    return store;
  } catch {
    return { entries: {} };
  }
}

export function writeCliRuntimeUpdateStoreTo(dataDir: string, store: CliRuntimeUpdateStore): void {
  const path = cliRuntimeUpdateStorePathIn(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export function listCliRuntimeUpdateEntries(dataDir: string): CliRuntimeUpdateEntry[] {
  return Object.values(readCliRuntimeUpdateStoreFrom(dataDir).entries)
    .filter((entry) => entry.current !== null)
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.binPath.localeCompare(b.binPath));
}

function execFileText(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      const output = String(stdout ?? '').trim();
      // `doctor` may exit non-zero for an unrelated optional check while still
      // returning a complete machine-readable report.
      if (error && !(args[0] === 'doctor' && args.includes('--json') && output.startsWith('{'))) reject(error);
      else resolvePromise(output);
    });
  });
}

function versionFromText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match = raw.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return match && parseVersion(match[0]) ? match[0] : null;
}

function doctorUpdateDetails(raw: string): {
  current: string | null;
  probedLatest: string | null;
  cachedLatest: string | null;
  updateCommand?: string;
  installTarget?: string;
} {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const rawChecks = parsed.checks;
  const checks = Array.isArray(rawChecks)
    ? rawChecks
    : rawChecks && typeof rawChecks === 'object'
      ? Object.values(rawChecks as Record<string, unknown>)
      : [];
  const update = checks.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).id === 'updates.status') as Record<string, unknown> | undefined;
  const details = update?.details && typeof update.details === 'object' && !Array.isArray(update.details)
    ? update.details as Record<string, unknown>
    : {};
  const installTargetKey = Object.keys(details).find((key) => key.endsWith('update target'));
  return {
    current: versionFromText(parsed.codexVersion),
    probedLatest: versionFromText(details['latest version probe']) ?? versionFromText(details['latest version']),
    cachedLatest: versionFromText(details['cached latest version']),
    ...(typeof details['update action'] === 'string' && details['update action'].trim()
      ? { updateCommand: details['update action'].trim() }
      : {}),
    ...(installTargetKey && typeof details[installTargetKey] === 'string' && details[installTargetKey]
      ? { installTarget: details[installTargetKey] as string }
      : {}),
  };
}

async function fetchLatestNpmVersion(packageName: string): Promise<string | null> {
  try {
    const encoded = encodeURIComponent(packageName);
    const response = await fetch(`https://registry.npmjs.org/${encoded}/latest`, {
      headers: { Accept: 'application/json', 'User-Agent': 'botmux' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { version?: unknown };
    return typeof body.version === 'string' && parseVersion(body.version) ? body.version : null;
  } catch {
    return null;
  }
}

const CODEX_RELEASES_BASE = 'https://github.com/openai/codex/releases/tag';
const CODEX_RELEASE_API_BASE = 'https://api.github.com/repos/openai/codex/releases/tags';
const MAX_RELEASE_HTML_BYTES = 2 * 1024 * 1024;
const MAX_RELEASE_SUMMARY_CHARS = 6_000;

/** 将普通语义版本号转成 Codex 仓库使用的 `rust-v*` 标签。 */
function codexReleaseTag(version: string): string {
  return `rust-v${version.replace(/^v/i, '')}`;
}

/** 将版本号转成 Codex 官方 GitHub Release 页地址。 */
function codexReleaseUrl(version: string): string {
  return `${CODEX_RELEASES_BASE}/${encodeURIComponent(codexReleaseTag(version))}`;
}

/** 去掉发布说明尾部冗长的 PR 编号，保留真正面向用户的功能描述。 */
function cleanReleaseBullet(value: string): string {
  return value
    .replace(/\s*\((?:\[#\d+\]\([^)]+\)(?:\s*,\s*)?)+\)\s*$/, '')
    .replace(/\s*\(\s*(?:#\d+\s*(?:,\s*)?)+\)\s*$/, '')
    .trim();
}

/** 限制飞书卡片摘要体积，且不产出空内容。 */
function capReleaseSummary(lines: string[]): string | null {
  const summary = lines.join('\n').trim();
  if (!summary) return null;
  return summary.length <= MAX_RELEASE_SUMMARY_CHARS
    ? summary
    : `${summary.slice(0, MAX_RELEASE_SUMMARY_CHARS - 1).trimEnd()}…`;
}

/** 只保留 GitHub Release 的高层章节，排除后面的逐提交 Changelog。 */
function releaseSummaryFromMarkdown(markdown: string): string | null {
  const lines: string[] = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = line.match(/^##\s+(.+)$/)?.[1]?.trim();
    if (heading) {
      if (/^changelog$/i.test(heading)) break;
      lines.push(`**${heading}**`);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/)?.[1];
    if (bullet) lines.push(`- ${cleanReleaseBullet(bullet)}`);
  }
  return capReleaseSummary(lines);
}

/** 解码发布页文本里常见的 HTML 实体与数字实体。 */
function decodeHtml(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'quot') return '"';
    if (normalized === 'apos') return "'";
    const radix = normalized.startsWith('#x') ? 16 : 10;
    const rawCode = normalized.replace(/^#x?/, '');
    const code = Number.parseInt(rawCode, radix);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
  });
}

/** 将单个标题或列表项 HTML 转为可在卡片中展示的纯文本。 */
function htmlFragmentText(fragment: string): string {
  return decodeHtml(fragment
    .replace(/<code[^>]*>/gi, '`')
    .replace(/<\/code>/gi, '`')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** GitHub API 被共享出口限流时，从公开 Release HTML 回退提取同一份摘要。 */
function releaseSummaryFromHtml(html: string): string | null {
  const bodyStart = html.search(/<div[^>]*data-test-selector=["']body-content["'][^>]*>/i);
  if (bodyStart < 0) return null;
  const body = html.slice(bodyStart);
  const lines: string[] = [];
  const tokens = body.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>|<li[^>]*>([\s\S]*?)<\/li>/gi);
  for (const token of tokens) {
    if (token[1] !== undefined) {
      const heading = htmlFragmentText(token[1]);
      if (/^changelog$/i.test(heading)) break;
      lines.push(`**${heading}**`);
      continue;
    }
    const bullet = cleanReleaseBullet(htmlFragmentText(token[2] ?? ''));
    if (bullet) lines.push(`- ${bullet}`);
  }
  return capReleaseSummary(lines);
}

/** 通过宿主代理下载发布页，并对超时和响应体体积设硬限。 */
function fetchHtmlWithProxy(url: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpsGet(url, {
      agent: new ProxyAgent(),
      headers: { 'User-Agent': 'botmux' },
      timeout: timeoutMs,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`release page returned ${response.statusCode ?? 'unknown'}`));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RELEASE_HTML_BYTES) {
          request.destroy(new Error('release page exceeded size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('timeout', () => request.destroy(new Error('release page timed out')));
    request.on('error', reject);
  });
}

/** 获取指定 Codex 版本的官方更新摘要；API 失败时自动回退公开发布页。 */
export async function fetchCodexReleaseNotes(
  version: string,
  deps: CodexReleaseNotesDeps = {},
): Promise<CodexReleaseNotes | null> {
  const releaseUrl = codexReleaseUrl(version);
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${CODEX_RELEASE_API_BASE}/${encodeURIComponent(codexReleaseTag(version))}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'botmux',
        ...githubAuthHeaders(),
      },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 8_000),
    });
    if (response.ok) {
      const body = await response.json() as { body?: unknown; html_url?: unknown };
      const summary = typeof body.body === 'string' ? releaseSummaryFromMarkdown(body.body) : null;
      if (summary) {
        return {
          summary,
          url: typeof body.html_url === 'string' && body.html_url ? body.html_url : releaseUrl,
        };
      }
    }
  } catch {
    // 继续尝试不受 GitHub API 共享限流影响的公开发布页。
  }

  try {
    const html = await (deps.fetchHtml ?? ((url) => fetchHtmlWithProxy(url, deps.timeoutMs ?? 10_000)))(releaseUrl);
    const summary = releaseSummaryFromHtml(html);
    return summary ? { summary, url: releaseUrl } : null;
  } catch {
    return null;
  }
}

function sameFile(left: string, right: string): boolean {
  try { return realpathSync(left) === realpathSync(right); } catch { return resolve(left) === resolve(right); }
}

/** Resolve an executable back to the npm package that actually owns its bin
 * entry.  Merely finding a parent package.json is insufficient: global package
 * managers and monorepos contain unrelated manifests, so the package's `bin`
 * mapping must point at this exact real file. */
export function resolveNpmPackageForExecutable(binPath: string): NpmPackageProvenance | null {
  let realBin: string;
  try {
    realBin = realpathSync(binPath);
    if (!statSync(realBin).isFile()) return null;
  } catch {
    return null;
  }

  const commandName = basename(binPath);
  let dir = dirname(realBin);
  const root = parse(dir).root;
  const matches: NpmPackageProvenance[] = [];
  for (let depth = 0; depth < 16 && dir !== root; depth++, dir = dirname(dir)) {
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      const packageName = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : '';
      if (!packageName || !isValidNpmPackageName(packageName)) continue;
      const rawBin = manifest.bin;
      const mappings: Array<[string, string]> = [];
      if (typeof rawBin === 'string') {
        mappings.push([packageName.replace(/^@[^/]+\//, ''), rawBin]);
      } else if (rawBin && typeof rawBin === 'object' && !Array.isArray(rawBin)) {
        for (const [name, value] of Object.entries(rawBin as Record<string, unknown>)) {
          if (typeof value === 'string') mappings.push([name, value]);
        }
      }
      const exact = mappings.find(([name, mapped]) => name === commandName && sameFile(join(dir, mapped), realBin));
      const any = mappings.find(([, mapped]) => sameFile(join(dir, mapped), realBin));
      if (exact || any) matches.push({ packageName, packageRoot: dir });
    } catch {
      // Keep walking: a malformed/unrelated parent manifest is not provenance.
    }
  }
  // A nested package and an enclosing workspace can both claim the same file.
  // Config order or directory proximity is not provenance: auto is safe only
  // when exactly one manifest owns the executable.
  return matches.length === 1 ? matches[0]! : null;
}

type AutoPackageResolver = (binPath: string) => NpmPackageProvenance | null;

/** Re-resolve auto provenance from the executable immediately before a cache
 * or badge decision. Persisted package names are deliberately ignored: a
 * stable command/symlink may have been retargeted to another installation. */
function refreshAutoTargetProvenance(
  target: CliRuntimeUpdateTarget,
  resolver: AutoPackageResolver,
): CliRuntimeUpdateTarget {
  if (target.provider !== 'auto') return target;
  const {
    packageName: _stalePackageName,
    packageRoot: _stalePackageRoot,
    ...base
  } = target;
  try {
    const provenance = resolver(target.binPath);
    if (!provenance
        || !isValidNpmPackageName(provenance.packageName)
        || typeof provenance.packageRoot !== 'string'
        || !provenance.packageRoot) {
      return base;
    }
    return {
      ...base,
      packageName: provenance.packageName,
      packageRoot: provenance.packageRoot,
    };
  } catch {
    // Local provenance is best-effort, but failure must become unmanaged rather
    // than inheriting a previously cached release source.
    return base;
  }
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Read-only provider-aware probe. The official provider alone may fall back
 * to @openai/codex. `auto` requires exact npm-bin provenance; if provenance
 * cannot identify an update stream, it is reported unmanaged and remains
 * quiet. Only explicit `self` may trust a matching custom doctor. */
export async function probeCliRuntimeUpdate(
  target: CliRuntimeUpdateTarget,
  deps: CodexUpdateProbeDeps = {},
): Promise<CliRuntimeUpdateProbeResult> {
  const runFile = deps.runFile ?? execFileText;
  const fetchNpmLatest = deps.fetchNpmLatest ?? fetchLatestNpmVersion;
  const versionOutput = await runFile(target.binPath, ['--version'], 5_000);
  const current = versionFromText(versionOutput);
  if (!current) throw new Error(`unrecognised ${target.displayName} version output: ${versionOutput.slice(0, 120)}`);

  // A doctor result is trustworthy only when it identifies the exact version
  // just read from this executable. Forks can retain an upstream Codex doctor;
  // accepting that report would overwrite the fork's independent version and
  // release stream. auto/npm intentionally never invoke doctor at all.
  let trustedDoctor: ReturnType<typeof doctorUpdateDetails> | undefined;
  if (target.provider === 'internal' || target.provider === 'self') {
    try {
      const details = doctorUpdateDetails(await runFile(target.binPath, ['doctor', '--json'], 12_000));
      if (details.current === current) trustedDoctor = details;
    } catch {
      // Provider-specific fallbacks below decide whether a verifiable release
      // stream remains available.
    }
  }

  if (target.provider === 'self') {
    return {
      current,
      latest: trustedDoctor?.probedLatest ?? trustedDoctor?.cachedLatest ?? null,
      managed: !!trustedDoctor,
      updateCommand: trustedDoctor?.updateCommand ?? null,
      ...(trustedDoctor?.installTarget ? { installTarget: trustedDoctor.installTarget } : {}),
    };
  }

  if (target.provider === 'internal') {
    if (trustedDoctor?.probedLatest) {
      return {
        current,
        latest: trustedDoctor.probedLatest,
        managed: true,
        updateCommand: trustedDoctor.updateCommand ?? `${shellQuote(target.binPath)} update`,
        ...(trustedDoctor.installTarget ? { installTarget: trustedDoctor.installTarget } : {}),
      };
    }
    const latest = await (deps.fetchLatest ?? (() => fetchNpmLatest('@openai/codex')))();
    return {
      current,
      latest: latest ?? trustedDoctor?.cachedLatest ?? null,
      managed: true,
      updateCommand: trustedDoctor?.updateCommand ?? `${shellQuote(target.binPath)} update`,
      ...(trustedDoctor?.installTarget ? { installTarget: trustedDoctor.installTarget } : {}),
    };
  }

  let packageName: string | undefined;
  let packageRoot: string | undefined;
  if (target.provider === 'npm') {
    packageName = target.packageName;
  } else if (target.packageName && target.packageRoot) {
    // The audit refreshes local provenance before consulting its network TTL.
    // Direct probe callers may omit it and use the resolver fallback below.
    packageName = target.packageName;
    packageRoot = target.packageRoot;
  } else {
    const provenance = (deps.resolveNpmPackage ?? resolveNpmPackageForExecutable)(target.binPath);
    packageName = provenance?.packageName;
    packageRoot = provenance?.packageRoot;
  }
  if (packageName && !isValidNpmPackageName(packageName)) {
    if (target.provider === 'npm') throw new Error(`invalid npm package name for ${target.displayName}`);
    packageName = undefined;
    packageRoot = undefined;
  }
  if (!packageName) {
    return { current, latest: null, managed: false, updateCommand: null };
  }

  const latest = await fetchNpmLatest(packageName);
  return {
    current,
    // Once npm provenance is selected it is the only latest-version source.
    // A cached value advertised by doctor may belong to a different stream.
    latest,
    managed: true,
    // Explicit `npm` is a user-selected update policy. Auto provenance proves
    // only package/bin ownership, so it may select the registry stream but
    // must not infer npm (rather than pnpm/yarn/etc.) as the installer.
    updateCommand: target.provider === 'npm'
      ? `npm install -g ${packageName}@latest`
      : null,
    ...(target.provider === 'auto' ? { packageName } : {}),
    ...(packageRoot ? { installTarget: packageRoot } : {}),
  };
}

/** Historical public entry point. */
export async function probeCodexRuntimeUpdate(
  target: CliRuntimeUpdateTarget,
  deps: CodexUpdateProbeDeps = {},
): Promise<CodexUpdateProbeResult> {
  return probeCliRuntimeUpdate(target, deps);
}

function targetKey(target: Pick<CliRuntimeUpdateTarget, 'runtimeId' | 'binPath'>): string {
  return `${target.runtimeId}:${target.binPath}`;
}

function targetInstallationKey(target: Pick<CliRuntimeUpdateTarget, 'binPath'>): string {
  try { return realpathSync(target.binPath); }
  catch { return resolve(target.binPath); }
}

/** De-duplicate only identical update sources. If two bots assign different
 * providers/packages to one runtime installation, neither source is safe to
 * choose based on config order, so omit that installation entirely. */
function dedupeCandidates(targets: CliRuntimeUpdateCandidate[]): CliRuntimeUpdateTarget[] {
  const grouped = new Map<string, {
    target: CliRuntimeUpdateCandidate;
    sourceFingerprint: string;
    conflicted: boolean;
  }>();
  for (const target of targets) {
    if (!target.binPath) continue;
    const key = targetInstallationKey(target);
    const sourceFingerprint = updateSourceFingerprint(target.provider, target.packageName);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { target, sourceFingerprint, conflicted: false });
      continue;
    }
    if (
      existing.target.runtimeId !== target.runtimeId
      || existing.sourceFingerprint !== sourceFingerprint
    ) {
      existing.conflicted = true;
    }
  }

  const out: CliRuntimeUpdateTarget[] = [];
  for (const entry of grouped.values()) {
    if (entry.conflicted || entry.target.provider === 'none') continue;
    out.push({
      ...entry.target,
      provider: entry.target.provider,
    });
  }
  return out;
}

function dedupeTargets(targets: CliRuntimeUpdateTarget[]): CliRuntimeUpdateTarget[] {
  return dedupeCandidates(targets);
}

/** Project persisted status onto the runtimes configured right now. The
 * monitor eventually prunes stale entries, but Dashboard reads can happen
 * immediately after an agent/runtime edit; filtering here prevents an old
 * official/provider badge from lingering until the next hourly audit. */
export function filterCliRuntimeUpdateEntriesForTargets(
  entries: CliRuntimeUpdateEntry[],
  targets: CliRuntimeUpdateTarget[],
  resolveAutoPackage: AutoPackageResolver = resolveNpmPackageForExecutable,
): CliRuntimeUpdateEntry[] {
  const refreshedTargets = targets.map((target) => (
    refreshAutoTargetProvenance(target, resolveAutoPackage)
  ));
  const current = new Map(dedupeTargets(refreshedTargets).map((target) => [targetKey(target), target]));
  const visible: CliRuntimeUpdateEntry[] = [];
  for (const entry of entries) {
    const target = current.get(targetKey(entry));
    if (!target) continue;
    if (updateSourceFingerprint(entry.provider, entry.packageName)
        !== updateSourceFingerprint(target.provider, target.packageName)) continue;
    if (target.provider === 'auto' && !target.packageName) {
      const {
        packageName: _packageName,
        installTarget: _installTarget,
        lastNotifiedVersion: _lastNotifiedVersion,
        ...currentOnly
      } = entry;
      visible.push({
        ...currentOnly,
        displayName: target.displayName,
        provider: 'auto',
        sourceFingerprint: updateSourceFingerprint('auto'),
        managed: false,
        latest: null,
        updateAvailable: false,
        updateCommand: null,
      });
      continue;
    }
    visible.push({
      ...entry,
      // Product-facing identity comes from the current config even before the
      // next probe refreshes the persisted audit row.
      displayName: target.displayName,
      provider: target.provider,
      ...(target.packageName ? { packageName: target.packageName } : { packageName: undefined }),
      sourceFingerprint: updateSourceFingerprint(target.provider, target.packageName),
      // Also sanitize callers that supply an in-memory/legacy store without
      // passing through readCliRuntimeUpdateStoreFrom first.
      updateCommand: target.provider === 'auto' ? null : entry.updateCommand,
    });
  }
  return visible;
}

function configuredProvider(update: CliRuntimeUpdateConfig | undefined): {
  provider: CliRuntimeUpdateProvider | 'none';
  packageName?: string;
} {
  if (!update || update.provider === 'auto') return { provider: 'auto' };
  if (update.provider === 'none') return { provider: 'none' };
  if (update.provider === 'self') return { provider: 'self' };
  return { provider: 'npm', packageName: update.packageName };
}

/** Resolve every configured Codex-protocol distribution.  Old plain Codex
 * configs preserve the official fallback.  A legacy/custom path is `auto` and
 * therefore must prove exact npm provenance; it can never inherit the official
 * release stream. */
export function selectCodexRuntimeUpdateTargets(
  configs: ConfiguredCliRuntime[],
  resolveBin: (cliPathOverride?: string) => string,
): CliRuntimeUpdateTarget[] {
  const targets: CliRuntimeUpdateCandidate[] = [];
  for (const cfg of configs) {
    if (cfg.cliId !== 'codex' && cfg.cliId !== 'codex-app') continue;
    try {
      if (cfg.cliRuntime) {
        const update = configuredProvider(cfg.cliRuntime.update);
        targets.push({
          cliId: 'codex',
          runtimeId: cfg.cliRuntime.id,
          displayName: cfg.cliRuntime.displayName ?? cfg.cliRuntime.id,
          binPath: resolveBin(cfg.cliRuntime.executable),
          provider: update.provider,
          ...(update.packageName ? { packageName: update.packageName } : {}),
        });
        continue;
      }
      const binPath = resolveBin(cfg.cliPathOverride);
      const custom = !!cfg.cliPathOverride?.trim();
      targets.push({
        cliId: 'codex',
        runtimeId: custom ? basename(cfg.cliPathOverride!.trim()) : 'codex',
        displayName: custom ? basename(cfg.cliPathOverride!.trim()) : 'Codex',
        binPath,
        provider: custom ? 'auto' : 'internal',
      });
    } catch {
      // A stale path for one bot must not prevent checks for other bots.
    }
  }
  return dedupeCandidates(targets);
}

/** One audit pass. Each runtime+binary has its own TTL and notification
 * watermark. A successful unmanaged probe clears any stale latest version;
 * only a failed probe retains the last-known status. */
export async function runCliRuntimeUpdateAudit(deps: CliRuntimeUpdateAuditDeps): Promise<void> {
  const now = deps.now();
  const log = deps.log ?? (() => {});
  const store = deps.readStore();
  const resolveAutoPackage = deps.resolveAutoPackage ?? resolveNpmPackageForExecutable;
  // Old stores may contain an auto-generated `npm install -g` suggestion.
  // Remove it before TTL decisions so upgrading botmux fixes the visible state
  // immediately without forcing a network probe.
  let storeChanged = (store as CliRuntimeUpdateStoreWithMigration)[STORE_NEEDS_REWRITE] === true;
  for (const entry of Object.values(store.entries)) {
    if (entry.provider !== 'auto' || entry.updateCommand === null) continue;
    entry.updateCommand = null;
    storeChanged = true;
  }
  // Local ownership is intentionally refreshed on every hourly tick, before
  // the 24h network TTL. This makes a symlink/package switch a new update source
  // immediately instead of inheriting stale latest/command/notification state.
  const refreshedTargets = deps.targets().map((target) => (
    refreshAutoTargetProvenance(target, resolveAutoPackage)
  ));
  const targets = dedupeTargets(refreshedTargets);
  const configuredKeys = new Set(targets.map(targetKey));
  /** 已拿到更新内容并成功发卡后才推进水位；失败会在下个小时继续尝试。 */
  const notifyPending = async (key: string, entry: CliRuntimeUpdateEntry): Promise<void> => {
    if (!entry.updateAvailable || !entry.latest || entry.lastNotifiedVersion === entry.latest || !deps.notify) return;
    try {
      await deps.notify(entry);
      entry.lastNotifiedVersion = entry.latest;
      store.entries[key] = entry;
      deps.writeStore(store);
      log(`owner notified for ${entry.binPath}: ${entry.current} → ${entry.latest}`);
    } catch (error) {
      log(`owner notification failed for ${entry.binPath}: ${error instanceof Error ? error.message : error}`);
    }
  };
  let pruned = false;
  for (const key of Object.keys(store.entries)) {
    if (configuredKeys.has(key)) continue;
    delete store.entries[key];
    pruned = true;
  }
  if (pruned || storeChanged) deps.writeStore(store);

  for (const target of targets) {
    const key = targetKey(target);
    const previous = store.entries[key];
    const sourceFingerprint = updateSourceFingerprint(target.provider, target.packageName);
    const previousSourceFingerprint = previous
      ? previous.sourceFingerprint
        ?? updateSourceFingerprint(previous.provider, previous.packageName)
      : undefined;
    const sameSource = previousSourceFingerprint === sourceFingerprint;
    if (previous && sameSource && now - previous.lastCheckedAt < CLI_RUNTIME_UPDATE_CHECK_INTERVAL_MS) {
      await notifyPending(key, previous);
      continue;
    }
    // Status and notification watermarks belong to one exact provider/package.
    // A source edit must start clean even when its first probe fails.
    const reusablePrevious = sameSource ? previous : undefined;

    let next: CliRuntimeUpdateEntry;
    try {
      const result = await deps.probe(target);
      if (target.provider === 'auto') {
        if (result.packageName !== undefined && result.packageName !== target.packageName) {
          throw new Error(`auto npm provenance changed while probing ${target.displayName}`);
        }
        if (result.managed && !target.packageName) {
          throw new Error(`auto npm provenance missing while probing ${target.displayName}`);
        }
      }
      next = {
        cliId: 'codex',
        runtimeId: target.runtimeId,
        displayName: target.displayName,
        binPath: target.binPath,
        provider: target.provider,
        ...(target.packageName ? { packageName: target.packageName } : {}),
        sourceFingerprint,
        managed: result.managed,
        current: result.current,
        latest: result.latest,
        updateAvailable: !!result.latest && isNewerVersion(result.latest, result.current),
        updateCommand: target.provider === 'auto' ? null : result.updateCommand,
        ...(result.installTarget ? { installTarget: result.installTarget } : {}),
        lastCheckedAt: now,
        ...(reusablePrevious?.lastNotifiedVersion ? { lastNotifiedVersion: reusablePrevious.lastNotifiedVersion } : {}),
      };
      log(`checked ${target.displayName} (${target.binPath}): ${result.current}${result.latest ? ` → ${result.latest}` : result.managed ? ' (latest unavailable)' : ' (unmanaged)'}`);
    } catch (error) {
      next = {
        cliId: 'codex',
        runtimeId: target.runtimeId,
        displayName: target.displayName,
        binPath: target.binPath,
        provider: target.provider,
        ...(target.packageName ? { packageName: target.packageName } : {}),
        sourceFingerprint,
        managed: reusablePrevious?.managed ?? (target.provider === 'internal' || target.provider === 'npm'),
        current: reusablePrevious?.current ?? null,
        latest: reusablePrevious?.latest ?? null,
        updateAvailable: reusablePrevious?.updateAvailable ?? false,
        updateCommand: reusablePrevious?.updateCommand ?? null,
        ...(reusablePrevious?.installTarget ? { installTarget: reusablePrevious.installTarget } : {}),
        lastCheckedAt: now,
        ...(reusablePrevious?.lastNotifiedVersion ? { lastNotifiedVersion: reusablePrevious.lastNotifiedVersion } : {}),
      };
      log(`check failed for ${target.displayName} (${target.binPath}): ${error instanceof Error ? error.message : error}`);
    }
    store.entries[key] = next;
    deps.writeStore(store);
    await notifyPending(key, next);
  }
}

function inlineCode(value: string): string {
  return value.replace(/`/g, "'");
}

/** Escape runtime-controlled text before interpolating it into Lark Markdown. */
function escapeLarkMarkdown(value: string): string {
  return value.replace(/[*_~`\[\]\\<>]/g, (char) => `\\${char}`);
}

export function buildCliRuntimeUpdateCard(
  entry: CliRuntimeUpdateEntry,
  opts: { dashboardUrl?: string; locale?: Locale; releaseNotes?: CodexReleaseNotes } = {},
): string {
  const locale = opts.locale;
  const markdownDisplayName = escapeLarkMarkdown(entry.displayName);
  const lines = [
    t('cli_update.available', { cli: markdownDisplayName }, locale),
    t('cli_update.version_delta', { current: entry.current ?? '?', latest: entry.latest ?? '?' }, locale),
    t('cli_update.binary', { path: `\`${inlineCode(entry.binPath)}\`` }, locale),
  ];
  if (opts.releaseNotes) {
    lines.push(t('cli_update.release_notes', undefined, locale));
    lines.push(opts.releaseNotes.summary);
    lines.push(t('cli_update.release_details', { url: opts.releaseNotes.url }, locale));
  }
  if (entry.installTarget) lines.push(t('cli_update.install_target', { path: `\`${inlineCode(entry.installTarget)}\`` }, locale));
  if (entry.updateCommand) lines.push(t('cli_update.command', { command: `\`${inlineCode(entry.updateCommand)}\`` }, locale));
  lines.push(t('cli_update.manual_only', undefined, locale));
  if (opts.dashboardUrl) lines.push(t('cli_update.dashboard', { url: opts.dashboardUrl }, locale));
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      // A plain-text field does not parse Markdown; keep the user-facing name
      // byte-for-byte instead of exposing Markdown escape backslashes.
      title: { tag: 'plain_text', content: t('cli_update.card_title', { cli: entry.displayName }, locale) },
    },
    elements: [{ tag: 'markdown', content: lines.join('\n') }],
  });
}

let monitorTimer: NodeJS.Timeout | undefined;
let initialTimer: NodeJS.Timeout | undefined;
let monitorInFlight = false;

/** Start the host monitor. Call only in the primary daemon. */
export function startCliRuntimeUpdateMonitor(wiring: CliRuntimeUpdateMonitorWiring): void {
  if (monitorTimer || initialTimer) return;
  const log = wiring.log ?? (() => {});
  const tick = async () => {
    if (monitorInFlight) return;
    monitorInFlight = true;
    try {
      await runCliRuntimeUpdateAudit({
        now: () => Date.now(),
        targets: wiring.targets,
        readStore: () => readCliRuntimeUpdateStoreFrom(wiring.dataDir),
        writeStore: (store) => writeCliRuntimeUpdateStoreTo(wiring.dataDir, store),
        probe: (target) => probeCliRuntimeUpdate(target),
        notify: async (entry) => {
          const owner = wiring.ownerOpenId();
          if (!owner) throw new Error('no primary owner configured');
          if (!entry.latest) throw new Error('latest version unavailable');
          const releaseNotes = await fetchCodexReleaseNotes(entry.latest);
          if (!releaseNotes) throw new Error(`release notes unavailable for ${entry.latest}`);
          const card = buildCliRuntimeUpdateCard(entry, {
            dashboardUrl: wiring.dashboardUrl?.(),
            locale: localeForBot(wiring.primaryLarkAppId),
            releaseNotes,
          });
          await wiring.sendCard(owner, card);
        },
        log,
      });
    } catch (error) {
      log(`audit failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      monitorInFlight = false;
    }
  };
  initialTimer = setTimeout(() => {
    initialTimer = undefined;
    void tick();
  }, CLI_RUNTIME_UPDATE_INITIAL_DELAY_MS);
  initialTimer.unref?.();
  monitorTimer = setInterval(() => { void tick(); }, CLI_RUNTIME_UPDATE_TICK_MS);
  monitorTimer.unref?.();
  log('timer started (primary daemon, read-only daily audit)');
}

export function stopCliRuntimeUpdateMonitor(): void {
  if (initialTimer) clearTimeout(initialTimer);
  if (monitorTimer) clearInterval(monitorTimer);
  initialTimer = undefined;
  monitorTimer = undefined;
  monitorInFlight = false;
}
