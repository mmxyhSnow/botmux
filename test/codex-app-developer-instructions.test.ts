/**
 * Codex App 开发者指令回归：推荐动作必须覆盖回答自然导出的下一步，并使用完整 v2 契约。
 * Run: pnpm vitest run test/codex-app-developer-instructions.test.ts
 */
import { describe, expect, it } from 'vitest';
import { codexAppDeveloperInstructions } from '../src/services/codex-app-developer-instructions.js';

describe('codexAppDeveloperInstructions final reply actions', () => {
  it('injects the Chinese answer-derived recommendation policy', () => {
    const instructions = codexAppDeveloperInstructions({ sessionId: 'sid-zh', locale: 'zh' });

    expect(instructions).toContain('从回答本身和整体任务生命周期');
    expect(instructions).toContain('默认只提供一个最可能的动作');
    expect(instructions).toContain('"relationship":"alternatives"');
    expect(instructions).toContain('"version":2');
    expect(instructions).toContain('`target`、`scope`、`acceptance`');
  });

  it('injects the equivalent English recommendation policy', () => {
    const instructions = codexAppDeveloperInstructions({ sessionId: 'sid-en' });

    expect(instructions).toContain('answer itself and the overall task lifecycle');
    expect(instructions).toContain('Default to the single most likely action');
    expect(instructions).toContain('"relationship":"alternatives"');
    expect(instructions).toContain('"version":2');
    expect(instructions).toContain('target, scope, and acceptance criteria');
  });
});
