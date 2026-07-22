/**
 * Host-side CLI runtime update monitor.
 *
 * Botmux-managed Codex sessions suppress the interactive startup update picker;
 * this monitor replaces it with a read-only, once-per-day host probe. It never
 * installs anything. The primary daemon persists the latest status for the
 * dashboard and privately notifies the owner once for each newly-seen version.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { dirname, join } from 'node:path';
import { ProxyAgent } from 'proxy-agent';
import { isNewerVersion, parseVersion } from './update-check.js';
import { githubAuthHeaders } from './github-auth.js';
import { localeForBot, t, type Locale } from '../i18n/index.js';

export const CLI_RUNTIME_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const CLI_RUNTIME_UPDATE_TICK_MS = 60 * 60 * 1_000;
export const CLI_RUNTIME_UPDATE_INITIAL_DELAY_MS = 20_000;

export interface CliRuntimeUpdateTarget {
  cliId: 'codex';
  binPath: string;
}

export interface ConfiguredCliRuntime {
  cliId: string;
  cliPathOverride?: string;
  wrapperCli?: string;
}

export interface CliRuntimeUpdateEntry {
  cliId: 'codex';
  binPath: string;
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  updateCommand: string;
  installTarget?: string;
  lastCheckedAt: number;
  lastNotifiedVersion?: string;
}

export interface CliRuntimeUpdateStore {
  entries: Record<string, CliRuntimeUpdateEntry>;
}

export interface CodexUpdateProbeResult {
  current: string;
  latest: string | null;
  updateCommand: string;
  installTarget?: string;
}

export interface CodexUpdateProbeDeps {
  runFile?: (bin: string, args: string[], timeoutMs: number) => Promise<string>;
  fetchLatest?: () => Promise<string | null>;
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
  probe: (target: CliRuntimeUpdateTarget) => Promise<CodexUpdateProbeResult>;
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

export function cliRuntimeUpdateStorePathIn(dataDir: string): string {
  return join(dataDir, STORE_FILE);
}

function validEntry(raw: unknown): CliRuntimeUpdateEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (v.cliId !== 'codex' || typeof v.binPath !== 'string' || !v.binPath) return null;
  if (typeof v.lastCheckedAt !== 'number' || !Number.isFinite(v.lastCheckedAt)) return null;
  const current = typeof v.current === 'string' && parseVersion(v.current) ? v.current : null;
  const latest = typeof v.latest === 'string' && parseVersion(v.latest) ? v.latest : null;
  const updateCommand = typeof v.updateCommand === 'string' && v.updateCommand.trim()
    ? v.updateCommand.trim()
    : 'codex update';
  return {
    cliId: 'codex',
    binPath: v.binPath,
    current,
    latest,
    updateAvailable: !!current && !!latest && isNewerVersion(latest, current),
    updateCommand,
    ...(typeof v.installTarget === 'string' && v.installTarget ? { installTarget: v.installTarget } : {}),
    lastCheckedAt: v.lastCheckedAt,
    ...(typeof v.lastNotifiedVersion === 'string' && parseVersion(v.lastNotifiedVersion)
      ? { lastNotifiedVersion: v.lastNotifiedVersion }
      : {}),
  };
}

export function readCliRuntimeUpdateStoreFrom(dataDir: string): CliRuntimeUpdateStore {
  const path = cliRuntimeUpdateStorePathIn(dataDir);
  if (!existsSync(path)) return { entries: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { entries?: unknown };
    if (!raw?.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) return { entries: {} };
    const entries: Record<string, CliRuntimeUpdateEntry> = {};
    for (const [key, value] of Object.entries(raw.entries as Record<string, unknown>)) {
      const entry = validEntry(value);
      if (entry) entries[key] = entry;
    }
    return { entries };
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
    .sort((a, b) => a.binPath.localeCompare(b.binPath));
}

function execFileText(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      const output = String(stdout ?? '').trim();
      // `codex doctor` exits non-zero when any unrelated health check fails
      // (for example an optional MCP endpoint), but its JSON report — including
      // installation/update details — is still complete and useful.
      if (error && !(args[0] === 'doctor' && args.includes('--json') && output.startsWith('{'))) reject(error);
      else resolve(output);
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

async function fetchLatestCodexVersion(): Promise<string | null> {
  try {
    const response = await fetch('https://registry.npmjs.org/@openai%2fcodex/latest', {
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

/** Read-only probe. `codex doctor --json` supplies install provenance; the npm
 * registry is a fallback when the doctor is unavailable or its network probe
 * failed. No update command is executed. */
export async function probeCodexRuntimeUpdate(
  target: CliRuntimeUpdateTarget,
  deps: CodexUpdateProbeDeps = {},
): Promise<CodexUpdateProbeResult> {
  const runFile = deps.runFile ?? execFileText;
  const fetchLatest = deps.fetchLatest ?? fetchLatestCodexVersion;
  const versionOutput = await runFile(target.binPath, ['--version'], 5_000);
  let current = versionFromText(versionOutput);
  if (!current) throw new Error(`unrecognised Codex version output: ${versionOutput.slice(0, 120)}`);

  let probedLatest: string | null = null;
  let cachedLatest: string | null = null;
  let updateCommand = 'codex update';
  let installTarget: string | undefined;
  try {
    const details = doctorUpdateDetails(await runFile(target.binPath, ['doctor', '--json'], 12_000));
    current = details.current ?? current;
    probedLatest = details.probedLatest;
    cachedLatest = details.cachedLatest;
    updateCommand = details.updateCommand ?? updateCommand;
    installTarget = details.installTarget;
  } catch {
    // Older Codex builds have no machine-readable doctor. Registry fallback
    // below still gives a useful notification without scraping the TUI.
  }

  const registryLatest = probedLatest ? null : await fetchLatest();
  const latest = probedLatest ?? registryLatest ?? cachedLatest;
  return {
    current,
    latest,
    updateCommand,
    ...(installTarget ? { installTarget } : {}),
  };
}

function targetKey(target: CliRuntimeUpdateTarget): string {
  return `${target.cliId}:${target.binPath}`;
}

function dedupeTargets(targets: CliRuntimeUpdateTarget[]): CliRuntimeUpdateTarget[] {
  const seen = new Set<string>();
  const out: CliRuntimeUpdateTarget[] = [];
  for (const target of targets) {
    const key = targetKey(target);
    if (!target.binPath || seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

/** Resolve every host Codex runtime configured across bot processes. Wrapper
 * launchers may add their own flags, but a read-only probe of the configured
 * underlying binary remains useful and never mutates either runtime. */
export function selectCodexRuntimeUpdateTargets(
  configs: ConfiguredCliRuntime[],
  resolveBin: (cliPathOverride?: string) => string,
): CliRuntimeUpdateTarget[] {
  const targets: CliRuntimeUpdateTarget[] = [];
  for (const cfg of configs) {
    if (cfg.cliId !== 'codex' && cfg.cliId !== 'codex-app') continue;
    try {
      targets.push({ cliId: 'codex', binPath: resolveBin(cfg.cliPathOverride) });
    } catch {
      // A stale path for one bot must not prevent checks for the other bots.
    }
  }
  return dedupeTargets(targets);
}

/** One audit pass. Each resolved binary has its own 24h TTL and notification
 * watermark, so multiple fnm/npm installs neither spam nor hide one another. */
export async function runCliRuntimeUpdateAudit(deps: CliRuntimeUpdateAuditDeps): Promise<void> {
  const now = deps.now();
  const log = deps.log ?? (() => {});
  const store = deps.readStore();
  const targets = dedupeTargets(deps.targets());
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
  if (pruned) deps.writeStore(store);

  for (const target of targets) {
    const key = targetKey(target);
    const previous = store.entries[key];
    if (previous && now - previous.lastCheckedAt < CLI_RUNTIME_UPDATE_CHECK_INTERVAL_MS) {
      await notifyPending(key, previous);
      continue;
    }

    let next: CliRuntimeUpdateEntry;
    try {
      const result = await deps.probe(target);
      const latest = result.latest ?? previous?.latest ?? null;
      next = {
        cliId: 'codex',
        binPath: target.binPath,
        current: result.current,
        latest,
        updateAvailable: !!latest && isNewerVersion(latest, result.current),
        updateCommand: result.updateCommand,
        ...(result.installTarget ? { installTarget: result.installTarget } : {}),
        lastCheckedAt: now,
        ...(previous?.lastNotifiedVersion ? { lastNotifiedVersion: previous.lastNotifiedVersion } : {}),
      };
      log(`checked ${target.binPath}: ${result.current}${latest ? ` → ${latest}` : ' (latest unavailable)'}`);
    } catch (error) {
      next = {
        cliId: 'codex',
        binPath: target.binPath,
        current: previous?.current ?? null,
        latest: previous?.latest ?? null,
        updateAvailable: previous?.updateAvailable ?? false,
        updateCommand: previous?.updateCommand ?? 'codex update',
        ...(previous?.installTarget ? { installTarget: previous.installTarget } : {}),
        lastCheckedAt: now,
        ...(previous?.lastNotifiedVersion ? { lastNotifiedVersion: previous.lastNotifiedVersion } : {}),
      };
      log(`check failed for ${target.binPath}: ${error instanceof Error ? error.message : error}`);
    }
    store.entries[key] = next;
    deps.writeStore(store);
    await notifyPending(key, next);
  }
}

function inlineCode(value: string): string {
  return value.replace(/`/g, "'");
}

export function buildCliRuntimeUpdateCard(
  entry: CliRuntimeUpdateEntry,
  opts: { dashboardUrl?: string; locale?: Locale; releaseNotes?: CodexReleaseNotes } = {},
): string {
  const locale = opts.locale;
  const lines = [
    t('cli_update.available', { cli: 'Codex' }, locale),
    t('cli_update.version_delta', { current: entry.current ?? '?', latest: entry.latest ?? '?' }, locale),
    t('cli_update.binary', { path: `\`${inlineCode(entry.binPath)}\`` }, locale),
  ];
  if (opts.releaseNotes) {
    lines.push(t('cli_update.release_notes', undefined, locale));
    lines.push(opts.releaseNotes.summary);
    lines.push(t('cli_update.release_details', { url: opts.releaseNotes.url }, locale));
  }
  if (entry.installTarget) lines.push(t('cli_update.install_target', { path: `\`${inlineCode(entry.installTarget)}\`` }, locale));
  lines.push(t('cli_update.command', { command: `\`${inlineCode(entry.updateCommand)}\`` }, locale));
  lines.push(t('cli_update.manual_only', undefined, locale));
  if (opts.dashboardUrl) lines.push(t('cli_update.dashboard', { url: opts.dashboardUrl }, locale));
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: t('cli_update.card_title', { cli: 'Codex' }, locale) },
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
        probe: (target) => probeCodexRuntimeUpdate(target),
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
