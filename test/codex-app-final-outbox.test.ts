import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ackCodexAppFinalOutbox,
  appendCodexAppFinalOutbox,
  emitCodexAppFinalWithOutbox,
  readCodexAppFinalOutbox,
} from '../src/services/codex-app-final-outbox.js';

describe('Codex App final outbox', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-codex-final-outbox-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('在 ACK 前跨实例重放 final，ACK 后不再返回', () => {
    appendCodexAppFinalOutbox(dataDir, 'session-a', {
      appTurnId: 'app-turn-1',
      replyTurnId: 'om_turn',
      content: '已安装并验证成功',
      outcome: 'completed',
      startedAtMs: 100,
      completedAtMs: 200,
    });

    expect(readCodexAppFinalOutbox(dataDir, 'session-a')).toEqual([
      expect.objectContaining({
        appTurnId: 'app-turn-1',
        replyTurnId: 'om_turn',
        content: '已安装并验证成功',
      }),
    ]);

    ackCodexAppFinalOutbox(dataDir, 'session-a', 'app-turn-1');

    expect(readCodexAppFinalOutbox(dataDir, 'session-a')).toEqual([]);
  });

  it('重复 append 只恢复一条，并忽略崩溃半行和损坏行', () => {
    const marker = {
      appTurnId: 'app-turn-1',
      replyTurnId: 'om_turn',
      content: '可靠结论',
      outcome: 'completed' as const,
      completedAtMs: 200,
    };
    appendCodexAppFinalOutbox(dataDir, 'session-a', marker);
    appendCodexAppFinalOutbox(dataDir, 'session-a', marker);
    const directory = join(dataDir, 'codex-app-final-outbox');
    const jsonl = readdirSync(directory).find(name => name.endsWith('.jsonl'));
    expect(jsonl).toBeDefined();
    appendFileSync(join(directory, jsonl!), '{"broken":true}\n{"half"', 'utf8');

    expect(readCodexAppFinalOutbox(dataDir, 'session-a')).toEqual([
      expect.objectContaining({ appTurnId: 'app-turn-1', content: '可靠结论' }),
    ]);
  });

  it('对 session id 做路径隔离，不能逃逸到 dataDir 外', () => {
    appendCodexAppFinalOutbox(dataDir, '../../outside', {
      appTurnId: 'app-turn-safe',
      content: '安全落盘',
      outcome: 'completed',
    });

    expect(readCodexAppFinalOutbox(dataDir, '../../outside')).toHaveLength(1);
    expect(readdirSync(dataDir)).toEqual(['codex-app-final-outbox']);
  });

  it('严格先持久化再发 OSC final marker', () => {
    const observed: string[] = [];
    emitCodexAppFinalWithOutbox(
      dataDir,
      'session-a',
      {
        appTurnId: 'app-turn-ordered',
        replyTurnId: 'om_ordered',
        content: '顺序受保护',
        outcome: 'completed',
      },
      marker => {
        observed.push(marker.appTurnId);
        expect(readCodexAppFinalOutbox(dataDir, 'session-a'))
          .toEqual([expect.objectContaining({ appTurnId: 'app-turn-ordered' })]);
      },
    );

    expect(observed).toEqual(['app-turn-ordered']);
  });
});
