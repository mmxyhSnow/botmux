/** 冻结门禁宿主兼容守卫：阻止测试夹具重新引入新版 Git 专属初始化参数。 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 递归收集测试目录里的 TypeScript 文件，供兼容语法静态检查复用。 */
function collectTypeScriptFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    if (statSync(path).isDirectory()) return collectTypeScriptFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

describe('冻结门禁宿主兼容守卫', () => {
  it('测试夹具不直接使用 Git 2.20 之后才提供的命令或参数', () => {
    const root = join(process.cwd(), 'test');
    const unsupportedForms = [
      /git\s+init(?:\s+-q)?\s+-b\b/,
      /['"]init['"]\s*,\s*['"]-b['"]/,
      /git\s+switch\b/,
      /\bgit\([^;\n]*['"]switch['"]/,
      /['"]branch['"]\s*,\s*['"]--show-current['"]/,
    ];
    const offenders = collectTypeScriptFiles(root)
      .filter((path) => unsupportedForms.some((pattern) => pattern.test(readFileSync(path, 'utf8'))))
      .map((path) => relative(process.cwd(), path));

    expect(offenders).toEqual([]);
  });

  it('候选冻结先构建运行产物再执行全量测试', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/custom-release.mjs'), 'utf8');
    const buildAt = script.indexOf("run('pnpm', ['build']");
    const testAt = script.indexOf("run('pnpm', ['test']");

    expect(buildAt).toBeGreaterThan(-1);
    expect(testAt).toBeGreaterThan(-1);
    expect(buildAt).toBeLessThan(testAt);
  });
});
