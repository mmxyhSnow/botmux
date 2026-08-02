/**
 * 版本化运行 worktree 清理执行器。
 * 计划来自 runtime-release 的只读判定，删除只通过 git worktree remove，不直接 rm 目录。
 */
import { spawn } from 'node:child_process';
import { planRuntimeReleaseCleanup } from './runtime-release.js';

export interface RuntimeCleanupResult {
  planned: string[];
  removed: string[];
  failed: Array<{ root: string; reason: string }>;
}

export interface RuntimeCleanupDeps {
  run(command: string, args: string[], cwd: string): Promise<{ code: number; output: string }>;
}

function runCommand(command: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const capture = (chunk: Buffer | string): void => {
      output = (output + String(chunk)).slice(-4_000);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', reject);
    child.once('close', code => resolve({ code: code ?? 1, output }));
  });
}

const PRODUCTION_DEPS: RuntimeCleanupDeps = { run: runCommand };

/** apply=false 只返回计划；apply=true 逐个移除并保留逐项失败证据。 */
export async function cleanupRuntimeReleaseWorktrees(
  configRoot: string,
  gitRoot: string,
  options: { keep?: number; apply?: boolean } = {},
  deps: RuntimeCleanupDeps = PRODUCTION_DEPS,
): Promise<RuntimeCleanupResult> {
  const plan = planRuntimeReleaseCleanup(configRoot, options.keep ?? 3);
  const result: RuntimeCleanupResult = {
    planned: plan.removable.map(record => record.root),
    removed: [],
    failed: [],
  };
  if (!options.apply) return result;
  for (const record of plan.removable) {
    const removal = await deps.run('git', ['worktree', 'remove', record.root], gitRoot);
    if (removal.code === 0) result.removed.push(record.root);
    else result.failed.push({
      root: record.root,
      reason: removal.output.trim().slice(-1_000) || `exit ${removal.code}`,
    });
  }
  if (result.removed.length > 0) await deps.run('git', ['worktree', 'prune'], gitRoot);
  return result;
}
