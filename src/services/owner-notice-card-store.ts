/** Owner 通知卡片槽位：每种通知持久化一个 messageId，后续同类事件优先更新原卡。 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';

const SAFE_KIND = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface OwnerNoticeCardSlot {
  schemaVersion: 1;
  kind: string;
  messageId: string;
  updatedAt: string;
}

export interface UpsertOwnerNoticeCardInput {
  dataDir: string;
  kind: string;
  cardJson: string;
  sendCard: (cardJson: string, uuid: string) => Promise<string>;
  updateCard: (messageId: string, cardJson: string) => Promise<void>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface UpsertOwnerNoticeCardResult {
  action: 'sent' | 'updated';
  messageId: string;
}

function slotPath(dataDir: string, kind: string): string {
  if (!SAFE_KIND.test(kind)) throw new Error(`通知卡片类型无效: ${kind}`);
  return join(dataDir, 'owner-notice-cards', `${kind}.json`);
}

function readSlot(dataDir: string, kind: string): OwnerNoticeCardSlot | undefined {
  const path = slotPath(dataDir, kind);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<OwnerNoticeCardSlot>;
    if (
      value.schemaVersion === 1
      && value.kind === kind
      && typeof value.messageId === 'string'
      && value.messageId.length > 0
    ) return value as OwnerNoticeCardSlot;
  } catch { /* 损坏槽位按首次发送恢复，旧卡不会被误更新。 */ }
  return undefined;
}

function writeSlot(dataDir: string, slot: OwnerNoticeCardSlot): void {
  const dir = join(dataDir, 'owner-notice-cards');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* Windows 或只读权限下保持原目录权限。 */ }
  atomicWriteFileSync(
    slotPath(dataDir, slot.kind),
    `${JSON.stringify(slot, null, 2)}\n`,
    { mode: 0o600, durable: true, followTargetSymlink: false },
  );
}

function ensureSlotDir(dataDir: string): void {
  const dir = join(dataDir, 'owner-notice-cards');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* Windows 或只读权限下保持原目录权限。 */ }
}

/** 同类卡片先 patch；旧卡被撤回或不可更新时才新发一张并替换槽位。 */
export async function upsertOwnerNoticeCard(
  input: UpsertOwnerNoticeCardInput,
): Promise<UpsertOwnerNoticeCardResult> {
  ensureSlotDir(input.dataDir);
  const path = slotPath(input.dataDir, input.kind);
  return withFileLock(path, async () => {
    const current = readSlot(input.dataDir, input.kind);
    if (current) {
      try {
        await input.updateCard(current.messageId, input.cardJson);
        writeSlot(input.dataDir, {
          ...current,
          updatedAt: (input.now?.() ?? new Date()).toISOString(),
        });
        return { action: 'updated', messageId: current.messageId };
      } catch (error) {
        input.log?.(`update ${input.kind} failed, replacing card: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const digest = createHash('sha256').update(`${input.kind}\0${input.cardJson}`).digest('hex').slice(0, 24);
    const messageId = await input.sendCard(input.cardJson, `owner-notice-${input.kind}-${digest}`);
    writeSlot(input.dataDir, {
      schemaVersion: 1,
      kind: input.kind,
      messageId,
      updatedAt: (input.now?.() ?? new Date()).toISOString(),
    });
    return { action: 'sent', messageId };
  });
}
