import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  githubRepoFromRemote,
  parseSourceUpdateConfig,
  productionWorktreeFromPorcelain,
  sourceDeploymentForRestart,
  sourceUpdatePlanFromProbe,
} from '../src/utils/source-update.js';

const config = {
  schemaVersion: 1 as const,
  productionBranch: 'custom/prod',
  originRemote: 'origin',
  originRepo: 'mmxyhSnow/botmux',
  upstreamRemote: 'upstream',
  upstreamRepo: 'deepcoldy/botmux',
};

describe('source checkout update plan', () => {
  it('同时接受 GitHub SSH 与 HTTPS 地址', () => {
    expect(githubRepoFromRemote('git@github.com:mmxyhSnow/botmux.git')).toBe('mmxyhSnow/botmux');
    expect(githubRepoFromRemote('https://github.com/deepcoldy/botmux.git')).toBe('deepcoldy/botmux');
  });

  it('只为准确的生产分支与双远端身份启用', () => {
    expect(sourceUpdatePlanFromProbe('/repo', config, {
      branch: 'custom/prod',
      originUrl: 'git@github.com:mmxyhSnow/botmux.git',
      upstreamUrl: 'https://github.com/deepcoldy/botmux.git',
    })).toMatchObject({ root: '/repo', config });
    expect(sourceUpdatePlanFromProbe('/repo', config, {
      branch: 'dev',
      originUrl: 'git@github.com:mmxyhSnow/botmux.git',
      upstreamUrl: 'https://github.com/deepcoldy/botmux.git',
    })).toBeNull();
  });

  it('版本化 detached 运行目录仍能精确解析唯一 custom/prod worktree', () => {
    const output = [
      'worktree /runtime/releases/v3.7.1-custom.11',
      `HEAD ${'1'.repeat(40)}`,
      'detached',
      '',
      'worktree /repo/custom-prod',
      `HEAD ${'1'.repeat(40)}`,
      'branch refs/heads/custom/prod',
    ].join('\n');
    expect(productionWorktreeFromPorcelain(output, 'custom/prod')).toBe('/repo/custom-prod');
    expect(productionWorktreeFromPorcelain(`${output}\n\n${output}`, 'custom/prod')).toBeNull();
  });

  it('拒绝远端冒充和配置中的命令注入', () => {
    expect(sourceUpdatePlanFromProbe('/repo', config, {
      branch: 'custom/prod',
      originUrl: 'git@github.com:someone/botmux.git',
      upstreamUrl: 'https://github.com/deepcoldy/botmux.git',
    })).toBeNull();
    expect(parseSourceUpdateConfig({ ...config, productionBranch: 'custom/prod; touch /tmp/x' })).toBeNull();
    expect(parseSourceUpdateConfig({ ...config, command: 'rm -rf /' })).toBeNull();
  });

  it('只把服务端刚完成且版本匹配的源码候选交给重启验收', () => {
    const result = {
      oldVersion: '3.7.1',
      newVersion: '3.8.0',
      changed: true,
      branch: 'custom/prod',
      upgradeBranch: 'upgrade/v3.8.0',
      releaseTag: 'release/v3.8.0-custom.1',
      deployTag: null,
      productionHead: 'a'.repeat(40),
    };
    expect(sourceDeploymentForRestart(result, '3.7.1', '3.8.0')).toEqual({
      releaseTag: result.releaseTag,
      expectedHead: result.productionHead,
    });
    expect(sourceDeploymentForRestart(result, '3.7.1', '9.9.9')).toBeUndefined();
  });

  it('官方同步安装阶段不再创建或 push deploy 标签', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'sync-official-source.mjs'), 'utf8');
    expect(script).not.toContain("['tag', '-a', deployTag");
    expect(script).not.toContain('refs/tags/${deployTag}');
    expect(script).toContain('deployTag: null');
  });

  it('官方合并冲突会报告保留的 upgrade worktree 且明确生产未推进', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'sync-official-source.mjs'), 'utf8');
    expect(script).toContain('官方同步发生合并冲突');
    expect(script).toContain('已停在 ${upgradePath}');
    expect(script).toContain('生产分支尚未推进');
  });
});
