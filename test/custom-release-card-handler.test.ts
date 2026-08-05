/** 自定义发版卡回调路由测试：只把飞书验证过身份的冻结点击交给 primary daemon。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

let tempDir = '';

async function fresh() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const handler = await import('../src/im/lark/card-handler.js');
  registry.loadBotConfigs().forEach(config => registry.registerBot(config));
  return handler;
}

function action(operator?: string, actionName = 'custom_release_freeze') {
  return {
    ...(operator ? { operator: { open_id: operator } } : {}),
    action: { value: { action: actionName, event_id: '1'.repeat(64) } },
    context: { open_message_id: 'om_release' },
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'botmux-custom-release-card-'));
  const configPath = join(tempDir, 'bots.json');
  writeFileSync(configPath, JSON.stringify([{
    larkAppId: 'h1',
    larkAppSecret: 'secret',
    cliId: 'codex',
    allowedUsers: ['ou_owner'],
  }]));
  process.env.BOTS_CONFIG = configPath;
});

afterEach(() => {
  delete process.env.BOTS_CONFIG;
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('custom release card action', () => {
  it('把带可信操作者身份的冻结点击交给 daemon 统一鉴权', async () => {
    const handler = await fresh();
    const customReleaseCardAction = vi.fn(async () => ({ ok: true }));
    const data = action('ou_owner');
    const result = await handler.handleCardAction(data, {
      activeSessions: new Map(),
      sessionReply: vi.fn(async () => 'om_reply'),
      lastRepoScan: new Map(),
      customReleaseCardAction,
    }, 'h1');

    expect(result).toEqual({ ok: true });
    expect(customReleaseCardAction).toHaveBeenCalledWith(data, 'h1');
  });

  it('缺少飞书校验过的操作者身份时不进入 daemon', async () => {
    const handler = await fresh();
    const customReleaseCardAction = vi.fn();
    const result = await handler.handleCardAction(action(), {
      activeSessions: new Map(),
      sessionReply: vi.fn(async () => 'om_reply'),
      lastRepoScan: new Map(),
      customReleaseCardAction,
    }, 'h1');

    expect(result?.toast?.type).toBe('error');
    expect(customReleaseCardAction).not.toHaveBeenCalled();
  });

  it('把推进生产点击交给同一受控发布处理器', async () => {
    const handler = await fresh();
    const customReleaseCardAction = vi.fn(async () => ({ ok: true }));
    const data = action('ou_owner', 'custom_release_promote');
    const result = await handler.handleCardAction(data, {
      activeSessions: new Map(),
      sessionReply: vi.fn(async () => 'om_reply'),
      lastRepoScan: new Map(),
      customReleaseCardAction,
    }, 'h1');

    expect(result).toEqual({ ok: true });
    expect(customReleaseCardAction).toHaveBeenCalledWith(data, 'h1');
  });

  it('把冻结并部署点击交给同一受控发布处理器', async () => {
    const handler = await fresh();
    const customReleaseCardAction = vi.fn(async () => ({ ok: true }));
    const data = action('ou_owner', 'custom_release_freeze_and_deploy');
    const result = await handler.handleCardAction(data, {
      activeSessions: new Map(),
      sessionReply: vi.fn(async () => 'om_reply'),
      lastRepoScan: new Map(),
      customReleaseCardAction,
    }, 'h1');

    expect(result).toEqual({ ok: true });
    expect(customReleaseCardAction).toHaveBeenCalledWith(data, 'h1');
  });
});
