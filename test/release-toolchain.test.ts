/** 发布工具链门禁测试：环境必须精确服从 package.json 声明。 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertReleaseToolchain } from '../scripts/lib/release-toolchain.mjs';

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-toolchain-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    packageManager: 'pnpm@9.5.0',
    engines: { node: '>=22' },
  }));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('release toolchain', () => {
  it('声明与实际一致时通过', () => {
    expect(assertReleaseToolchain(fixture(), () => '9.5.0\n').pnpm).toBe('9.5.0');
  });

  it('pnpm 漂移时在任何 install/build 前失败', () => {
    expect(() => assertReleaseToolchain(fixture(), () => '11.15.1\n'))
      .toThrow(/pnpm 版本不一致/);
  });
});
