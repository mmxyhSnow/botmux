/** `botmux worktree` 只管理 Botmux 自己的版本化运行目录，不触碰其它开发 worktree。 */
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { config } from '../config.js';
import { botmuxInstallRoot } from '../utils/install-info.js';
import { planRuntimeReleaseCleanup } from '../core/runtime-release.js';
import { cleanupRuntimeReleaseWorktrees } from '../core/runtime-release-cleanup.js';

function configRoot(): string {
  const dataRoot = config.session.dataDir;
  return basename(dataRoot) === 'data' ? dirname(dataRoot) : join(homedir(), '.botmux');
}

export async function runRuntimeWorktreeCommand(args: string[]): Promise<number> {
  const action = args[0] ?? 'doctor';
  const json = args.includes('--json');
  const plan = planRuntimeReleaseCleanup(configRoot(), 3);
  if (action === 'doctor') {
    const body = {
      ok: true,
      keep: plan.keep,
      protected: plan.protectedRoots,
      retained: plan.retained.map(item => item.manifest.deployTag),
      unused: plan.removable.map(item => ({ tag: item.manifest.deployTag, root: item.root })),
    };
    console.log(json ? JSON.stringify(body, null, 2) : [
      `运行 worktree：保留 ${body.retained.length}，可清理 ${body.unused.length}`,
      ...body.unused.map(item => `- ${item.tag}  ${item.root}`),
    ].join('\n'));
    return 0;
  }
  if (action !== 'clean' || !args.includes('--unused')) {
    console.error('用法: botmux worktree doctor [--json] | worktree clean --unused [--dry-run|--apply] [--json]');
    return 2;
  }
  const apply = args.includes('--apply');
  const result = await cleanupRuntimeReleaseWorktrees(
    configRoot(),
    botmuxInstallRoot(),
    { keep: 3, apply },
  );
  console.log(json ? JSON.stringify({ ok: result.failed.length === 0, dryRun: !apply, ...result }, null, 2) : [
    apply ? `已清理 ${result.removed.length} 个运行 worktree` : `Dry-run：将清理 ${result.planned.length} 个运行 worktree`,
    ...result.planned.map(root => `- ${root}`),
    ...result.failed.map(item => `! ${item.root}: ${item.reason}`),
  ].join('\n'));
  return result.failed.length === 0 ? 0 : 1;
}
