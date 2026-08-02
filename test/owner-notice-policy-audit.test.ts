/** 主动通知源码门禁测试：同时证明当前仓库合规，并证明典型旁路会让审计失败。 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');
const auditScript = resolve(repoRoot, 'scripts/audit-owner-notices.mjs');
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function audit(root: string): string {
  return execFileSync(process.execPath, [auditScript, '--root', root], { encoding: 'utf8' });
}

describe('owner notice architecture audit', () => {
  it('当前生产源码只通过统一入口访问主动通知底层能力', () => {
    expect(audit(repoRoot)).toContain('Owner notice architecture audit passed');
  });

  it('直接导入底层 store 或私信 owner 时 fail closed', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-owner-notice-audit-'));
    tempRoots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'rogue.ts'), [
      "import { upsertOwnerNoticeCard } from './services/owner-notice-card-store.js';",
      "import { sendUserMessage } from './im/lark/client.js';",
      "void upsertOwnerNoticeCard({});",
      "void sendUserMessage('cli_a', ownerOpenId, 'plain text', 'text');",
    ].join('\n'));

    expect(() => audit(root)).toThrow(/Command failed/);
  });
});
