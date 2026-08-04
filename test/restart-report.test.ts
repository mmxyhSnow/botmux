import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countActiveSessionsOnDisk } from '../src/services/session-store.js';
import {
  buildRestartReportText,
  buildRestartTurnProgressText,
  sendRestartReportIfPending,
  fetchChangelog,
} from '../src/core/restart-report.js';
import { writeRestartIntentTo, restartIntentPathIn } from '../src/services/restart-intent-store.js';

function writeSessions(dir: string, name: string, sessions: Record<string, { status: string }>) {
  writeFileSync(join(dir, name), JSON.stringify(sessions));
}

describe('countActiveSessionsOnDisk', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-sess-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('counts active sessions across all bots’ session files', () => {
    writeSessions(dir, 'sessions-cli_a.json', { s1: { status: 'active' }, s2: { status: 'closed' }, s3: { status: 'active' } });
    writeSessions(dir, 'sessions-cli_b.json', { s4: { status: 'active' } });
    writeSessions(dir, 'sessions.json', { s5: { status: 'active' }, s6: { status: 'closed' } });
    expect(countActiveSessionsOnDisk(dir)).toBe(4);
  });

  it('returns 0 for an empty / missing data dir', () => {
    expect(countActiveSessionsOnDisk(dir)).toBe(0);
    expect(countActiveSessionsOnDisk(join(dir, 'nope'))).toBe(0);
  });

  it('ignores non-session files and corrupt session files', () => {
    writeSessions(dir, 'sessions-cli_a.json', { s1: { status: 'active' } });
    writeFileSync(join(dir, 'schedules.json'), JSON.stringify({ x: { status: 'active' } })); // not a session file
    writeFileSync(join(dir, 'sessions-bad.json'), '{corrupt');
    expect(countActiveSessionsOnDisk(dir)).toBe(1);
  });
});

describe('buildRestartReportText', () => {
  it('renders persisted structured progress for restart recovery', () => {
    const progress = buildRestartTurnProgressText({
      stage: '运行态切换',
      current: '切换生产进程',
      completed: ['完成合入', '完成构建与推送'],
      next: '核对进程状态',
      evidence: ['commit abc123'],
      delivery: ['origin/custom/prod'],
    });
    expect(progress).toContain('阶段：运行态切换');
    expect(progress).toContain('当前：切换生产进程');
    expect(progress).toContain('已完成：完成合入；完成构建与推送');
    expect(progress).toContain('验证：commit abc123');
    expect(progress).toContain('交付：origin/custom/prod');
    expect(progress).toContain('下一步：核对进程状态');
  });

  it('plain CLI restart: version + session count + neutral source, no changelog', () => {
    const md = buildRestartReportText({
      kind: 'manual',
      version: '2.65.0',
      sessionCount: 3,
      dashboardUrl: 'http://10.0.0.1:7891/?t=abc',
    });
    expect(md).toContain('2.65.0');
    expect(md).toContain('3');
    expect(md).toContain('http://10.0.0.1:7891/?t=abc');
    expect(md).toContain('维护原因：通过 CLI 触发服务重启');
    expect(md).not.toContain('管理员');
    expect(md.toLowerCase()).not.toContain('changelog');
  });

  it('shows AI attribution when the restart caller declares the AI source', () => {
    const md = buildRestartReportText({
      kind: 'manual',
      source: 'ai',
      version: '3.7.1',
      sessionCount: 50,
    });
    expect(md).toContain('维护原因：AI 按用户授权执行服务重启');
    expect(md).not.toContain('管理员');
  });

  it('shows Dashboard attribution for dashboard-triggered restarts', () => {
    const md = buildRestartReportText({
      kind: 'manual',
      source: 'dashboard',
      version: '3.7.1',
      sessionCount: 50,
    });
    expect(md).toContain('维护原因：通过 Dashboard 触发服务重启');
  });

  it('shows the concrete maintenance reason when the restart caller provides one', () => {
    const md = buildRestartReportText({
      kind: 'manual',
      version: '3.7.1',
      sessionCount: 36,
      reason: '上线维护通知卡片的原因说明',
    });
    expect(md).toContain('维护原因：上线维护通知卡片的原因说明');
    expect(md).not.toContain('维护原因：管理员手动重启服务');
  });

  it('adds a local ip:port fallback line when the dashboard link is a platform URL', () => {
    const md = buildRestartReportText({
      kind: 'manual',
      version: '2.65.0',
      sessionCount: 0,
      dashboardUrl: 'https://m-deadbeef.example/?t=tok',
      dashboardLocalUrl: 'http://10.0.0.1:7891/?t=tok',
    });
    expect(md).toContain('https://m-deadbeef.example/?t=tok'); // platform primary
    expect(md).toContain('http://10.0.0.1:7891/?t=tok');       // local fallback
  });

  it('omits the local fallback line when there is no platform URL (local-only host)', () => {
    const md = buildRestartReportText({
      kind: 'manual',
      version: '2.65.0',
      sessionCount: 0,
      dashboardUrl: 'http://10.0.0.1:7891/?t=tok',
    });
    // Only the single dashboard line — no separate "本地直连 / Local direct" line.
    expect(md).not.toMatch(/本地直连|Local direct/);
  });

  it('update restart: shows old→new and the changelog body', () => {
    const md = buildRestartReportText({
      kind: 'update',
      version: '2.65.0',
      sessionCount: 0,
      dashboardUrl: 'http://h/?t=x',
      oldVersion: '2.64.0',
      newVersion: '2.65.0',
      changelog: '- 修复了 X\n- 新增 Y',
    });
    expect(md).toContain('2.64.0');
    expect(md).toContain('2.65.0');
    expect(md).toContain('维护原因：已安装新版本，重启以应用更新');
    expect(md).toContain('修复了 X');
    expect(md).toContain('新增 Y');
  });

  it('update with no changelog text still reports the version delta gracefully', () => {
    const md = buildRestartReportText({
      kind: 'update',
      version: '2.65.0',
      sessionCount: 1,
      oldVersion: '2.64.0',
      newVersion: '2.65.0',
    });
    expect(md).toContain('2.64.0');
    expect(md).toContain('2.65.0');
  });

  it('shows post-restart source deployment success or failure explicitly', () => {
    const succeeded = buildRestartReportText({
      kind: 'update',
      version: '3.8.0-custom.1',
      sessionCount: 0,
      sourceDeployment: {
        releaseTag: 'release/v3.8.0-custom.1',
        deployTag: 'deploy/v3.8.0-custom.1',
      },
    });
    const failed = buildRestartReportText({
      kind: 'update',
      version: '3.8.0-custom.1',
      sessionCount: 0,
      sourceDeployment: {
        releaseTag: 'release/v3.8.0-custom.1',
        error: '运行 HEAD 不一致',
      },
    });
    expect(succeeded).toContain('部署留痕：deploy/v3.8.0-custom.1');
    expect(failed).toContain('未创建 deploy 标签');
    expect(failed).toContain('运行 HEAD 不一致');
  });

  it('rollback restart reports the old→new delta without a changelog', () => {
    const md = buildRestartReportText({
      kind: 'rollback',
      version: '3.0.0',
      sessionCount: 0,
      oldVersion: '3.1.0',
      newVersion: '3.0.0',
      changelog: 'must not be shown',
    });
    expect(md).toContain('已回退并重启');
    expect(md).toContain('维护原因：已回退版本，重启以应用目标版本');
    expect(md).toContain('3.1.0');
    expect(md).toContain('3.0.0');
    expect(md).not.toContain('must not be shown');
  });
});

describe('sendRestartReportIfPending', () => {
  const T0 = Date.parse('2026-06-07T04:00:00.000Z');
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-report-'));
    vi.stubEnv('SESSION_DATA_DIR', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeWiring(over: Partial<Parameters<typeof sendRestartReportIfPending>[0]> = {}) {
    const sent: Array<{ openId: string; card: string }> = [];
    const w = {
      primaryLarkAppId: 'cli_primary',
      ownerOpenId: 'ou_owner' as string | undefined,
      dashboardUrl: 'http://10.0.0.1:7891/?t=tok',
      sendCard: async (openId: string, card: string) => { sent.push({ openId, card }); },
      now: T0 + 5_000,
      log: () => {},
      ...over,
    };
    return { w, sent };
  }

  it('consumes a fresh intent and DMs the owner a card with the session count + dashboard link', async () => {
    writeRestartIntentTo(dir, {
      kind: 'manual',
      reason: '部署维护通知卡片增强',
      at: new Date(T0).toISOString(),
    });
    writeFileSync(join(dir, 'sessions-cli_primary.json'), JSON.stringify({ s1: { status: 'active' }, s2: { status: 'active' } }));
    const { w, sent } = fakeWiring();

    await sendRestartReportIfPending(w);

    expect(sent).toHaveLength(1);
    expect(sent[0].openId).toBe('ou_owner');
    expect(sent[0].card).toContain('http://10.0.0.1:7891/?t=tok');
    expect(sent[0].card).toContain('部署维护通知卡片增强');
    expect(sent[0].card).toContain('2'); // two active sessions
    expect(existsSync(restartIntentPathIn(dir))).toBe(false); // consumed
  });

  it('finalizes a source deployment before sending the restart report', async () => {
    const sourceDeployment = {
      releaseTag: 'release/v3.8.0-custom.1',
      expectedHead: 'a'.repeat(40),
    };
    writeRestartIntentTo(dir, {
      kind: 'update',
      oldVersion: '3.7.1',
      newVersion: '3.8.0',
      sourceDeployment,
      at: new Date(T0).toISOString(),
    });
    const finalizeSourceDeployment = vi.fn(async () => ({ deployTag: 'deploy/v3.8.0-custom.1' }));
    const { w, sent } = fakeWiring({ finalizeSourceDeployment });

    await sendRestartReportIfPending(w);

    expect(finalizeSourceDeployment).toHaveBeenCalledWith(sourceDeployment);
    expect(sent[0].card).toContain('deploy/v3.8.0-custom.1');
  });

  it('alerts the owner and leaves deploy absent when source deployment validation fails', async () => {
    writeRestartIntentTo(dir, {
      kind: 'update',
      oldVersion: '3.7.1',
      newVersion: '3.8.0',
      sourceDeployment: {
        releaseTag: 'release/v3.8.0-custom.1',
        expectedHead: 'a'.repeat(40),
      },
      at: new Date(T0).toISOString(),
    });
    const { w, sent } = fakeWiring({
      finalizeSourceDeployment: async () => { throw new Error('运行 HEAD 不一致'); },
    });

    await sendRestartReportIfPending(w);

    expect(sent[0].card).toContain('未创建 deploy 标签');
    expect(sent[0].card).toContain('运行 HEAD 不一致');
  });

  it('stays silent when there is no intent (crash / pm2 auto-restart)', async () => {
    const { w, sent } = fakeWiring();
    await sendRestartReportIfPending(w);
    expect(sent).toHaveLength(0);
  });

  it('consumes the intent but skips the DM when no owner is configured', async () => {
    writeRestartIntentTo(dir, { kind: 'manual', at: new Date(T0).toISOString() });
    const { w, sent } = fakeWiring({ ownerOpenId: undefined });
    await sendRestartReportIfPending(w);
    expect(sent).toHaveLength(0);
    expect(existsSync(restartIntentPathIn(dir))).toBe(false); // still consumed (no retry storm)
  });

  it('fires at most once — a second call after consume sends nothing', async () => {
    writeRestartIntentTo(dir, { kind: 'manual', at: new Date(T0).toISOString() });
    const { w, sent } = fakeWiring();
    await sendRestartReportIfPending(w);
    await sendRestartReportIfPending(w);
    expect(sent).toHaveLength(1);
  });

  it('生产 wiring 优先通过已登记的 owner 通知策略投递', async () => {
    writeRestartIntentTo(dir, { kind: 'manual', at: new Date(T0).toISOString() });
    const delivered: string[] = [];
    const { w, sent } = fakeWiring({
      deliverCard: async (_openId, card) => { delivered.push(card); },
    });

    await sendRestartReportIfPending(w);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('botmux 已重启');
    expect(sent).toHaveLength(0);
  });
});

describe('fetchChangelog', () => {
  it('adds GitHub bearer auth when githubToken is configured', async () => {
    let auth: string | null = null;
    const notes = await fetchChangelog('2.85.1', {
      auth: { env: { GITHUB_TOKEN: ' ghp_secret ' }, envFilePath: null },
      fetchImpl: async (_input, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        auth = headers?.Authorization ?? headers?.authorization ?? null;
        return { ok: true, json: async () => ({ body: 'notes' }) } as Response;
      },
    });
    expect(notes).toBe('notes');
    expect(auth).toBe('Bearer ghp_secret');
  });

  it('omits GitHub bearer auth when githubToken is blank', async () => {
    let auth: string | null = 'present';
    await fetchChangelog('2.85.1', {
      auth: { env: { GITHUB_TOKEN: '   ' }, envFilePath: null },
      fetchImpl: async (_input, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        auth = headers?.Authorization ?? headers?.authorization ?? null;
        return { ok: true, json: async () => ({ body: 'notes' }) } as Response;
      },
    });
    expect(auth).toBeNull();
  });

  it('uses env-file auth fallback when process env is unset', async () => {
    let auth: string | null = null;
    await fetchChangelog('2.85.1', {
      auth: {
        env: {},
        envFilePath: '/tmp/global.env',
        fileExists: () => true,
        readTextFile: () => 'GITHUB_TOKEN=ghp_from_file\n',
      },
      fetchImpl: async (_input, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        auth = headers?.Authorization ?? headers?.authorization ?? null;
        return { ok: true, json: async () => ({ body: 'notes' }) } as Response;
      },
    });
    expect(auth).toBe('Bearer ghp_from_file');
  });
});
