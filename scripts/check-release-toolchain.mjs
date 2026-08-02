#!/usr/bin/env node
/** 独立发布环境检查入口，供冻结、官方同步和版本化运行构建共同调用。 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleaseToolchain } from './lib/release-toolchain.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} 失败`);
  return String(result.stdout ?? '');
};

try {
  process.stdout.write(`${JSON.stringify({ ok: true, ...assertReleaseToolchain(root, run) })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
