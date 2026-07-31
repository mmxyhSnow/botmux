/** 自定义待发版私聊汇总卡：展示本次合入、版本累计和 HEAD 绑定冻结入口。 */
import type { CustomReleaseEventRecord } from '../../services/custom-release-event.js';

function code(value: string, length = value.length): string {
  return `\`${value.slice(0, length).replace(/`/g, '')}\``;
}

function text(value: string): string {
  return value.replace(/[\\*_~`\[\]<>]/g, token => `\\${token}`);
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function statusLines(record: CustomReleaseEventRecord): string[] {
  const { event, state } = record;
  if (state.status === 'stale') {
    return ['⚠️ 已有更新的合入卡片，本卡片已过期，不能冻结旧 HEAD。'];
  }
  if (state.status === 'freezing') {
    return [`⏳ 正在冻结 ${code(event.release.pendingVersion)}：执行测试、构建和最终远端 HEAD 复核。`];
  }
  if (state.status === 'frozen') {
    return [
      `✅ 已冻结 ${code(state.candidateTag ?? `release/v${event.release.pendingVersion}`)}。`,
      `下一步：点击下方“推进 ${code(event.production.branch)}”。此步只更新生产分支，不会部署或重启。`,
    ];
  }
  if (state.status === 'freeze_failed') {
    return [
      '❌ 上次冻结未完成，未创建候选标签。',
      state.lastError ? `原因：${text(state.lastError)}` : '',
    ].filter(Boolean);
  }
  if (state.status === 'promoting') {
    return [`⏳ 正在把 ${code(state.candidateTag ?? '')} 推进 ${code(event.production.branch)}。`];
  }
  if (state.status === 'promote_failed') {
    return [
      `❌ 候选版本尚未推进 ${code(event.production.branch)}。`,
      state.lastError ? `原因：${text(state.lastError)}` : '',
    ].filter(Boolean);
  }
  if (state.status === 'promoted') {
    return [
      `✅ 已推进 ${code(event.production.branch)} @ ${code(state.productionHead ?? event.integration.head, 8)}。`,
      '下一步：部署并重启。该步骤会改变运行态，仍需在 Botmux 对话中单独明确授权。',
    ];
  }
  return ['尚未冻结、未推进生产、未部署。'];
}

function cumulativeLines(record: CustomReleaseEventRecord): string[] {
  const items = record.event.cumulative.slice(0, 10).map((item, index) =>
    `${index + 1}. ${text(item.title)} · ${code(item.mergeCommit, 8)}`);
  if (record.event.cumulative.length > 10) {
    items.push(`…另有 ${record.event.cumulative.length - 10} 项，请查看完整差异。`);
  }
  return items.length > 0 ? items : ['当前窗口没有可识别的 merge 项。'];
}

function actionButton(record: CustomReleaseEventRecord): Record<string, unknown> | undefined {
  const canFreeze = record.state.status === 'delivered' || record.state.status === 'freeze_failed';
  const canPromote = record.state.status === 'frozen' || record.state.status === 'promote_failed';
  if (!canFreeze && !canPromote) return undefined;
  const action = canPromote ? 'custom_release_promote' : 'custom_release_freeze';
  const label = canPromote
    ? `${record.state.status === 'promote_failed' ? '重新' : ''}推进 ${record.event.production.branch}`
    : `${record.state.status === 'freeze_failed' ? '重新' : ''}冻结 ${record.event.release.pendingVersion}`;
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: 'default',
    columns: [{
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'center',
      elements: [{
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: label,
        },
        type: 'primary',
        behaviors: [{
          type: 'callback',
          value: {
            action,
            event_id: record.event.eventId,
          },
        }],
      }],
    }],
  };
}

/** 构造独立私聊卡；当前发布阶段的唯一下一步按钮始终位于 body 末尾。 */
export function buildCustomReleaseSummaryCard(record: CustomReleaseEventRecord): string {
  const { event } = record;
  const current = event.current;
  const totals = event.totals;
  const compareUrl = `https://github.com/${event.repository}/compare/${event.release.baseHead}...${event.integration.head}`;
  const body = [
    '**本次合入**',
    `- ${text(event.source.title)}`,
    `- 来源：${code(event.source.ref)} @ ${code(event.source.head, 8)}`,
    `- 合入：${code(event.integration.branch)} @ ${code(event.integration.head, 8)}`,
    `- 规模：${current.commits} commits，${current.files} files，${signed(current.insertions)}/${signed(-current.deletions)}`,
    '',
    '**当前版本累计改动**',
    ...cumulativeLines(record),
    '',
    '**发布状态**',
    `- 基线：${code(event.release.baseRef)} @ ${code(event.release.baseHead, 8)}`,
    `- 待发：${code(event.integration.branch)} @ ${code(event.integration.head, 8)}`,
    `- 累计：${totals.commits} commits，${totals.files} files，${signed(totals.insertions)}/${signed(-totals.deletions)}`,
    ...statusLines(record),
    `[查看完整差异](${compareUrl})`,
  ].join('\n');
  const elements: Record<string, unknown>[] = [{ tag: 'markdown', content: body }];
  const button = actionButton(record);
  if (button) elements.push(button);
  const template = record.state.status === 'frozen' || record.state.status === 'promoted'
    ? 'green'
    : record.state.status === 'stale'
      || record.state.status === 'freeze_failed'
      || record.state.status === 'promote_failed'
      ? 'orange'
      : 'blue';
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template,
      title: { tag: 'plain_text', content: `待发版 ${event.release.pendingVersion} 已更新` },
    },
    body: { direction: 'vertical', elements },
  });
}
