/** release:status 默认只读本地 refs；显式 --remote 才允许刷新网络状态。 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const PREFIX = 'BOTMUX_CUSTOM_RELEASE_RESULT=';

describe('custom release status', () => {
  it('默认本地模式不执行 fetch，并返回结构化来源', () => {
    const result = spawnSync(process.execPath, ['scripts/custom-release.mjs', 'status'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    const line = result.stdout.split(/\r?\n/).find(item => item.startsWith(PREFIX));
    expect(line).toBeTruthy();
    expect(JSON.parse(line!.slice(PREFIX.length))).toMatchObject({
      ok: true,
      action: 'status',
      source: 'local',
    });
  });
});
