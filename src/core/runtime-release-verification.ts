/**
 * 版本化运行目录的 PM2 验收回执读取器。
 * deploy tag 只有在独立重启驱动确认全部核心进程在线且路径一致后才能创建。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeReleaseRecord } from './runtime-release.js';

const RECEIPT_MAX_AGE_MS = 2 * 60_000;

interface RuntimeActivationReceipt {
  schemaVersion: 1;
  targetRoot: string;
  commit: string;
  runtimeBuildId: string;
  verifiedAt: string;
}

export interface RuntimeActivationWaitDeps {
  read: () => unknown;
  now: () => number;
  delay: (ms: number) => Promise<void>;
}

export function runtimeActivationReceiptPath(configRoot = join(homedir(), '.botmux')): string {
  return join(configRoot, 'runtime', 'activation-receipt.json');
}

function readProductionReceipt(): unknown {
  try { return JSON.parse(readFileSync(runtimeActivationReceiptPath(), 'utf8')); }
  catch { return null; }
}

function matchesReceipt(raw: unknown, target: RuntimeReleaseRecord, now: number): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  const verifiedAt = typeof value.verifiedAt === 'string' ? Date.parse(value.verifiedAt) : Number.NaN;
  return value.schemaVersion === 1
    && value.targetRoot === target.root
    && value.commit === target.manifest.commit
    && value.runtimeBuildId === target.manifest.runtimeBuildId
    && Number.isFinite(verifiedAt)
    && now >= verifiedAt
    && now - verifiedAt <= RECEIPT_MAX_AGE_MS;
}

const PRODUCTION_DEPS: RuntimeActivationWaitDeps = {
  read: readProductionReceipt,
  now: () => Date.now(),
  delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

/** 等待独立驱动写入本轮新鲜回执；超时即拒绝给 deploy tag 盖章。 */
export async function waitForRuntimeActivation(
  target: RuntimeReleaseRecord,
  deps: RuntimeActivationWaitDeps = PRODUCTION_DEPS,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = deps.now() + timeoutMs;
  while (deps.now() <= deadline) {
    if (matchesReceipt(deps.read(), target, deps.now())) return;
    await deps.delay(100);
  }
  throw new Error('未收到本轮 PM2 路径验收回执，拒绝创建 deploy tag');
}
