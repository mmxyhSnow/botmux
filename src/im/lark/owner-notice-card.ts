/** Owner/admin 主动通知的统一飞书卡片外观，避免同一私聊里文本气泡与卡片混用。 */
export type OwnerNoticeTemplate = 'blue' | 'green' | 'orange' | 'red' | 'grey';

export interface OwnerNoticeCardInput {
  title: string;
  markdown: string;
  template?: OwnerNoticeTemplate;
}

/** 构造最小交互卡；调用方只负责业务文案和同类型消息的聚合键。 */
export function buildOwnerNoticeCard(input: OwnerNoticeCardInput): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: input.template ?? 'blue',
      title: { tag: 'plain_text', content: input.title },
    },
    elements: [{ tag: 'markdown', content: input.markdown }],
  });
}
