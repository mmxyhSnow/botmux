/**
 * 飞书卡片一次性按钮公共策略。
 *
 * ASK 等返回完整终态卡片的 handler 继续拥有自己的渲染；仅返回 toast/空 ACK 的
 * callback 由 event-dispatcher 通过本模块把原卡片中同 action 的按钮统一置灰。
 * 未登记动作默认一次性，确实需要重复点击的 toast-only 动作必须加入白名单。
 */

type JsonObject = Record<string, unknown>;

/** 这些动作成功后不结束当前交互，必须保留再次点击能力。 */
const REPEATABLE_TOAST_ACTIONS = new Set([
  'ask_toggle',
  'codex_notifier_open_app',
  'codex_progress_toggle_details',
  'codex_progress_history_open',
  'codex_progress_history_page',
  'config_text_open',
  'config_text_save',
  'get_write_link',
  'open_local_cli',
  'open_local_terminal',
  'refresh_screenshot',
  'relay_page',
  'relay_search',
  'relay_select',
  'term_action',
  'toggle_display',
  'toggle_stream',
  'tui_keys',
  'worktree_toggle_mode',
]);

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function actionName(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  return typeof value.action === 'string' && value.action.trim()
    ? value.action.trim()
    : undefined;
}

/** 未登记动作采用保守默认：一次性；白名单动作才允许 toast-only 重复交互。 */
export function oneShotActionGroup(value: unknown): string | undefined {
  const action = actionName(value);
  if (!action || REPEATABLE_TOAST_ACTIONS.has(action)) return undefined;
  return action;
}

/** 从 im.message.get 响应中读取原始卡片，兼容 user_dsl 外壳。 */
export function cardFromMessageDetail(detail: unknown): JsonObject | undefined {
  const item = isObject(detail) && Array.isArray(detail.items) ? detail.items[0] : undefined;
  const body = isObject(item) && isObject(item.body) ? item.body : undefined;
  const raw = body?.content;
  if (typeof raw !== 'string') return undefined;
  try {
    const outer = JSON.parse(raw) as unknown;
    if (!isObject(outer)) return undefined;
    if (typeof outer.user_dsl !== 'string') return outer;
    const inner = JSON.parse(outer.user_dsl) as unknown;
    return isObject(inner) ? inner : undefined;
  } catch {
    return undefined;
  }
}

function callbackValues(button: JsonObject): unknown[] {
  const values: unknown[] = [];
  if (isObject(button.value)) values.push(button.value);
  if (Array.isArray(button.behaviors)) {
    for (const behavior of button.behaviors) {
      if (isObject(behavior) && behavior.type === 'callback' && isObject(behavior.value)) {
        values.push(behavior.value);
      }
    }
  }
  return values;
}

/**
 * 克隆卡片并禁用同一 action 组的全部按钮。
 * 同组而非只禁用当前按钮，保证“预览 / 执行”“同意 / 拒绝”这类互斥选择同步终态化。
 */
export function freezeOneShotActionGroup(
  cardData: unknown,
  clickedValue: unknown,
): { card: JsonObject; changed: boolean } | undefined {
  const group = oneShotActionGroup(clickedValue);
  if (!group || !isObject(cardData)) return undefined;
  const card = JSON.parse(JSON.stringify(cardData)) as JsonObject;
  let changed = false;

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isObject(value)) return;
    if (
      value.tag === 'button'
      && callbackValues(value).some(candidate => oneShotActionGroup(candidate) === group)
    ) {
      value.disabled = true;
      value.type = 'default';
      changed = true;
    }
    Object.values(value).forEach(visit);
  };

  visit(card);
  return { card, changed };
}

/** 单次 callback 的成功结果与当前卡片快照之间的协调输入。 */
export interface OneShotFinalizeInput {
  larkAppId: string;
  messageId?: string;
  actionTag?: string;
  actionValue: unknown;
  shapedResult: any;
  loadCard: () => Promise<unknown>;
  onLoadError?: (error: unknown) => void;
}

/**
 * 一次性按钮消费闸门。
 *
 * 每个 event-dispatcher 进程持有一个实例；成功后终态会写回飞书卡片，实例内集合
 * 只负责覆盖“成功响应到客户端完成卡片替换”之间以及客户端异常重复回调的窗口。
 */
export class OneShotCardActionGuard {
  private readonly completed = new Set<string>();

  private key(
    larkAppId: string,
    messageId: string | undefined,
    actionTag: string | undefined,
    actionValue: unknown,
  ): string | undefined {
    if (actionTag && actionTag !== 'button') return undefined;
    const group = oneShotActionGroup(actionValue);
    return messageId && group ? `${larkAppId}\0${messageId}\0${group}` : undefined;
  }

  /** 判断这张消息中的同组一次性按钮是否已经成功消费。 */
  isCompleted(
    larkAppId: string,
    messageId: string | undefined,
    actionTag: string | undefined,
    actionValue: unknown,
  ): boolean {
    const key = this.key(larkAppId, messageId, actionTag, actionValue);
    return !!key && this.completed.has(key);
  }

  /** 成功 toast/空 ACK 自动转换为 card-only 终态；失败和自带 card 的结果保持原样。 */
  async finalize(input: OneShotFinalizeInput): Promise<any> {
    const key = this.key(
      input.larkAppId,
      input.messageId,
      input.actionTag,
      input.actionValue,
    );
    if (!key || input.shapedResult?.card) return input.shapedResult;
    const toastType = input.shapedResult?.toast?.type;
    if (toastType === 'warning' || toastType === 'error') return input.shapedResult;

    this.completed.add(key);
    if (this.completed.size > 5000) {
      const oldest = this.completed.values().next().value;
      if (typeof oldest === 'string') this.completed.delete(oldest);
    }
    try {
      const detail = await input.loadCard();
      const original = cardFromMessageDetail(detail);
      const frozen = freezeOneShotActionGroup(original, input.actionValue);
      if (frozen?.changed) return { card: { type: 'raw', data: frozen.card } };
    } catch (error) {
      input.onLoadError?.(error);
    }
    return input.shapedResult;
  }
}
