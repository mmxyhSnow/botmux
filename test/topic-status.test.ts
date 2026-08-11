/**
 * 话题任务状态的纯函数回归：固定三档配置、状态文案和机器人根消息别名语义。
 */
import { describe, expect, it } from 'vitest';
import {
  buildTopicStatusRootCard,
  findBotOwnedTopicAlias,
  formatTopicStatusLine,
  normalizeTopicStatusDisplayMode,
  progressStateTopicPhase,
} from '../src/services/topic-status.js';

describe('topic status display', () => {
  it('defaults to off and accepts only the two opt-in modes', () => {
    expect(normalizeTopicStatusDisplayMode(undefined)).toBe('off');
    expect(normalizeTopicStatusDisplayMode('off')).toBe('off');
    expect(normalizeTopicStatusDisplayMode('reply-preview')).toBe('reply-preview');
    expect(normalizeTopicStatusDisplayMode('bot-root')).toBe('bot-root');
    expect(normalizeTopicStatusDisplayMode('unexpected')).toBe('off');
  });

  it('renders stable lifecycle icons with a bounded one-line title', () => {
    expect(formatTopicStatusLine('running', '核对现有 API 能力')).toBe('⏳ 进行中｜核对现有 API 能力');
    expect(formatTopicStatusLine('waiting', '选择迁移方式')).toBe('🙋 待互动｜选择迁移方式');
    expect(formatTopicStatusLine('completed', '交付功能')).toBe('✅ 已结束｜交付功能');
    expect(formatTopicStatusLine('failed', '构建失败')).toBe('❌ 失败｜构建失败');
    expect(formatTopicStatusLine('blocked', '等待权限')).toBe('⚠️ 受阻｜等待权限');
    expect(formatTopicStatusLine('interrupted', '停止执行')).toBe('⏹️ 已中断｜停止执行');
    const bounded = formatTopicStatusLine('running', '  '.padEnd(100, '长'));
    expect(bounded.length).toBeLessThanOrEqual(48);
    expect(bounded).toMatch(/…$/);
  });

  it('builds a CardKit 2.0 root card with exact Feishu emoji states', () => {
    const cases = [
      ['running', ':Typing: 进行中', 'blue'],
      ['waiting', ':WHAT: 待互动', 'yellow'],
      ['completed', ':DONE: 已完成', 'green'],
      ['failed', ':TOASTED: 失败', 'red'],
      ['blocked', ':TOASTED: 失败', 'red'],
      ['interrupted', ':TOASTED: 失败', 'red'],
    ] as const;
    for (const [phase, prefix, template] of cases) {
      const card = JSON.parse(buildTopicStatusRootCard(phase, '根卡片状态模型优化'));
      expect(card.schema).toBe('2.0');
      expect(card.header.template).toBe(template);
      expect(card.header.title).toEqual({
        tag: 'plain_text',
        content: `${prefix}｜根卡片状态模型优化`,
      });
      expect(card.body.elements[0].content).toBe('**任务概括**\n根卡片状态模型优化');
    }
  });

  it('escapes user-controlled task summaries in CardKit markdown', () => {
    const card = JSON.parse(buildTopicStatusRootCard('running', '<at id=all></at> *任务*'));
    expect(card.header.title).toEqual({
      tag: 'plain_text',
      content: ':Typing: 进行中｜<at id=all></at> *任务*',
    });
    expect(card.body.elements[0].content).not.toContain('<at id=all>');
  });

  it('keeps external jobs visible after the AI turn ends', () => {
    expect(progressStateTopicPhase({ phase: 'running' } as any)).toBe('running');
    expect(progressStateTopicPhase({ phase: 'running', waitingForUser: true } as any)).toBe('waiting');
    expect(progressStateTopicPhase({ phase: 'running', overview: { blocker: '需要授权' } } as any)).toBe('blocked');
    expect(progressStateTopicPhase({ phase: 'failed' } as any)).toBe('failed');
    expect(progressStateTopicPhase({ phase: 'interrupted' } as any)).toBe('interrupted');
    expect(progressStateTopicPhase({
      phase: 'completed',
      overview: { external: [{ label: 'CI', status: 'running' }] },
    } as any)).toBe('running');
    expect(progressStateTopicPhase({
      phase: 'completed',
      overview: { external: [{ label: 'CI', status: 'Failed' }] },
    } as any)).toBe('failed');
    expect(progressStateTopicPhase({ phase: 'completed' } as any)).toBe('completed');
  });

  it('resolves the original user root to the bot-owned root only for the same bot and chat', () => {
    const sessions = [{
      status: 'active',
      larkAppId: 'cli_bot',
      chatId: 'oc_chat',
      scope: 'thread',
      rootMessageId: 'om_bot',
      sessionId: 'session-1',
      topicStatusBinding: {
        mode: 'bot-root',
        originalRootMessageId: 'om_user',
        botRootMessageId: 'om_bot',
        title: '任务',
        phase: 'running',
        createdAt: '2026-08-05T00:00:00.000Z',
        updatedAt: '2026-08-05T00:00:00.000Z',
      },
    }];
    expect(findBotOwnedTopicAlias(sessions as any, 'om_user', 'oc_chat', 'cli_bot')).toEqual({
      chatId: 'oc_chat',
      sessionId: 'session-1',
      anchor: 'om_bot',
    });
    expect(findBotOwnedTopicAlias(sessions as any, 'om_user', 'oc_other', 'cli_bot')).toBeNull();
    expect(findBotOwnedTopicAlias(sessions as any, 'om_user', 'oc_chat', 'cli_other')).toBeNull();
  });
});
