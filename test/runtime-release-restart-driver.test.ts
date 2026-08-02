/**
 * 脱离式重启驱动测试：目标版本启动失败时必须把 current 切回旧版本并恢复服务。
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

function runtime(root: string, version: string, restartCode: number): string {
  const target = join(root, 'releases', version);
  const dist = join(target, 'dist');
  const pm2 = join(target, 'node_modules', 'pm2', 'bin');
  const commit = version.endsWith('.10') ? '1'.repeat(40) : '2'.repeat(40);
  const buildId = version.endsWith('.10') ? '3'.repeat(64) : '4'.repeat(64);
  mkdirSync(dist, { recursive: true });
  mkdirSync(pm2, { recursive: true });
  writeFileSync(join(dist, 'cli.js'), [
    '#!/usr/bin/env node',
    `require('node:fs').appendFileSync(process.env.RESTART_MARKER, ${JSON.stringify(`${version}\n`)});`,
    `process.exit(${restartCode});`,
  ].join('\n'));
  for (const file of ['index-daemon.js', 'dashboard.js']) writeFileSync(join(dist, file), 'export {};\n');
  writeFileSync(join(dist, '.runtime-build-id'), `${buildId}\n`);
  writeFileSync(join(dist, '.botmux-runtime-release.json'), JSON.stringify({
    schemaVersion: 1,
    releaseTag: `release/${version}`,
    deployTag: `deploy/${version}`,
    commit,
    runtimeBuildId: buildId,
    createdAt: '2026-08-02T01:00:00.000Z',
  }));
  writeFileSync(join(pm2, 'pm2'), [
    '#!/usr/bin/env node',
    `process.stdout.write(JSON.stringify([`,
    `{name:'botmux-0',pm2_env:{status:'online',pm_exec_path:${JSON.stringify(join(dist, 'index-daemon.js'))}}},`,
    `{name:'botmux-dashboard',pm2_env:{status:'online',pm_exec_path:${JSON.stringify(join(dist, 'dashboard.js'))}}}`,
    `]));`,
  ].join('\n'));
  chmodSync(join(pm2, 'pm2'), 0o755);
  return target;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runtime release restart driver', () => {
  it('全部 PM2 路径验收通过后写入绑定目标身份的新鲜回执', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'botmux-runtime-driver-'));
    roots.push(configRoot);
    const target = runtime(configRoot, 'v3.7.1-custom.11', 0);
    const rollback = runtime(configRoot, 'v3.7.1-custom.10', 0);
    const runtimeDir = join(configRoot, 'runtime');
    const marker = join(configRoot, 'restart-marker.txt');
    mkdirSync(runtimeDir, { recursive: true });
    symlinkSync(target, join(runtimeDir, 'current'), 'dir');

    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'scripts', 'runtime-release-restart.mjs'),
      '--target', target,
      '--rollback', rollback,
      '--config-root', configRoot,
    ], { encoding: 'utf8', env: { ...process.env, RESTART_MARKER: marker } });

    expect(result.status).toBe(0);
    const receipt = JSON.parse(readFileSync(join(runtimeDir, 'activation-receipt.json'), 'utf8'));
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      targetRoot: target,
      commit: '2'.repeat(40),
      runtimeBuildId: '4'.repeat(64),
    });
  });

  it('目标重启失败后恢复旧 current，并用旧版本再启动一次', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'botmux-runtime-driver-'));
    roots.push(configRoot);
    const target = runtime(configRoot, 'v3.7.1-custom.11', 1);
    const rollback = runtime(configRoot, 'v3.7.1-custom.10', 0);
    const runtimeDir = join(configRoot, 'runtime');
    const marker = join(configRoot, 'restart-marker.txt');
    mkdirSync(runtimeDir, { recursive: true });
    symlinkSync(target, join(runtimeDir, 'current'), 'dir');

    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'scripts', 'runtime-release-restart.mjs'),
      '--target', target,
      '--rollback', rollback,
      '--config-root', configRoot,
    ], { encoding: 'utf8', env: { ...process.env, RESTART_MARKER: marker } });

    expect(result.status).toBe(1);
    expect(readlinkSync(join(runtimeDir, 'current'))).toBe(rollback);
    expect(readFileSync(marker, 'utf8')).toBe('v3.7.1-custom.11\nv3.7.1-custom.10\n');
    expect(result.stderr).toContain('已恢复');
    expect(() => readFileSync(join(runtimeDir, 'activation-receipt.json'), 'utf8')).toThrow();
  });
});
