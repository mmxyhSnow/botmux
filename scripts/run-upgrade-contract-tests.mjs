#!/usr/bin/env node
/** 从能力清单生成唯一测试集合，确保升级验收不会手工漏掉新增能力。 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { auditCustomCapabilities } from './lib/custom-capabilities.mjs';

const root = resolve(process.cwd());
const result = auditCustomCapabilities(root);
if (result.violations.length > 0) {
  for (const violation of result.violations) console.error(`- ${violation}`);
  process.exit(1);
}

const child = spawnSync('corepack', ['pnpm@9.5.0', 'exec', 'vitest', 'run', '--project', 'unit', ...result.tests], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
if (child.error) throw child.error;
process.exit(child.status ?? 1);
