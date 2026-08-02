/**
 * 版本化运行目录的脱离式重启驱动入口。
 * 该模块只负责稳定启动外部恢复驱动，部署卡和官方同步共同复用。
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { config } from '../config.js';
import {
  detachedRestartEnv,
  globalInstallUpdateCwd,
  globalInstallUpdateLockTarget,
  maintenanceRestartLogPath,
} from './maintenance.js';

/** 配置根优先跟随当前 daemon 的 dataDir，兼容非默认安装位置。 */
function runtimeConfigRoot(): string {
  return basename(config.session.dataDir) === 'data'
    ? dirname(config.session.dataDir)
    : dirname(globalInstallUpdateLockTarget());
}

/** 启动独立驱动；目标启动失败时驱动仍存活，可原子切回 rollbackRoot。 */
export function spawnRuntimeRestartDriver(
  releaseRoot: string,
  rollbackRoot: string,
  leaseId: string,
): ReturnType<typeof spawn> {
  const driver = join(releaseRoot, 'scripts', 'runtime-release-restart.mjs');
  if (!existsSync(driver)) throw new Error('版本化运行目录缺少重启恢复驱动');
  const nodeArgs = [
    driver,
    '--target', releaseRoot,
    '--rollback', rollbackRoot,
    '--config-root', runtimeConfigRoot(),
  ];
  const setsid = ['/usr/bin/setsid', '/bin/setsid'].find(existsSync);
  const command = setsid ?? process.execPath;
  const args = setsid ? [process.execPath, ...nodeArgs] : nodeArgs;
  const logPath = maintenanceRestartLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  writeSync(fd, `\n[${new Date().toISOString()}] launching versioned runtime restart\n`);
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', fd, fd],
    cwd: globalInstallUpdateCwd(),
    env: {
      ...detachedRestartEnv(),
      BOTMUX_RESTART_LEASE_ID: leaseId,
      BOTMUX_RESTART_LEASE_DIR: config.session.dataDir,
    },
  });
  child.on('error', () => undefined);
  child.unref();
  closeSync(fd);
  return child;
}
