/** 发布专用 Node/pnpm 版本门禁；读取 package.json 的唯一声明，不在脚本中复制版本号。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function major(version) {
  return Number(String(version).match(/v?(\d+)\./)?.[1] ?? 0);
}

/** 返回可结构化展示的运行环境，任何不一致直接拒绝继续发布。 */
export function assertReleaseToolchain(repoRoot, run) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const expectedPnpm = String(pkg.packageManager ?? '').match(/^pnpm@(.+)$/)?.[1];
  const requiredNode = Number(String(pkg.engines?.node ?? '').match(/>=\s*(\d+)/)?.[1] ?? 0);
  if (!expectedPnpm || !requiredNode) throw new Error('package.json 缺少有效的 packageManager/engines.node');
  const actualNode = process.version;
  if (major(actualNode) < requiredNode) {
    throw new Error(`Node 版本不满足发布要求：需要 >=${requiredNode}，当前 ${actualNode}`);
  }
  const actualPnpm = run('pnpm', ['--version'], repoRoot).trim();
  if (actualPnpm !== expectedPnpm) {
    throw new Error(`pnpm 版本不一致：需要 ${expectedPnpm}，当前 ${actualPnpm || 'unknown'}；请使用 Corepack`);
  }
  return { node: actualNode, pnpm: actualPnpm };
}
