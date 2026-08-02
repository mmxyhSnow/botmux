#!/usr/bin/env node
// 认领全局 `botmux`：把 ~/.botmux/bin/botmux 的瘦 wrapper 重写为指向「本 checkout」
// 的 dist/cli.js。供 `pnpm use:here` / `pnpm switch:here` 显式调用 —— 故意不挂进
// `build`，避免 review/验证别人 PR 时一次纯编译就悄悄抢走全局 botmux 的指向。
//
// 写入内容与 daemon 启动时写的 wrapper 完全一致（见 src/daemon.ts），所以两者幂等：
// 「在哪 build+use，全局 botmux 就指哪；下次 daemon restart-from-dir 再覆盖」均自洽。
import { fileURLToPath } from 'node:url';
import { dirname, basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

// 原子写（与 src/utils/atomic-write.ts 同构，.mjs 不依赖 dist 故内联）：
// 这个 wrapper 随时被并发会话 exec，裸写半截会让它们的 `botmux send` 全体失败。
// 同构三要素缺一不可：①写前 realpath 穿透 symlink（否则把链接本体 rename 成
// 普通文件）②唯一 tmp 名 ③写后显式 chmod（creation mode 被 umask 截断，
// umask 077 下 0o755 会落成 0o700）。
function atomicWriteFileSync(filePath, data, mode) {
  try { filePath = realpathSync(filePath); }
  catch {
    try { filePath = join(realpathSync(dirname(filePath)), basename(filePath)); }
    catch { /* 父目录也不存在，保持原路径 */ }
  }
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  try {
    writeFileSync(tmp, data, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp 可能根本没写出来 */ }
    throw err;
  }
}

// 逃生阀：偶尔只想 build 不想抢全局时 `BOTMUX_NO_CLAIM=1 pnpm use:here`
if (process.env.BOTMUX_NO_CLAIM) {
  console.log('↪︎ BOTMUX_NO_CLAIM 已设，跳过认领全局 botmux');
  process.exit(0);
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const binDir = join(homedir(), '.botmux', 'bin');
const wrapper = join(binDir, 'botmux');
const runtimeDir = join(homedir(), '.botmux', 'runtime');
const currentLink = join(runtimeDir, 'current');
const controllerLink = join(runtimeDir, 'controller');
const targetIndex = process.argv.indexOf('--runtime-release');
const targetRoot = targetIndex >= 0 ? resolve(process.argv[targetIndex + 1] ?? '') : '';

/** 只接受构建完成、tag/commit/build-id 自洽的版本目录。 */
function validateRuntimeRelease(root) {
  const dist = join(root, 'dist');
  const manifestPath = join(dist, '.botmux-runtime-release.json');
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch { throw new Error(`运行版本身份清单不可读：${manifestPath}`); }
  const release = typeof manifest?.releaseTag === 'string'
    ? manifest.releaseTag.match(/^release\/(v\d+\.\d+\.\d+-custom\.\d+)$/)
    : null;
  if (
    manifest?.schemaVersion !== 1
    || !release
    || manifest.deployTag !== `deploy/${release[1]}`
    || !/^[0-9a-f]{40}$/.test(manifest.commit ?? '')
    || !/^[0-9a-f]{64}$/.test(manifest.runtimeBuildId ?? '')
  ) throw new Error(`运行版本身份清单无效：${manifestPath}`);
  const buildId = readFileSync(join(dist, '.runtime-build-id'), 'utf8').trim();
  if (buildId !== manifest.runtimeBuildId) throw new Error('运行版本 build-id 与身份清单不一致');
  for (const entry of ['cli.js', 'index-daemon.js', 'dashboard.js']) {
    if (!existsSync(join(dist, entry))) throw new Error(`运行版本缺少 ${entry}`);
  }
  return realpathSync(root);
}

/** 通过同目录临时 symlink + rename 原子替换 current。 */
function activateRuntimeRelease(root) {
  const target = validateRuntimeRelease(root);
  mkdirSync(runtimeDir, { recursive: true });
  if (existsSync(currentLink) && !lstatSync(currentLink).isSymbolicLink()) {
    throw new Error(`current 不是 symlink，拒绝覆盖：${currentLink}`);
  }
  const tmp = `${currentLink}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  try {
    symlinkSync(target, tmp, 'dir');
    renameSync(tmp, currentLink);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 未创建或已 rename。 */ }
    throw error;
  }
  return target;
}

const activeRoot = targetRoot ? activateRuntimeRelease(targetRoot) : repoRoot;
const cliScript = targetRoot ? join(currentLink, 'dist', 'cli.js') : join(activeRoot, 'dist', 'cli.js');
const content = targetRoot
  ? [
      '#!/bin/sh',
      `if [ "$1" = "rollback" ] && [ -f "${join(controllerLink, 'dist', 'cli.js')}" ]; then`,
      `  exec node "${join(controllerLink, 'dist', 'cli.js')}" "$@"`,
      'fi',
      `exec node "${cliScript}" "$@"`,
      '',
    ].join('\n')
  : `#!/bin/sh\nexec node "${cliScript}" "$@"\n`;

if (!existsSync(cliScript)) {
  console.warn(`⚠️  ${cliScript} 还不存在——先 \`pnpm build\`（或用 \`pnpm switch:here\`）。wrapper 仍按此路径写入。`);
}

try {
  mkdirSync(binDir, { recursive: true });
  let existing = '';
  try { existing = readFileSync(wrapper, 'utf-8'); } catch { /* 尚不存在 */ }
  if (existing === content) {
    console.log(`✓ 全局 botmux 已指向${targetRoot ? '版本化 current' : '本 checkout'}（${cliScript}）`);
  } else {
    atomicWriteFileSync(wrapper, content, 0o755);
    console.log(`✅ 全局 botmux → ${targetRoot ? `版本化 current（${activeRoot}）` : `本 checkout（${cliScript}）`}`);
    console.log('   下一步 `pnpm daemon:restart` 即从本 checkout 重启 daemon（避免 PATH 中的旧全局 botmux 抢先）。');
  }
} catch (err) {
  console.warn(`⚠️  写 botmux wrapper 失败：${err.message}`);
  process.exit(1);
}
