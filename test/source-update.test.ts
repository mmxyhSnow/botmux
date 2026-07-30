import { describe, expect, it } from 'vitest';
import {
  githubRepoFromRemote,
  parseSourceUpdateConfig,
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

  it('拒绝远端冒充和配置中的命令注入', () => {
    expect(sourceUpdatePlanFromProbe('/repo', config, {
      branch: 'custom/prod',
      originUrl: 'git@github.com:someone/botmux.git',
      upstreamUrl: 'https://github.com/deepcoldy/botmux.git',
    })).toBeNull();
    expect(parseSourceUpdateConfig({ ...config, productionBranch: 'custom/prod; touch /tmp/x' })).toBeNull();
    expect(parseSourceUpdateConfig({ ...config, command: 'rm -rf /' })).toBeNull();
  });
});
