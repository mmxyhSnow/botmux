/** 通用可编辑卡片预览的权限、幂等与租约测试。 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEditableCardPreviewSpec } from '../src/services/editable-card-preview-model.js';
import {
  bindEditableCardPreviewMessage,
  claimEditableCardPreviewAction,
  createEditableCardPreviewDraft,
  finishEditableCardPreviewSend,
  readEditableCardPreview,
} from '../src/services/editable-card-preview-store.js';
import { rawEditableSpec } from './fixtures/editable-card-preview.js';

const spec = parseEditableCardPreviewSpec(rawEditableSpec);

function setup(now?: number) {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-editable-store-'));
  const draft = createEditableCardPreviewDraft(dataDir, {
    larkAppId: 'cli_app',
    initiatorOpenId: 'ou_owner',
    now,
    ...spec,
  });
  bindEditableCardPreviewMessage(dataDir, draft.previewId, 'om_preview', now === undefined ? undefined : now + 1);
  return { dataDir, draft };
}

describe('通用可编辑卡片预览状态', () => {
  it('只允许准确发起人和源消息认领一次动作', () => {
    const { dataDir, draft } = setup();
    expect(draft.targetChatId).toBe('oc_target123');
    expect(draft.definition.targetChatDisplayName).toBe('示例评审群');
    const claim = (operatorOpenId: string, larkAppId = 'cli_app', sourceMessageId = 'om_preview') => claimEditableCardPreviewAction(dataDir, {
      previewId: draft.previewId,
      larkAppId,
      operatorOpenId,
      sourceMessageId,
      action: 'editable_card_preview_send',
    });
    expect(claim('ou_other').kind).toBe('forbidden');
    expect(claim('ou_owner', 'cli_other').kind).toBe('forbidden');
    expect(claim('ou_owner', 'cli_app', 'om_other').kind).toBe('forbidden');
    expect(claim('ou_owner').kind).toBe('claimed');
    expect(claim('ou_owner').kind).toBe('busy');
  });

  it('完成发送后旧预览不可再次认领', () => {
    const { dataDir, draft } = setup();
    expect(claimEditableCardPreviewAction(dataDir, {
      previewId: draft.previewId,
      larkAppId: 'cli_app',
      operatorOpenId: 'ou_owner',
      sourceMessageId: 'om_preview',
      action: 'editable_card_preview_send',
    }).kind).toBe('claimed');
    finishEditableCardPreviewSend(
      dataDir,
      draft.previewId,
      'editable_card_preview_send',
      spec.editable,
      'om_formal',
    );
    expect(readEditableCardPreview(dataDir, draft.previewId)?.status).toBe('sent');
    expect(claimEditableCardPreviewAction(dataDir, {
      previewId: draft.previewId,
      larkAppId: 'cli_app',
      operatorOpenId: 'ou_owner',
      sourceMessageId: 'om_preview',
      action: 'editable_card_preview_send',
    }).kind).toBe('stale');
  });

  it('处理租约过期后只允许原动作重新认领', () => {
    const { dataDir, draft } = setup(1_000);
    const claim = (action: string, now: number) => claimEditableCardPreviewAction(dataDir, {
      previewId: draft.previewId,
      larkAppId: 'cli_app',
      operatorOpenId: 'ou_owner',
      sourceMessageId: 'om_preview',
      action,
      now,
    });
    expect(claim('editable_card_preview_send', 1_002).kind).toBe('claimed');
    expect(claim('editable_card_preview_regenerate', 121_003).kind).toBe('busy');
    expect(claim('editable_card_preview_send', 121_002).kind).toBe('claimed');
  });
});
