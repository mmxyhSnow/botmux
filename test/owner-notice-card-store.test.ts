/** Owner 通知卡片测试：锁定统一外观、同类型复用和旧卡失效后的替换语义。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverOwnerNotice, type OwnerNoticeTransport } from '../src/services/owner-notice.js';

function raw(version: number): string {
  return JSON.stringify({ elements: [{ tag: 'markdown', content: `v${version}` }] });
}

describe('owner notice card slot', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-owner-notice-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it('统一输出 interactive card 结构', async () => {
    let sent = '';
    let uuid = '';
    const transport: OwnerNoticeTransport = {
      sendCard: async (_openId, card, dedupeUuid) => {
        sent = card;
        uuid = dedupeUuid ?? '';
        return 'om_notice';
      },
      updateCard: async () => undefined,
    };
    await deliverOwnerNotice({
      dataDir,
      larkAppId: 'cli_a',
      recipientOpenId: 'ou_owner',
      policy: 'production-skill-sync',
      card: {
        mode: 'standard',
        content: { title: 'Botmux 权限通知', markdown: '缺少权限', template: 'orange' },
      },
      transport,
    });
    const card = JSON.parse(sent);
    expect(card.header).toEqual(expect.objectContaining({ template: 'orange' }));
    expect(card.elements).toEqual([{ tag: 'markdown', content: '缺少权限' }]);
    expect(uuid).toMatch(/^owner-notice-[a-f0-9]{32}$/);
    expect(uuid.length).toBeLessThanOrEqual(50);
  });

  it('同类型第二次只更新原卡，不新增消息', async () => {
    const sendCard = vi.fn(async () => 'om_notice');
    const updateCard = vi.fn(async () => undefined);
    const base = {
      dataDir,
      larkAppId: 'cli_a',
      recipientOpenId: 'ou_owner',
      policy: 'restart' as const,
      transport: { sendCard, updateCard },
    };

    await deliverOwnerNotice({ ...base, card: { mode: 'raw', cardJson: raw(1) } });
    const result = await deliverOwnerNotice({ ...base, card: { mode: 'raw', cardJson: raw(2) } });

    expect(sendCard).toHaveBeenCalledTimes(1);
    expect(updateCard).toHaveBeenCalledWith('om_notice', raw(2));
    expect(result).toEqual(expect.objectContaining({ action: 'updated', messageId: 'om_notice', policy: 'restart' }));
  });

  it('原卡不可更新时新发并替换槽位，之后继续复用新卡', async () => {
    const sendCard = vi.fn()
      .mockResolvedValueOnce('om_old')
      .mockResolvedValueOnce('om_new');
    const updateCard = vi.fn()
      .mockRejectedValueOnce(new Error('withdrawn'))
      .mockResolvedValue(undefined);
    const base = {
      dataDir,
      larkAppId: 'cli_a',
      recipientOpenId: 'ou_owner',
      policy: 'restart' as const,
      transport: { sendCard, updateCard },
    };

    await deliverOwnerNotice({ ...base, card: { mode: 'raw', cardJson: raw(1) } });
    expect(await deliverOwnerNotice({ ...base, card: { mode: 'raw', cardJson: raw(2) } }))
      .toEqual(expect.objectContaining({ action: 'sent', messageId: 'om_new' }));
    await deliverOwnerNotice({ ...base, card: { mode: 'raw', cardJson: raw(3) } });

    expect(sendCard).toHaveBeenCalledTimes(2);
    expect(updateCard).toHaveBeenLastCalledWith('om_new', raw(3));
  });

  it('同类型并发首次通知也只发送一张卡', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const sendCard = vi.fn(async () => {
      await blocked;
      return 'om_one';
    });
    const updateCard = vi.fn(async () => undefined);
    const input = {
      dataDir,
      larkAppId: 'cli_a',
      recipientOpenId: 'ou_owner',
      policy: 'cli-runtime-update' as const,
      scope: 'codex',
      card: { mode: 'raw' as const, cardJson: raw(1) },
      transport: { sendCard, updateCard },
    };

    const first = deliverOwnerNotice(input);
    const second = deliverOwnerNotice(input);
    release();
    await Promise.all([first, second]);

    expect(sendCard).toHaveBeenCalledTimes(1);
    expect(updateCard).toHaveBeenCalledWith('om_one', raw(1));
  });

  it('未登记策略形态和 scoped 身份均 fail closed', async () => {
    const transport: OwnerNoticeTransport = {
      sendCard: vi.fn(async () => 'om_unused'),
      updateCard: vi.fn(async () => undefined),
    };
    await expect(deliverOwnerNotice({
      dataDir,
      larkAppId: 'cli_a',
      recipientOpenId: 'ou_owner',
      policy: 'permission-health',
      card: { mode: 'standard', content: { title: '权限', markdown: '缺少 scope' } },
      transport,
    })).rejects.toThrow('必须提供 scope');
    await expect(deliverOwnerNotice({
      dataDir,
      larkAppId: 'cli_a',
      recipientOpenId: 'ou_owner',
      policy: 'restart',
      card: { mode: 'standard', content: { title: '重启', markdown: '错误形态' } },
      transport,
    })).rejects.toThrow('必须使用 raw 卡片模式');
  });

  it('callback 按钮缺少 action 时 fail closed', async () => {
    const transport: OwnerNoticeTransport = {
      sendCard: vi.fn(async () => 'om_unused'),
      updateCard: vi.fn(async () => undefined),
    };
    await expect(deliverOwnerNotice({
      dataDir,
      larkAppId: 'cli_a',
      recipientOpenId: 'ou_owner',
      policy: 'restart',
      card: {
        mode: 'raw',
        cardJson: JSON.stringify({
          elements: [{ tag: 'button', text: { tag: 'plain_text', content: '执行' }, value: { id: 'x' } }],
        }),
      },
      transport,
    })).rejects.toThrow('callback 按钮必须提供非空 action');
  });
});
