/** Owner 通知卡片测试：锁定统一外观、同类型复用和旧卡失效后的替换语义。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildOwnerNoticeCard } from '../src/im/lark/owner-notice-card.js';
import { upsertOwnerNoticeCard } from '../src/services/owner-notice-card-store.js';

describe('owner notice card slot', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-owner-notice-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it('统一输出 interactive card 结构', () => {
    const card = JSON.parse(buildOwnerNoticeCard({
      title: 'Botmux 权限通知',
      markdown: '缺少权限',
      template: 'orange',
    }));
    expect(card.header).toEqual(expect.objectContaining({ template: 'orange' }));
    expect(card.elements).toEqual([{ tag: 'markdown', content: '缺少权限' }]);
  });

  it('同类型第二次只更新原卡，不新增消息', async () => {
    const sendCard = vi.fn(async () => 'om_notice');
    const updateCard = vi.fn(async () => undefined);
    const base = { dataDir, kind: 'restart', sendCard, updateCard };

    await upsertOwnerNoticeCard({ ...base, cardJson: '{"v":1}' });
    const result = await upsertOwnerNoticeCard({ ...base, cardJson: '{"v":2}' });

    expect(sendCard).toHaveBeenCalledTimes(1);
    expect(updateCard).toHaveBeenCalledWith('om_notice', '{"v":2}');
    expect(result).toEqual({ action: 'updated', messageId: 'om_notice' });
  });

  it('原卡不可更新时新发并替换槽位，之后继续复用新卡', async () => {
    const sendCard = vi.fn()
      .mockResolvedValueOnce('om_old')
      .mockResolvedValueOnce('om_new');
    const updateCard = vi.fn()
      .mockRejectedValueOnce(new Error('withdrawn'))
      .mockResolvedValue(undefined);
    const base = { dataDir, kind: 'skill-sync', sendCard, updateCard };

    await upsertOwnerNoticeCard({ ...base, cardJson: '{"v":1}' });
    expect(await upsertOwnerNoticeCard({ ...base, cardJson: '{"v":2}' }))
      .toEqual({ action: 'sent', messageId: 'om_new' });
    await upsertOwnerNoticeCard({ ...base, cardJson: '{"v":3}' });

    expect(sendCard).toHaveBeenCalledTimes(2);
    expect(updateCard).toHaveBeenLastCalledWith('om_new', '{"v":3}');
  });

  it('同类型并发首次通知也只发送一张卡', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const sendCard = vi.fn(async () => {
      await blocked;
      return 'om_one';
    });
    const updateCard = vi.fn(async () => undefined);
    const input = { dataDir, kind: 'concurrent', cardJson: '{"v":1}', sendCard, updateCard };

    const first = upsertOwnerNoticeCard(input);
    const second = upsertOwnerNoticeCard(input);
    release();
    await Promise.all([first, second]);

    expect(sendCard).toHaveBeenCalledTimes(1);
    expect(updateCard).toHaveBeenCalledWith('om_one', '{"v":1}');
  });
});
