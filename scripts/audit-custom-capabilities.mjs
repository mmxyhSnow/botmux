#!/usr/bin/env node
/** 自定义能力清单审计入口；供 build、官方升级 verify 和人工诊断复用。 */
import { resolve } from 'node:path';
import { auditCustomCapabilities } from './lib/custom-capabilities.mjs';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = resolve(rootIndex >= 0 ? args[rootIndex + 1] ?? '' : process.cwd());

try {
  const result = auditCustomCapabilities(root);
  if (result.violations.length > 0) {
    console.error(`Custom capability audit failed (${result.violations.length}):`);
    for (const violation of result.violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(`Custom capability audit passed (${result.manifest.capabilities.length} capabilities, ${result.tests.length} tests)`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
