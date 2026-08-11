/** 通用可编辑卡片发送与重新生成回调测试。 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { handleEditableCardPreviewAction } from '../src/im/lark/editable-card-preview-handler.js';
import {
  EDITABLE_CARD_PREVIEW_REGENERATE_ACTION,
  EDITABLE_CARD_PREVIEW_SEND_ACTION,
  parseEditableCardPreviewSpec,
} from '../src/services/editable-card-preview-model.js';
import {
  bindEditableCardPreviewMessage,
  createEditableCardPreviewDraft,
  readEditableCardPreview,
} from '../src/services/editable-card-preview-store.js';
import { rawEditableSpec } from './fixtures/editable-card-preview.js';

const spec = parseEditableCardPreviewSpec(rawEditableSpec);

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-editable-handler-'));
  const draft = createEditableCardPreviewDraft(dataDir, {
    larkAppId: 'cli_app',
    initiatorOpenId: 'ou_owner',
    ...spec,
  });
  bindEditableCardPreviewMessage(dataDir, draft.previewId, 'om_preview');
  return { dataDir, draft };
}

function data(previewId: string, action: string) {
  return {
    operator: { open_id: 'ou_owner' },
    context: { open_message_id: 'om_preview' },
    action: {
      value: { action, preview_id: previewId },
      form_value: {
        title: '修改标题',
        summary: '修改摘要',
        status: '测试完成',
        channels: 'channel_c、channel_d',
      },
    },
  };
}

describe('通用可编辑卡片预览回调', () => {
  it('发送时使用修改内容并生成无控件正式卡', async () => {
    const { dataDir, draft } = setup();
    const sendFormal = vi.fn(async () => 'om_formal');
    const result = await handleEditableCardPreviewAction(
      data(draft.previewId, EDITABLE_CARD_PREVIEW_SEND_ACTION),
      { dataDir, larkAppId: 'cli_app', sendFormal, sendReplacement: vi.fn() },
    );
    expect(sendFormal).toHaveBeenCalledOnce();
    const [targetChatId, rawCard, providerKey] = sendFormal.mock.calls[0];
    expect(targetChatId).toBe('oc_target123');
    expect(providerKey).toBe(`ecp-send-${draft.previewId}`);
    expect(rawCard).toContain('修改标题');
    expect(rawCard).not.toContain('editable_card_preview_send');
    expect(readEditableCardPreview(dataDir, draft.previewId)?.status).toBe('sent');
    expect((result.card as any).data.header.title.content).toContain('已发送');
  });

  it('重新生成新预览并使旧记录失效', async () => {
    const { dataDir, draft } = setup();
    const sendReplacement = vi.fn(async () => 'om_replacement');
    const result = await handleEditableCardPreviewAction(
      data(draft.previewId, EDITABLE_CARD_PREVIEW_REGENERATE_ACTION),
      { dataDir, larkAppId: 'cli_app', sendFormal: vi.fn(), sendReplacement },
    );
    expect(sendReplacement).toHaveBeenCalledOnce();
    const old = readEditableCardPreview(dataDir, draft.previewId)!;
    expect(old.status).toBe('regenerated');
    const replacement = readEditableCardPreview(dataDir, old.replacementPreviewId!)!;
    expect(replacement.status).toBe('active');
    expect(replacement.editable.summary).toBe('修改摘要');
    expect((result.card as any).data.header.title.content).toContain('已重新生成');
  });

  it('失败后恢复可重试状态并复用 provider key', async () => {
    const { dataDir, draft } = setup();
    const keys: string[] = [];
    await handleEditableCardPreviewAction(
      data(draft.previewId, EDITABLE_CARD_PREVIEW_REGENERATE_ACTION),
      {
        dataDir,
        larkAppId: 'cli_app',
        sendFormal: vi.fn(),
        sendReplacement: vi.fn(async (_source, _card, key) => {
          keys.push(key);
          throw new Error('temporary unavailable');
        }),
      },
    );
    expect(readEditableCardPreview(dataDir, draft.previewId)?.status).toBe('active');
    await handleEditableCardPreviewAction(
      data(draft.previewId, EDITABLE_CARD_PREVIEW_REGENERATE_ACTION),
      {
        dataDir,
        larkAppId: 'cli_app',
        sendFormal: vi.fn(),
        sendReplacement: vi.fn(async (_source, _card, key) => {
          keys.push(key);
          return 'om_replacement';
        }),
      },
    );
    expect(keys[1]).toBe(keys[0]);
  });
});
