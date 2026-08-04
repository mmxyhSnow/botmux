/**
 * Restart-report DM: after an *intentional* restart (manual /
 * auto-update), the primary daemon (bot-0) privately messages the owner a
 * summary — dashboard link, unfinished-session count, version, and (for an
 * update) the changelog. This replaces re-posting streaming cards into the
 * groups on restart (those stay silent now). See core/maintenance.ts and the
 * daemon startup wiring.
 */
import { githubAuthHeaders, type GithubAuthResolveOptions } from './github-auth.js';
import type { CodexAppProgressOverview } from '../types.js';
import type {
  RestartKind,
  RestartSource,
  SourceDeploymentIntent,
} from '../services/restart-intent-store.js';
import { consumeRestartIntent } from '../services/restart-intent-store.js';
import { countActiveSessionsOnDisk } from '../services/session-store.js';
import { resolveLiveIdentity } from '../utils/live-identity.js';
import { t, localeForBot, type Locale } from '../i18n/index.js';

export const GITHUB_REPO = 'deepcoldy/botmux';

export interface RestartReportInput {
  kind: RestartKind;
  /** Current (post-restart) botmux version. */
  version: string;
  /** Unfinished sessions across all bots. */
  sessionCount: number;
  dashboardUrl?: string;
  /** Local host:port direct link — set only when `dashboardUrl` routes through
   *  the central platform, so the owner can still reach the dashboard if the
   *  platform is down. */
  dashboardLocalUrl?: string;
  /** Version delta for update/rollback; changelog is update-only. */
  oldVersion?: string;
  newVersion?: string;
  /** 发起维护时记录的具体原因。 */
  reason?: string;
  /** 手动维护的真实触发入口。 */
  source?: RestartSource;
  /** 官方源码同步在本次新 daemon 中完成的部署留痕结果。 */
  sourceDeployment?: { releaseTag: string; deployTag?: string; error?: string };
  changelog?: string;
}

function vtag(v: string): string {
  return v.startsWith('v') ? v : `v${v}`;
}

/** 将与待恢复轮次精确匹配的结构化进度压成可读摘要。 */
export function buildRestartTurnProgressText(
  overview: CodexAppProgressOverview,
  locale?: Locale,
): string {
  const lines = [
    t('restart.turn_progress_stage', { value: overview.stage }, locale),
    t('restart.turn_progress_current', { value: overview.current }, locale),
  ];
  if (overview.completed.length > 0) {
    lines.push(t('restart.turn_progress_completed', {
      value: overview.completed.join('；'),
    }, locale));
  }
  if (overview.evidence?.length) {
    lines.push(t('restart.turn_progress_evidence', {
      value: overview.evidence.join('；'),
    }, locale));
  }
  if (overview.delivery?.length) {
    lines.push(t('restart.turn_progress_delivery', {
      value: overview.delivery.join('；'),
    }, locale));
  }
  if (overview.blocker) {
    lines.push(t('restart.turn_progress_blocker', { value: overview.blocker }, locale));
  }
  lines.push(t('restart.turn_progress_next', { value: overview.next }, locale));
  return lines.join('\n');
}

/** The human-facing markdown body of the report. Pure — unit tested. */
export function buildRestartReportText(input: RestartReportInput, locale?: Locale): string {
  const lines: string[] = [];
  lines.push(input.kind === 'update'
    ? t('restart.updated_restarted', undefined, locale)
    : input.kind === 'rollback'
      ? t('restart.rolled_back_restarted', undefined, locale)
      : t('restart.restarted', undefined, locale));

  const reasonKey = input.kind === 'manual' && input.source
    ? `restart.reason_${input.source}`
    : `restart.reason_${input.kind}`;
  const reason = input.reason?.trim() || t(reasonKey, undefined, locale);
  lines.push(t('restart.reason', { reason }, locale));

  if (input.kind !== 'manual' && input.oldVersion && input.newVersion) {
    lines.push(t('restart.version_delta', { old: vtag(input.oldVersion), new: vtag(input.newVersion) }, locale));
  } else {
    lines.push(t('restart.version', { version: vtag(input.version) }, locale));
  }

  lines.push(t('restart.unfinished_sessions', { count: input.sessionCount }, locale));
  if (input.dashboardUrl) lines.push(t('restart.dashboard', { url: input.dashboardUrl }, locale));
  if (input.dashboardLocalUrl) lines.push(t('restart.dashboard_local', { url: input.dashboardLocalUrl }, locale));
  if (input.sourceDeployment?.deployTag) {
    lines.push(t('restart.source_deploy_succeeded', { tag: input.sourceDeployment.deployTag }, locale));
  } else if (input.sourceDeployment?.error) {
    lines.push(t('restart.source_deploy_failed', { error: input.sourceDeployment.error }, locale));
  }

  if (input.kind === 'update' && input.changelog && input.changelog.trim()) {
    lines.push('');
    lines.push(t('restart.changelog_label', undefined, locale));
    lines.push(input.changelog.trim());
  }
  return lines.join('\n');
}

/** Wrap the report body in a minimal Lark interactive card (JSON string). */
export function buildRestartReportCard(input: RestartReportInput, locale?: Locale): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: input.kind === 'update' ? 'green' : input.kind === 'rollback' ? 'orange' : 'blue',
      title: { tag: 'plain_text', content: t('restart.card_title', undefined, locale) },
    },
    elements: [{ tag: 'markdown', content: buildRestartReportText(input, locale) }],
  });
}

export function releasesUrl(version: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/tag/${vtag(version)}`;
}

export interface RestartReportWiring {
  /** Primary bot (bot-0) app id — the DM sender. */
  primaryLarkAppId: string;
  /** Owner to DM (bot-0's first resolved allowedUser); undefined → skip the DM. */
  ownerOpenId: string | undefined;
  dashboardUrl: string | undefined;
  /** Local host:port direct fallback link (set only when dashboardUrl is a
   *  central-platform link). */
  dashboardLocalUrl?: string | undefined;
  /** Send the interactive card as a p2p DM to the owner. */
  sendCard: (openId: string, cardJson: string) => Promise<void>;
  /** 生产 wiring 通过已登记的 owner 通知策略投递；测试或旧调用可继续只提供 sendCard。 */
  deliverCard?: (openId: string, cardJson: string) => Promise<void>;
  /** 源码同步重启后的运行态验收；缺省时明确告警且不创建 deploy 标签。 */
  finalizeSourceDeployment?: (intent: SourceDeploymentIntent) => Promise<{ deployTag: string }>;
  githubAuth?: GithubAuthResolveOptions;
  now?: number;
  log?: (msg: string) => void;
}

/**
 * If an intentional-restart breadcrumb is pending, DM the owner a restart
 * summary (exactly once — the breadcrumb is consumed). A crash / pm2
 * auto-restart leaves no breadcrumb, so this stays silent. Call only on the
 * primary daemon after sessions are restored.
 */
export async function sendRestartReportIfPending(w: RestartReportWiring): Promise<void> {
  const log = w.log ?? (() => {});
  const intent = consumeRestartIntent(w.now ?? Date.now());
  if (!intent) return; // no breadcrumb → crash/reboot → stay silent
  let sourceDeployment: RestartReportInput['sourceDeployment'];
  if (intent.sourceDeployment) {
    try {
      if (!w.finalizeSourceDeployment) throw new Error('source deployment finalizer unavailable');
      const finalized = await w.finalizeSourceDeployment(intent.sourceDeployment);
      sourceDeployment = { releaseTag: intent.sourceDeployment.releaseTag, deployTag: finalized.deployTag };
      log(`source deployment finalized (${finalized.deployTag})`);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);
      sourceDeployment = { releaseTag: intent.sourceDeployment.releaseTag, error: message };
      log(`source deployment finalization failed: ${message}`);
    }
  }
  if (!w.ownerOpenId) { log('restart-report: no owner configured — skipping DM'); return; }

  const locale = localeForBot(w.primaryLarkAppId);
  const sessionCount = countActiveSessionsOnDisk();
  const version = resolveLiveIdentity().display;
  let changelog: string | undefined;
  if (intent.kind === 'update' && intent.newVersion) {
    changelog = (await fetchChangelog(intent.newVersion, { auth: w.githubAuth }))
      ?? t('restart.changelog_link_fallback', { url: releasesUrl(intent.newVersion) }, locale);
  }
  const card = buildRestartReportCard({
    kind: intent.kind,
    version,
    sessionCount,
    dashboardUrl: w.dashboardUrl,
    dashboardLocalUrl: w.dashboardLocalUrl,
    oldVersion: intent.oldVersion,
    newVersion: intent.newVersion,
    reason: intent.reason,
    source: intent.source,
    sourceDeployment,
    changelog,
  }, locale);
  try {
    await (w.deliverCard ?? w.sendCard)(w.ownerOpenId, card);
    log(`restart-report sent (kind=${intent.kind}, sessions=${sessionCount})`);
  } catch (e) {
    log(`restart-report send failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Best-effort GitHub release notes for a version. null on any failure (offline,
 *  rate-limited, release not yet published) — caller falls back to a link. */
export async function fetchChangelog(
  newVersion: string,
  opts?: { auth?: GithubAuthResolveOptions; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<string | null> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${vtag(newVersion)}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'botmux',
        ...githubAuthHeaders(opts?.auth),
      },
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 8_000),
    });
    if (!res.ok) return null;
    const body = await res.json() as { body?: string };
    const notes = (body?.body ?? '').trim();
    return notes || null;
  } catch {
    return null;
  }
}
