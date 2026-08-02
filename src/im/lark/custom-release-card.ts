/** 自定义待发版私聊汇总卡：展示本次合入、版本累计和 HEAD 绑定冻结入口。 */
import type { CustomReleaseEventRecord } from '../../services/custom-release-event.js';
import { releaseTimelineDurations } from '../../core/custom-release-timeline.js';

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
      `下一步：点击下方“推进并部署 ${code(event.release.pendingVersion)}”。按钮点击本身即授权推进生产、构建、切换运行版本并重启。`,
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
      `下一步：点击下方“部署并重启 ${code(event.release.pendingVersion)}”。按钮点击本身即为部署授权。`,
    ];
  }
  if (state.status === 'deploying') {
    return [
      `⏳ 正在推进并部署 ${code(state.candidateTag ?? `release/v${event.release.pendingVersion}`)}。`,
      '将依次更新生产分支、构建、切换 wrapper 并重启；新 daemon 会继续验收并回写结果。',
    ];
  }
  if (state.status === 'deploy_failed') {
    return [
      `❌ ${code(event.release.pendingVersion)} 尚未完成部署。`,
      state.lastError ? `原因：${text(state.lastError)}` : '',
    ].filter(Boolean);
  }
  if (state.status === 'deployed') {
    return [
      `✅ 已部署 ${code(state.deployTag ?? `deploy/v${event.release.pendingVersion}`)}。`,
      `生产与运行 HEAD：${code(state.productionHead ?? event.integration.head, 8)}。`,
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

const STATUS_LABELS: Record<string, string> = {
  queued: '排队', delivering: '投递', delivered: '待冻结', freezing: '冻结验证',
  frozen: '候选已冻结', deploying: '推进与部署', deployed: '运行态验收完成',
  delivery_failed: '投递失败', freeze_failed: '冻结失败', promote_failed: '推进失败',
  deploy_failed: '部署失败', stale: '候选过期', promoted: '已推进', promoting: '推进中',
};

function timelineLines(record: CustomReleaseEventRecord): string[] {
  const entries = releaseTimelineDurations(record.state.timeline, record.state.updatedAt).slice(-8);
  if (entries.length === 0) return [];
  return [
    '',
    '**发布时间线**',
    ...entries.map(entry => {
      const seconds = Math.round(entry.durationMs / 100) / 10;
      return `- ${text(STATUS_LABELS[entry.status] ?? entry.status)} · ${seconds}s`;
    }),
  ];
}

function actionButton(record: CustomReleaseEventRecord): Record<string, unknown> | undefined {
  const canFreeze = record.state.status === 'delivered' || record.state.status === 'freeze_failed';
  const canPromote = record.state.status === 'frozen'
    || record.state.status === 'promote_failed'
    || record.state.status === 'promoted'
    || record.state.status === 'deploy_failed';
  if (!canFreeze && !canPromote) return undefined;
  const action = canPromote ? 'custom_release_promote' : 'custom_release_freeze';
  const label = canPromote
    ? record.state.status === 'promoted'
      ? `部署并重启 ${record.event.release.pendingVersion}`
      : `${record.state.status === 'promote_failed' || record.state.status === 'deploy_failed' ? '重新' : ''}推进并部署 ${record.event.release.pendingVersion}`
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
    ...timelineLines(record),
    `[查看完整差异](${compareUrl})`,
  ].join('\n');
  const elements: Record<string, unknown>[] = [{ tag: 'markdown', content: body }];
  const button = actionButton(record);
  if (button) elements.push(button);
  const template = record.state.status === 'frozen' || record.state.status === 'promoted' || record.state.status === 'deployed'
    ? 'green'
    : record.state.status === 'stale'
      || record.state.status === 'freeze_failed'
      || record.state.status === 'promote_failed'
      || record.state.status === 'deploy_failed'
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
