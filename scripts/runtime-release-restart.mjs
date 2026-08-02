#!/usr/bin/env node
/**
 * 版本化运行目录的脱离式重启驱动。
 * 新版本重启或 PM2 回读失败时，原子切回 rollback 目录并恢复旧服务。
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

function value(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? '' : '';
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function validatedRoot(raw, label) {
  if (!raw || !isAbsolute(raw)) fail(`${label} 必须是绝对路径`);
  const root = realpathSync(resolve(raw));
  const dist = join(root, 'dist');
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(dist, '.botmux-runtime-release.json'), 'utf8')); }
  catch { fail(`${label} 缺少运行身份清单`); }
  const release = typeof manifest?.releaseTag === 'string'
    ? manifest.releaseTag.match(/^release\/(v\d+\.\d+\.\d+-custom\.\d+)$/)
    : null;
  if (
    manifest?.schemaVersion !== 1
    || !release
    || manifest.deployTag !== `deploy/${release[1]}`
    || !/^[0-9a-f]{40}$/.test(manifest.commit ?? '')
    || !/^[0-9a-f]{64}$/.test(manifest.runtimeBuildId ?? '')
    || readFileSync(join(dist, '.runtime-build-id'), 'utf8').trim() !== manifest.runtimeBuildId
  ) fail(`${label} 运行身份无效`);
  for (const entry of ['cli.js', 'index-daemon.js', 'dashboard.js']) {
    if (!existsSync(join(dist, entry))) fail(`${label} 缺少 ${entry}`);
  }
  return { root, manifest };
}

function activate(configRoot, targetRoot) {
  const current = join(configRoot, 'runtime', 'current');
  if (existsSync(current) && !lstatSync(current).isSymbolicLink()) fail(`current 不是 symlink：${current}`);
  const tmp = `${current}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  try {
    symlinkSync(targetRoot, tmp, 'dir');
    renameSync(tmp, current);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 未创建或已 rename。 */ }
    throw error;
  }
}

function restart(root, configRoot) {
  const env = {
    ...process.env,
    BOTMUX_RESTART_LEASE_DIR: process.env.BOTMUX_RESTART_LEASE_DIR || join(configRoot, 'data'),
  };
  const result = spawnSync(process.execPath, [join(root, 'dist', 'cli.js'), 'restart'], {
    cwd: homedir(),
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `exit ${result.status ?? 'spawn'}`).trim().slice(-2000));
  }
}

function verify(root, configRoot) {
  const pm2Bin = join(root, 'node_modules', 'pm2', 'bin', 'pm2');
  if (!existsSync(pm2Bin)) throw new Error('运行目录缺少 pm2 CLI');
  const result = spawnSync(process.execPath, [pm2Bin, 'jlist'], {
    cwd: homedir(),
    env: { ...process.env, PM2_HOME: join(configRoot, 'pm2') },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'PM2 回读失败').trim().slice(-1000));
  let apps;
  try { apps = JSON.parse(result.stdout || '[]'); }
  catch { throw new Error('PM2 回读不是有效 JSON'); }
  const core = apps.filter(app => {
    const name = String(app?.name ?? '');
    return name === 'botmux' || (name.startsWith('botmux-') && !name.startsWith('botmux-plugin-'));
  });
  if (core.length < 2) throw new Error('PM2 核心进程数量不足');
  const dist = realpathSync(join(root, 'dist'));
  for (const app of core) {
    const execPath = app?.pm2_env?.pm_exec_path;
    if (
      app?.pm2_env?.status !== 'online'
      || typeof execPath !== 'string'
      || !realpathSync(execPath).startsWith(`${dist}/`)
    ) throw new Error(`PM2 进程未运行目标目录：${String(app?.name ?? 'unknown')}`);
  }
}

/** 原子写入本轮 PM2 全路径验收回执，供新 daemon 在创建 deploy tag 前等待。 */
function writeActivationReceipt(target, configRoot) {
  const runtimeDir = join(configRoot, 'runtime');
  const path = join(runtimeDir, 'activation-receipt.json');
  const tmp = `${path}.${process.pid}.tmp`;
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(tmp, `${JSON.stringify({
    schemaVersion: 1,
    targetRoot: target.root,
    commit: target.manifest.commit,
    runtimeBuildId: target.manifest.runtimeBuildId,
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

const target = validatedRoot(value('--target'), 'target');
const rollback = validatedRoot(value('--rollback'), 'rollback');
const configRoot = resolve(value('--config-root') || join(homedir(), '.botmux'));
const receiptPath = join(configRoot, 'runtime', 'activation-receipt.json');
rmSync(receiptPath, { force: true });

try {
  restart(target.root, configRoot);
  verify(target.root, configRoot);
  writeActivationReceipt(target, configRoot);
  process.stdout.write(`版本化运行目录已启动：${target.manifest.deployTag}\n`);
} catch (error) {
  const targetFailure = error instanceof Error ? error.message : String(error);
  try {
    activate(configRoot, rollback.root);
    restart(rollback.root, configRoot);
    verify(rollback.root, configRoot);
  } catch (restoreError) {
    fail(`目标版本启动失败，且恢复旧版本失败：${targetFailure}；${restoreError instanceof Error ? restoreError.message : restoreError}`);
  }
  fail(`目标版本启动失败，已恢复 ${rollback.manifest.deployTag}：${targetFailure}`);
}
