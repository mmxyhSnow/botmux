/**
 * use:here 的版本化运行模式测试：wrapper 永远走 current，rollback 由 controller 接管。
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

function releaseRoot(home: string, version: string): string {
  const root = join(home, '.botmux', 'releases', version);
  const dist = join(root, 'dist');
  const commit = version.endsWith('.10') ? '1'.repeat(40) : '2'.repeat(40);
  const buildId = version.endsWith('.10') ? '3'.repeat(64) : '4'.repeat(64);
  mkdirSync(dist, { recursive: true });
  for (const file of ['cli.js', 'index-daemon.js', 'dashboard.js']) {
    writeFileSync(join(dist, file), 'export {};\n');
  }
  writeFileSync(join(dist, '.runtime-build-id'), `${buildId}\n`);
  writeFileSync(join(dist, '.botmux-runtime-release.json'), `${JSON.stringify({
    schemaVersion: 1,
    releaseTag: `release/${version}`,
    deployTag: `deploy/${version}`,
    commit,
    runtimeBuildId: buildId,
    createdAt: '2026-08-02T01:00:00.000Z',
  })}\n`);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('claim-botmux-bin runtime release mode', () => {
  it('原子更新 current，wrapper 普通命令走 current、rollback 走 controller', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-claim-runtime-'));
    roots.push(home);
    const first = releaseRoot(home, 'v3.7.1-custom.10');
    const second = releaseRoot(home, 'v3.7.1-custom.11');
    const script = join(process.cwd(), 'scripts', 'claim-botmux-bin.mjs');
    const env = { ...process.env, HOME: home };

    execFileSync(process.execPath, [script, '--runtime-release', first], { env });
    execFileSync(process.execPath, [script, '--runtime-release', second], { env });

    expect(readlinkSync(join(home, '.botmux', 'runtime', 'current'))).toBe(second);
    const wrapper = readFileSync(join(home, '.botmux', 'bin', 'botmux'), 'utf8');
    expect(wrapper).toContain(join(home, '.botmux', 'runtime', 'current', 'dist', 'cli.js'));
    expect(wrapper).toContain(join(home, '.botmux', 'runtime', 'controller', 'dist', 'cli.js'));
    expect(wrapper).toContain('"$1" = "rollback"');
    expect(wrapper).not.toContain(`${second}/dist/cli.js`);
  });

  it('目标身份不完整时拒绝改写 current 和 wrapper', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-claim-runtime-invalid-'));
    roots.push(home);
    const invalid = join(home, 'invalid-release');
    mkdirSync(invalid, { recursive: true });
    const script = join(process.cwd(), 'scripts', 'claim-botmux-bin.mjs');

    expect(() => execFileSync(process.execPath, [script, '--runtime-release', invalid], {
      env: { ...process.env, HOME: home },
      stdio: 'pipe',
    })).toThrow();
  });
});
