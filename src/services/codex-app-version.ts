/**
 * Codex App 版本探测。
 *
 * 来源：runner 需要在启动 app-server 前决定是否启用实验能力，同时复用同一版本
 * 判断结构化输入字段，避免每轮重复启动 `codex --version`。
 */
import { spawnSync } from 'node:child_process';
import {
  parseCodexVersion,
  type CodexVersion,
} from '../adapters/cli/codex-app-turn.js';

/** 同步读取当前 runner 实际绑定的 Codex 版本；探测失败返回 undefined。 */
export function detectCodexAppVersion(
  codexBin: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): CodexVersion | undefined {
  try {
    const result = spawnSync(codexBin, ['--version'], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    return parseCodexVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  } catch {
    return undefined;
  }
}
