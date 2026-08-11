/** 通用可编辑预览测试共享规格。 */
export const rawEditableSpec = {
  targetChatId: 'oc_target123',
  preview: {
    title: '示例 · 可编辑预览',
    note: '链接和真实 @ 不可编辑。',
    elements: [{ tag: 'markdown', template: '<at id=ou_author123></at>：[{{title}}](https://example.com/mr/1)' }],
  },
  notification: {
    title: '示例通知',
    elements: [
      { tag: 'markdown', template: '<at id=ou_author123></at>：[{{title}}](https://example.com/mr/1)' },
      { tag: 'markdown', template: '{{summary}}' },
      { tag: 'hr' },
      { tag: 'markdown', template: '**状态**　{{status}}\n**Channel**　{{channels}}' },
    ],
  },
  fields: [
    { name: 'title', label: '标题', value: '初始标题', maxLength: 300 },
    { name: 'summary', label: '摘要', value: '初始摘要', multiline: true, maxLength: 1_000 },
    { name: 'status', label: '状态', value: '测试中', maxLength: 50 },
    { name: 'channels', label: 'Channel', value: 'channel_a、channel_b', multiline: true, maxLength: 1_000, format: 'inline_code_list' },
  ],
};
