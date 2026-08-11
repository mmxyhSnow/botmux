/** 前端 CR 预览发送与重新生成回调的定向测试。 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { handleFrontendCrPreviewAction } from '../src/im/lark/frontend-cr-preview-handler.js';
import {
  FRONTEND_CR_PREVIEW_REGENERATE_ACTION,
  FRONTEND_CR_PREVIEW_SEND_ACTION,
  parseFrontendCrPreviewSpec,
} from '../src/services/frontend-cr-preview-model.js';
import {
  bindFrontendCrPreviewMessage,
  createFrontendCrPreviewDraft,
  readFrontendCrPreview,
} from '../src/services/frontend-cr-preview-store.js';

const spec = parseFrontendCrPreviewSpec({
  targetChatId: 'oc_target123',
  authorOpenId: 'ou_author123',
  mrUrl: 'https://code.example.com/team/repo/merge_requests/552',
  mrTitle: 'feat: 网络恢复',
  reviewerOpenIds: ['ou_reviewer1', 'ou_reviewer2'],
  summary: '恢复后自动重试。',
  status: '测试中',
  releaseStatus: '跟版 v6.6.6',
  channels: ['novelfm'],
});

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-fcr-handler-'));
  const draft = createFrontendCrPreviewDraft(dataDir, {
    larkAppId: 'cli_app',
    initiatorOpenId: 'ou_owner',
    ...spec,
  });
  bindFrontendCrPreviewMessage(dataDir, draft.previewId, 'om_preview');
  return { dataDir, draft };
}

function data(previewId: string, action: string) {
  return {
    operator: { open_id: 'ou_owner' },
    context: { open_message_id: 'om_preview' },
    action: {
      value: { action, preview_id: previewId },
      form_value: {
        mr_title: 'feat: 用户修改标题',
        summary: '用户修改总结',
        status: '测试完成',
        release_status: '不跟版',
        channels: 'channel_a、channel_b',
      },
    },
  };
}

describe('前端 CR 预览回调', () => {
  it('发送时使用修改内容并生成无控件正式卡', async () => {
    const { dataDir, draft } = setup();
    const sendFormal = vi.fn(async () => 'om_formal');
    const result = await handleFrontendCrPreviewAction(
      data(draft.previewId, FRONTEND_CR_PREVIEW_SEND_ACTION),
      {
        dataDir,
        larkAppId: 'cli_app',
        sendFormal,
        sendReplacement: vi.fn(),
      },
    );
    expect(sendFormal).toHaveBeenCalledOnce();
    const [targetChatId, rawCard, providerKey] = sendFormal.mock.calls[0];
    expect(targetChatId).toBe('oc_target123');
    expect(providerKey).toBe(`fcr-send-${draft.previewId}`);
    expect(rawCard).toContain('用户修改标题');
    expect(rawCard).toContain('用户修改总结');
    expect(rawCard).not.toContain('frontend_cr_preview_send');
    expect(readFrontendCrPreview(dataDir, draft.previewId)?.status).toBe('sent');
    expect((result.card as any).data.header.title.content).toContain('已发送');
  });

  it('重新生成会新发预览并使旧记录失效', async () => {
    const { dataDir, draft } = setup();
    const sendReplacement = vi.fn(async () => 'om_replacement');
    const result = await handleFrontendCrPreviewAction(
      data(draft.previewId, FRONTEND_CR_PREVIEW_REGENERATE_ACTION),
      {
        dataDir,
        larkAppId: 'cli_app',
        sendFormal: vi.fn(),
        sendReplacement,
      },
    );
    expect(sendReplacement).toHaveBeenCalledOnce();
    const old = readFrontendCrPreview(dataDir, draft.previewId)!;
    expect(old.status).toBe('regenerated');
    expect(old.replacementMessageId).toBe('om_replacement');
    const replacement = readFrontendCrPreview(dataDir, old.replacementPreviewId!)!;
    expect(replacement.status).toBe('active');
    expect(replacement.previewMessageId).toBe('om_replacement');
    expect(replacement.editable.summary).toBe('用户修改总结');
    expect((result.card as any).data.header.title.content).toContain('已重新生成');
  });

  it('发送失败会恢复旧预览为可重试状态', async () => {
    const { dataDir, draft } = setup();
    const result = await handleFrontendCrPreviewAction(
      data(draft.previewId, FRONTEND_CR_PREVIEW_SEND_ACTION),
      {
        dataDir,
        larkAppId: 'cli_app',
        sendFormal: vi.fn(async () => { throw new Error('target unavailable'); }),
        sendReplacement: vi.fn(),
      },
    );
    expect((result.toast as any).type).toBe('error');
    expect(readFrontendCrPreview(dataDir, draft.previewId)?.status).toBe('active');
  });

  it('重新生成失败后复用同一替代预览和 provider key', async () => {
    const { dataDir, draft } = setup();
    const providerKeys: string[] = [];
    const failed = await handleFrontendCrPreviewAction(
      data(draft.previewId, FRONTEND_CR_PREVIEW_REGENERATE_ACTION),
      {
        dataDir,
        larkAppId: 'cli_app',
        sendFormal: vi.fn(),
        sendReplacement: vi.fn(async (_source, _card, providerKey) => {
          providerKeys.push(providerKey);
          throw new Error('temporary unavailable');
        }),
      },
    );
    expect((failed.toast as any).type).toBe('error');
    expect(readFrontendCrPreview(dataDir, draft.previewId)?.status).toBe('active');

    await handleFrontendCrPreviewAction(
      data(draft.previewId, FRONTEND_CR_PREVIEW_REGENERATE_ACTION),
      {
        dataDir,
        larkAppId: 'cli_app',
        sendFormal: vi.fn(),
        sendReplacement: vi.fn(async (_source, _card, providerKey) => {
          providerKeys.push(providerKey);
          return 'om_replacement';
        }),
      },
    );
    expect(providerKeys).toHaveLength(2);
    expect(providerKeys[1]).toBe(providerKeys[0]);
    expect(readFrontendCrPreview(dataDir, draft.previewId)?.status).toBe('regenerated');
  });
});
