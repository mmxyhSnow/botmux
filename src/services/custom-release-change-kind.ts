/**
 * 待发版累计改动的类型归一化。
 *
 * 优先信任 source branch，其次读取 Conventional Commit 类型；无法确认时不展示标签，
 * 避免仅凭中文标题猜测 feat、bugfix 或 opt。
 */
export type CustomReleaseChangeKind = 'feat' | 'bugfix' | 'opt';

const KIND_BY_TOKEN: Record<string, CustomReleaseChangeKind> = {
  feat: 'feat',
  feature: 'feat',
  fix: 'bugfix',
  bugfix: 'bugfix',
  hotfix: 'bugfix',
  opt: 'opt',
  perf: 'opt',
  refactor: 'opt',
};

function branchKind(sourceRef: string | undefined): CustomReleaseChangeKind | undefined {
  const token = sourceRef?.toLowerCase().match(
    /(?:^|\/)(feat|feature|fix|bugfix|hotfix|opt|perf|refactor)(?:[\/_-]|$)/,
  )?.[1];
  return token ? KIND_BY_TOKEN[token] : undefined;
}

function subjectKind(subject: string | undefined): CustomReleaseChangeKind | undefined {
  const token = subject?.trim().toLowerCase().match(
    /^(feat|feature|fix|bugfix|hotfix|opt|perf|refactor)(?:\([^)]*\))?!?:/,
  )?.[1];
  return token ? KIND_BY_TOKEN[token] : undefined;
}

/** 按分支、源提交标题、展示标题的可信度顺序归一化改动类型。 */
export function classifyCustomReleaseChange(input: {
  sourceRef?: string;
  sourceSubject?: string;
  title?: string;
}): CustomReleaseChangeKind | undefined {
  return branchKind(input.sourceRef)
    ?? subjectKind(input.sourceSubject)
    ?? subjectKind(input.title);
}
