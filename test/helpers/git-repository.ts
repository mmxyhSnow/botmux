/** Git 测试仓夹具：统一使用 Git 2.20 也支持的命令初始化指定默认分支。 */
import { execFileSync } from 'node:child_process';

/** 初始化空仓并设置 unborn HEAD；调用方随后可直接创建首个提交。 */
export function initGitRepository(cwd: string, branch: string): void {
  execFileSync('git', ['init', '-q'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['check-ref-format', '--branch', branch], { cwd, stdio: 'pipe' });
  execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd, stdio: 'pipe' });
}
