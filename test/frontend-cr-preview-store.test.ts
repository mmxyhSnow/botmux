/** 前端 CR 预览持久化、权限与幂等状态的定向测试。 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFrontendCrPreviewSpec } from '../src/services/frontend-cr-preview-model.js';
import {
  bindFrontendCrPreviewMessage,
  claimFrontendCrPreviewAction,
  createFrontendCrPreviewDraft,
  finishFrontendCrPreviewSend,
  readFrontendCrPreview,
} from '../src/services/frontend-cr-preview-store.js';

const spec = parseFrontendCrPreviewSpec({
  targetChatId: 'oc_target123',
  authorOpenId: 'ou_author123',
  mrUrl: 'https://code.example.com/team/repo/merge_requests/552',
  mrTitle: 'feat: 网络恢复',
  reviewerOpenIds: ['ou_reviewer1'],
  summary: '恢复后自动重试。',
  status: '测试中',
  releaseStatus: '跟版 v6.6.6',
  channels: ['novelfm'],
});

describe('前端 CR 预览状态', () => {
  it('绑定源消息并只允许准确发起人认领一次动作', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-fcr-store-'));
    const draft = createFrontendCrPreviewDraft(dataDir, {
      larkAppId: 'cli_app',
      initiatorOpenId: 'ou_owner',
      ...spec,
    });
    bindFrontendCrPreviewMessage(dataDir, draft.previewId, 'om_preview');

    expect(claimFrontendCrPreviewAction(dataDir, {
      previewId: draft.previewId,
      larkAppId: 'cli_app',
      operatorOpenId: 'ou_other',
      sourceMessageId: 'om_preview',
      action: 'frontend_cr_preview_send',
    }).kind).toBe('forbidden');
    expect(claimFrontendCrPreviewAction(dataDir, {
      previewId: draft.previewId,
      larkAppId: 'cli_app',
      operatorOpenId: 'ou_owner',
      sourceMessageId: 'om_preview',
      action: 'frontend_cr_preview_send',
    }).kind).toBe('claimed');
    expect(claimFrontendCrPreviewAction(dataDir, {
      previewId: draft.previewId,
      larkAppId: 'cli_app',
      operatorOpenId: 'ou_owner',
      sourceMessageId: 'om_preview',
      action: 'frontend_cr_preview_send',
    }).kind).toBe('busy');
  });

  it('完成发送后旧预览不可再次认领', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-fcr-store-'));
    const draft = createFrontendCrPreviewDraft(dataDir, {
      larkAppId: 'cli_app',
      initiatorOpenId: 'ou_owner',
      ...spec,
    });
    bindFrontendCrPreviewMessage(dataDir, draft.previewId, 'om_preview');
    const claim = claimFrontendCrPreviewAction(dataDir, {
      previewId: draft.previewId,
      larkAppId: 'cli_app',
      operatorOpenId: 'ou_owner',
      sourceMessageId: 'om_preview',
      action: 'frontend_cr_preview_send',
    });
    expect(claim.kind).toBe('claimed');
    finishFrontendCrPreviewSend(
      dataDir,
      draft.previewId,
      'frontend_cr_preview_send',
      spec.editable,
      'om_formal',
    );
    expect(readFrontendCrPreview(dataDir, draft.previewId)?.status).toBe('sent');
    expect(claimFrontendCrPreviewAction(dataDir, {
      previewId: draft.previewId,
      larkAppId: 'cli_app',
      operatorOpenId: 'ou_owner',
      sourceMessageId: 'om_preview',
      action: 'frontend_cr_preview_send',
    }).kind).toBe('stale');
  });

  it('只允许同一动作在处理租约过期后重新认领', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-fcr-store-'));
    const draft = createFrontendCrPreviewDraft(dataDir, {
      larkAppId: 'cli_app',
      initiatorOpenId: 'ou_owner',
      now: 1_000,
      ...spec,
    });
    bindFrontendCrPreviewMessage(dataDir, draft.previewId, 'om_preview', 1_001);
    const claim = (action: string, now: number) => claimFrontendCrPreviewAction(dataDir, {
      previewId: draft.previewId,
      larkAppId: 'cli_app',
      operatorOpenId: 'ou_owner',
      sourceMessageId: 'om_preview',
      action,
      now,
    });
    expect(claim('frontend_cr_preview_send', 1_002).kind).toBe('claimed');
    expect(claim('frontend_cr_preview_regenerate', 121_003).kind).toBe('busy');
    expect(claim('frontend_cr_preview_send', 121_002).kind).toBe('claimed');
  });
});
