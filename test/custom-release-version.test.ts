import { describe, expect, it } from 'vitest';
import {
  customTag,
  latestOfficialTag,
  nextCustomVersion,
  parseCustomTag,
  parseOfficialTag,
} from '../scripts/lib/custom-release-version.mjs';

/**
 * 自定义发布版本规则测试：确保官方标签、自定义序号和两类快照标签互不混淆。
 */
describe('custom release version', () => {
  it('只把正式 vX.Y.Z 识别为官方基线', () => {
    expect(parseOfficialTag('v3.7.1')).toMatchObject({ major: 3, minor: 7, patch: 1 });
    expect(parseOfficialTag('v3.8.0-canary.1')).toBeNull();
    expect(parseOfficialTag('deploy/v3.7.1-custom.2')).toBeNull();
    expect(latestOfficialTag(['v3.6.0', 'v3.9.0-canary.1', 'v3.7.1'])).toBe('v3.7.1');
  });

  it('同时读取候选和部署标签占用的 custom 序号', () => {
    expect(nextCustomVersion('v3.7.1', [
      'deploy/v3.7.1-custom.1',
      'release/v3.7.1-custom.3',
      'deploy/v3.6.0-custom.9',
    ])).toBe('3.7.1-custom.4');
  });

  it('生成同版本候选标签和部署标签', () => {
    expect(customTag('release', '3.7.1-custom.3')).toBe('release/v3.7.1-custom.3');
    expect(customTag('deploy', '3.7.1-custom.3')).toBe('deploy/v3.7.1-custom.3');
    expect(parseCustomTag('release/v3.7.1-custom.3')).toEqual({
      tag: 'release/v3.7.1-custom.3',
      kind: 'release',
      officialTag: 'v3.7.1',
      version: '3.7.1-custom.3',
      custom: 3,
    });
  });

  it('拒绝含糊或越权的版本形式', () => {
    expect(() => customTag('release', 'v3.7.1-custom.3')).toThrow(/无效自定义版本/);
    expect(() => customTag('candidate', '3.7.1-custom.3')).toThrow(/无效标签类型/);
    expect(() => nextCustomVersion('v3.7.1-canary.1', [])).toThrow(/无效官方版本标签/);
  });
});
