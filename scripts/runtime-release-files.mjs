/**
 * 官方同步脚本使用的版本化运行文件操作。
 * 这里不推进 Git 分支，只负责 current 身份、manifest 与切换前灾备快照。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 解析 current 的真实 Git 根；缺少版本化指针时拒绝从旧模型直接升级。 */
export function runtimeCurrentRoot(git) {
  const current = join(homedir(), '.botmux', 'runtime', 'current');
  if (!existsSync(current)) throw new Error('版本化 current 不存在，拒绝从旧部署模型直接同步官方版本');
  return git(current, ['rev-parse', '--show-toplevel']);
}

/** 把候选 tag、commit 与构建指纹固化到 dist，供切换和重启门禁回读。 */
export function writeRuntimeManifest(root, releaseTag, commit) {
  const version = releaseTag.slice('release/'.length);
  const runtimeBuildId = readFileSync(join(root, 'dist', '.runtime-build-id'), 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(runtimeBuildId)) throw new Error('版本化运行产物 build-id 无效');
  writeFileSync(join(root, 'dist', '.botmux-runtime-release.json'), `${JSON.stringify({
    schemaVersion: 1,
    releaseTag,
    deployTag: `deploy/${version}`,
    commit,
    runtimeBuildId,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
}

/** 在 current flip 前备份实际活跃 dist；deploy tag 仍是版本真源，快照只作灾备。 */
export function backupActiveDist(activeRoot, deployVersion) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = join(homedir(), '.botmux', 'backups', `${stamp}-${deployVersion}`);
  mkdirSync(backupRoot, { recursive: true });
  cpSync(join(activeRoot, 'dist'), join(backupRoot, 'dist'), { recursive: true, errorOnExist: true });
  writeFileSync(join(backupRoot, 'metadata.json'), `${JSON.stringify({
    schemaVersion: 1,
    deployTag: `deploy/${deployVersion}`,
    sourceRoot: activeRoot,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
}
