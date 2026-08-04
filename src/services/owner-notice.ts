/**
 * Owner/admin 主动通知唯一生产入口。
 *
 * 业务模块只能选择已登记的通知策略并提交标准内容或完整交互卡；本服务统一完成
 * 卡片校验、按策略选择逐次新发或同类 messageId 复用、跨进程串行化和飞书传输，
 * 避免新增旁路退化成文本气泡。
 */
import { createHash } from 'node:crypto';
import { sendUserMessage, updateMessage } from '../im/lark/client.js';
import {
  buildOwnerNoticeCard,
  type OwnerNoticeCardInput,
} from '../im/lark/owner-notice-card.js';
import {
  upsertOwnerNoticeCard,
  type UpsertOwnerNoticeCardResult,
} from './owner-notice-card-store.js';

type OwnerNoticeCardMode = 'standard' | 'raw';
type OwnerNoticeScopeMode = 'global' | 'scoped';
type OwnerNoticeDeliveryMode = 'fresh' | 'upsert';

interface OwnerNoticePolicy {
  kind: string;
  cardMode: OwnerNoticeCardMode;
  scopeMode: OwnerNoticeScopeMode;
  deliveryMode: OwnerNoticeDeliveryMode;
}

/** 新增主动通知必须先在这里登记卡片形态和复用粒度。 */
export const OWNER_NOTICE_POLICIES = {
  'allowed-users-resolve': {
    kind: 'allowed-users-resolve', cardMode: 'standard', scopeMode: 'scoped', deliveryMode: 'upsert',
  },
  'permission-health': {
    kind: 'permission-health', cardMode: 'standard', scopeMode: 'scoped', deliveryMode: 'upsert',
  },
  'group-join-permission': {
    kind: 'group-join-permission', cardMode: 'standard', scopeMode: 'scoped', deliveryMode: 'upsert',
  },
  'production-skill-sync': {
    kind: 'production-skill-sync', cardMode: 'standard', scopeMode: 'global', deliveryMode: 'upsert',
  },
  restart: { kind: 'restart', cardMode: 'raw', scopeMode: 'global', deliveryMode: 'fresh' },
  'host-overload': { kind: 'host-overload', cardMode: 'raw', scopeMode: 'global', deliveryMode: 'upsert' },
  'daemon-offline': {
    kind: 'daemon-offline', cardMode: 'standard', scopeMode: 'global', deliveryMode: 'upsert',
  },
  'cli-runtime-update': {
    kind: 'cli-runtime-update', cardMode: 'raw', scopeMode: 'scoped', deliveryMode: 'upsert',
  },
  'doc-comment-audit': {
    kind: 'doc-comment-audit', cardMode: 'standard', scopeMode: 'scoped', deliveryMode: 'upsert',
  },
} as const satisfies Record<string, OwnerNoticePolicy>;

export type OwnerNoticePolicyId = keyof typeof OWNER_NOTICE_POLICIES;
export type OwnerNoticeCardContent = OwnerNoticeCardInput;

export interface OwnerNoticeTransport {
  sendCard: (openId: string, cardJson: string, uuid?: string) => Promise<string>;
  updateCard: (messageId: string, cardJson: string) => Promise<void>;
}

type OwnerNoticeCard =
  | { mode: 'standard'; content: OwnerNoticeCardInput }
  | { mode: 'raw'; cardJson: string };

export interface DeliverOwnerNoticeInput {
  dataDir: string;
  larkAppId: string;
  recipientOpenId: string;
  policy: OwnerNoticePolicyId;
  /** scoped 策略必须提供稳定业务身份；这里只持久化不可逆短哈希。 */
  scope?: string;
  card: OwnerNoticeCard;
  /** 启动链告警可设置发送截止时间，避免飞书网络故障拖住后台恢复。 */
  sendTimeoutMs?: number;
  log?: (message: string) => void;
  /** 仅测试注入；生产一律使用本模块封装的飞书传输。 */
  transport?: OwnerNoticeTransport;
}

export interface DeliverOwnerNoticeResult extends UpsertOwnerNoticeCardResult {
  policy: OwnerNoticePolicyId;
  kind: string;
}

function scopedKind(policyId: OwnerNoticePolicyId, scope: string | undefined): string {
  const policy = OWNER_NOTICE_POLICIES[policyId];
  if (policy.scopeMode === 'global') {
    if (scope?.trim()) throw new Error(`全局通知 ${policyId} 不接受 scope`);
    return policy.kind;
  }
  const normalized = scope?.trim();
  if (!normalized) throw new Error(`通知 ${policyId} 必须提供 scope`);
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `${policy.kind}-${digest}`;
}

/** 原始交互卡至少必须是可解析对象，并具有 legacy elements 或 JSON 2.0 body。 */
function validateRawCard(cardJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cardJson);
  } catch {
    throw new Error('主动通知原始卡片不是有效 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('主动通知原始卡片必须是 JSON 对象');
  }
  const card = parsed as Record<string, unknown>;
  if (!Array.isArray(card.elements) && !(card.schema === '2.0' && card.body && typeof card.body === 'object')) {
    throw new Error('主动通知原始卡片缺少 elements 或 JSON 2.0 body');
  }
  /** callback 按钮必须提供稳定 action，才能进入默认一次性和显式白名单策略。 */
  const validateButtons = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(validateButtons);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (item.tag === 'button') {
      const callbacks: unknown[] = [];
      if (item.value && typeof item.value === 'object') callbacks.push(item.value);
      if (Array.isArray(item.behaviors)) {
        callbacks.push(...item.behaviors
          .filter(behavior => behavior && typeof behavior === 'object'
            && (behavior as Record<string, unknown>).type === 'callback')
          .map(behavior => (behavior as Record<string, unknown>).value));
      }
      for (const callback of callbacks) {
        const action = callback && typeof callback === 'object'
          ? (callback as Record<string, unknown>).action
          : undefined;
        if (typeof action !== 'string' || !action.trim()) {
          throw new Error('主动通知 callback 按钮必须提供非空 action');
        }
      }
    }
    Object.values(item).forEach(validateButtons);
  };
  validateButtons(card);
  return JSON.stringify(card);
}

function resolveCard(policyId: OwnerNoticePolicyId, card: OwnerNoticeCard): string {
  const expected = OWNER_NOTICE_POLICIES[policyId].cardMode;
  if (card.mode !== expected) {
    throw new Error(`通知 ${policyId} 必须使用 ${expected} 卡片模式`);
  }
  return card.mode === 'standard'
    ? buildOwnerNoticeCard(card.content)
    : validateRawCard(card.cardJson);
}

/** 构造受管传输通道；发版卡等专用账本可复用传输，但不能绕过飞书类型约束。 */
export function createOwnerNoticeTransport(
  larkAppId: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): OwnerNoticeTransport {
  return {
    sendCard: (openId, cardJson, uuid) => sendUserMessage(
      larkAppId,
      openId,
      validateRawCard(cardJson),
      'interactive',
      uuid,
      options.timeoutMs || options.signal
        ? { timeoutMs: options.timeoutMs, signal: options.signal }
        : undefined,
    ),
    updateCard: (messageId, cardJson) => updateMessage(larkAppId, messageId, validateRawCard(cardJson)),
  };
}

/** 按策略逐次新发，或更新同类原卡并在失败时创建替代卡。 */
export async function deliverOwnerNotice(
  input: DeliverOwnerNoticeInput,
): Promise<DeliverOwnerNoticeResult> {
  const policy = OWNER_NOTICE_POLICIES[input.policy];
  const kind = scopedKind(input.policy, input.scope);
  const cardJson = resolveCard(input.policy, input.card);
  const transport = input.transport ?? createOwnerNoticeTransport(
    input.larkAppId,
    { timeoutMs: input.sendTimeoutMs },
  );
  if (policy.deliveryMode === 'fresh') {
    // 重启 intent 已保证每次真实重启最多消费一次；这里不传稳定 uuid，避免飞书把两次
    // 内容相同的真实重启误判成重复投递，同时确保新卡出现在聊天最新位置。
    const messageId = await transport.sendCard(input.recipientOpenId, cardJson);
    const result: DeliverOwnerNoticeResult = {
      action: 'sent',
      messageId,
      policy: input.policy,
      kind,
    };
    input.log?.(`policy=${input.policy} kind=${kind} action=${result.action} message=${result.messageId}`);
    return result;
  }
  const result = await upsertOwnerNoticeCard({
    dataDir: input.dataDir,
    kind,
    cardJson,
    sendCard: (content, uuid) => transport.sendCard(input.recipientOpenId, content, uuid),
    updateCard: transport.updateCard,
    log: input.log,
  });
  input.log?.(`policy=${input.policy} kind=${kind} action=${result.action} message=${result.messageId}`);
  return { ...result, policy: input.policy, kind };
}
