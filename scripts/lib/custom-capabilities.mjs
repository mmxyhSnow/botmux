/**
 * 自定义能力清单解析与审计。
 * 清单把官方接入点、行为契约、测试和运行态探针绑定为升级前可执行门禁。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CUSTOM_CAPABILITIES_FILE = 'custom-capabilities.json';
const ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;

function nonEmptyStrings(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every(item => typeof item === 'string' && item.trim().length > 0);
}

function repoFile(root, path, violations, label) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('..')) {
    violations.push(`${label} 路径无效：${String(path)}`);
    return undefined;
  }
  const file = resolve(root, path);
  if (!file.startsWith(`${resolve(root)}/`) || !existsSync(file)) {
    violations.push(`${label} 文件不存在：${path}`);
    return undefined;
  }
  return file;
}

/** 读取清单；JSON 语法错误保持原始异常，便于升级日志直接定位。 */
export function readCustomCapabilities(root) {
  return JSON.parse(readFileSync(join(root, CUSTOM_CAPABILITIES_FILE), 'utf8'));
}

/** 返回可供 CI 和测试复用的审计结果，不在库层直接退出进程。 */
export function auditCustomCapabilities(root) {
  const manifest = readCustomCapabilities(root);
  return auditCustomCapabilityManifest(root, manifest);
}

/** 审计传入清单，测试可借此验证坏契约会被门禁稳定拒绝。 */
export function auditCustomCapabilityManifest(root, manifest) {
  const violations = [];
  if (manifest?.schemaVersion !== 1) violations.push('schemaVersion 必须为 1');
  if (manifest?.baseline?.integrationBranch !== 'custom/dev') {
    violations.push('baseline.integrationBranch 必须为 custom/dev');
  }
  if (manifest?.baseline?.productionBranch !== 'custom/prod') {
    violations.push('baseline.productionBranch 必须为 custom/prod');
  }
  if (!Array.isArray(manifest?.capabilities) || manifest.capabilities.length === 0) {
    violations.push('capabilities 不能为空');
    return { manifest, violations, tests: [] };
  }

  const ids = new Set();
  const tests = new Set();
  for (const capability of manifest.capabilities) {
    const prefix = `capability(${String(capability?.id)})`;
    if (!ID_PATTERN.test(capability?.id ?? '')) violations.push(`${prefix} id 无效`);
    if (ids.has(capability?.id)) violations.push(`${prefix} id 重复`);
    ids.add(capability?.id);
    if (capability?.criticality !== 'release-blocking') {
      violations.push(`${prefix} P0 清单只允许 release-blocking`);
    }
    if (typeof capability?.description !== 'string' || !capability.description.trim()) {
      violations.push(`${prefix} description 不能为空`);
    }
    if (!nonEmptyStrings(capability?.contracts)) violations.push(`${prefix} contracts 不能为空`);
    if (!nonEmptyStrings(capability?.runtimeProbes)) violations.push(`${prefix} runtimeProbes 不能为空`);
    if (!Array.isArray(capability?.entrypoints) || capability.entrypoints.length === 0) {
      violations.push(`${prefix} entrypoints 不能为空`);
    } else {
      for (const entrypoint of capability.entrypoints) {
        const file = repoFile(root, entrypoint?.path, violations, `${prefix} entrypoint`);
        if (!nonEmptyStrings(entrypoint?.symbols)) {
          violations.push(`${prefix} entrypoint(${String(entrypoint?.path)}) symbols 不能为空`);
          continue;
        }
        if (!file) continue;
        const source = readFileSync(file, 'utf8');
        for (const symbol of entrypoint.symbols) {
          if (!source.includes(symbol)) violations.push(`${prefix} 缺少接入符号 ${entrypoint.path}#${symbol}`);
        }
      }
    }
    if (!nonEmptyStrings(capability?.tests)) {
      violations.push(`${prefix} tests 不能为空`);
    } else {
      for (const test of capability.tests) {
        repoFile(root, test, violations, `${prefix} test`);
        if (!/^test\/.*\.(?:test|spec)\.ts$/.test(test)) violations.push(`${prefix} 测试路径无效：${test}`);
        tests.add(test);
      }
    }
  }
  return { manifest, violations, tests: [...tests].sort() };
}
