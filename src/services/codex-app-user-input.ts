/**
 * Codex App 原生选择请求桥接。
 *
 * 来源：app-server 的 `item/tool/requestUserInput` 协议。该模块把有限选项转换为
 * Botmux ask 请求，并把飞书卡片答案按原问题 ID 回填到同一个 Codex turn。
 */
import { readManagedOriginCapability } from '../core/managed-origin-capability.js';
import {
  fetchDaemonIpc,
  loadDaemonIpcSecret,
} from '../core/daemon-ipc-auth.js';
import { parseDaemonIpcPort } from '../utils/daemon-discovery.js';
import { parseCodexAppUserInputQuestions } from './traex-user-input.js';

export interface CodexAppUserInputContext {
  sessionId: string;
  env: NodeJS.ProcessEnv;
}

export interface CodexAppUserInputResponse {
  answers: Record<string, { answers: string[] }>;
}

export interface CodexAppUserInputCallbacks {
  respond: (result: CodexAppUserInputResponse) => void;
  interrupt: (threadId: string, turnId: string) => Promise<unknown>;
  log: (message: string) => void;
}

/** Codex turn 结束后通知 daemon 将累积卡片切换为完成态。 */
export async function completeCodexAppUserInputFlow(
  flowId: string,
  context: CodexAppUserInputContext,
): Promise<void> {
  const port = parseDaemonIpcPort(context.env.BOTMUX_DAEMON_IPC_PORT);
  if (!port || !flowId) return;
  let hostSecret: string;
  try {
    hostSecret = loadDaemonIpcSecret();
  } catch {
    return;
  }
  const response = await fetchDaemonIpc(port, '/api/ask-flows/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: context.sessionId, flowId }),
  }, hostSecret);
  if (!response.ok) {
    throw new Error(`ask flow completion HTTP ${response.status}`);
  }
}

/** 最终回复路径使用的非阻塞完成通知，失败只记日志，不影响正文交付。 */
export function dispatchCodexAppUserInputFlowCompletion(
  flowId: string,
  context: CodexAppUserInputContext,
  log: (message: string) => void,
): void {
  void completeCodexAppUserInputFlow(flowId, context).catch(error => {
    log(`[codex-app] ask flow completion failed: ${
      error instanceof Error ? error.message : String(error)
    }`);
  });
}

/** 留出 30 秒让 broker 先结算，避免外层 5 分钟工具上限先中止并遗留吞消息的 ask。 */
const CODEX_NATIVE_ASK_MAX_MS = 270_000;

/** 读取可选自动决策窗口；普通阻塞选择不得超过 Codex 外层工具窗口。 */
function askTimeoutMs(params: unknown): number {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return CODEX_NATIVE_ASK_MAX_MS;
  const value = (params as Record<string, unknown>).autoResolutionMs;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1_000
    ? Math.min(value, CODEX_NATIVE_ASK_MAX_MS)
    : CODEX_NATIVE_ASK_MAX_MS;
}

/** 将原生选择请求发送给当前 Botmux daemon，并等待飞书卡片答案。 */
export async function bridgeCodexAppUserInput(
  params: unknown,
  context: CodexAppUserInputContext,
): Promise<CodexAppUserInputResponse> {
  const parsed = parseCodexAppUserInputQuestions(params);
  if (parsed.kind === 'unsupported') {
    throw new Error(`requestUserInput cannot be represented as an ask card: ${parsed.reason}`);
  }

  const port = parseDaemonIpcPort(context.env.BOTMUX_DAEMON_IPC_PORT);
  const chatId = context.env.BOTMUX_CHAT_ID?.trim();
  const larkAppId = context.env.BOTMUX_LARK_APP_ID?.trim();
  if (!port || !chatId || !larkAppId) {
    throw new Error('requestUserInput is missing Botmux daemon or Lark routing context');
  }

  const dataDir = context.env.SESSION_DATA_DIR?.trim();
  const claim = dataDir
    ? readManagedOriginCapability(
        dataDir,
        context.sessionId,
        context.env.BOTMUX_SEND_RELAY,
      )
    : null;
  const root = context.env.BOTMUX_ROOT_MESSAGE_ID?.trim();
  const requestParams = params as Record<string, unknown>;
  const body = {
    sessionId: context.sessionId,
    chatId,
    larkAppId,
    rootMessageId: root?.startsWith('om_') ? root : null,
    questions: parsed.questions.map(entry => entry.question),
    timeoutMs: askTimeoutMs(params),
    ...(typeof requestParams.turnId === 'string' && requestParams.turnId.trim()
      ? { flowId: requestParams.turnId.trim() }
      : {}),
    lockToTurnCaller: true,
    ...(claim
      ? {
          originCapability: claim.capability,
          ...(claim.turnId ? { originTurnId: claim.turnId } : {}),
          ...(claim.dispatchAttempt !== undefined
            ? { originDispatchAttempt: claim.dispatchAttempt }
            : {}),
        }
      : {}),
  };

  const request = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  } satisfies RequestInit;
  // 宿主 runner 优先使用 HMAC；文件隔离会话读不到密钥时再用轮次 capability。
  let hostSecret: string | undefined;
  try {
    hostSecret = loadDaemonIpcSecret();
  } catch {
    hostSecret = undefined;
  }
  const response = hostSecret
    ? await fetchDaemonIpc(port, '/api/asks', request, hostSecret)
    : await fetch(`http://127.0.0.1:${port}/api/asks`, request);
  if (!response.ok) {
    throw new Error(`ask broker HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const result = await response.json() as {
    kind?: string;
    answers?: ReadonlyArray<ReadonlyArray<string>>;
    comment?: string | null;
    action?: string;
  };
  if (result.kind !== 'answered') {
    throw new Error(`ask not answered (${result.kind ?? 'unknown'})`);
  }

  const customText = result.comment?.trim() ?? '';
  const controlText = result.action === 'undo'
    ? '[系统] 用户撤销了上一问，请重新提出上一题并按新答案重算后续分支。'
    : '';
  const answers: CodexAppUserInputResponse['answers'] = {};
  parsed.questions.forEach((entry, index) => {
    const selected = result.answers?.[index] ?? [];
    const values = selected.length > 0
      ? [...selected]
      : controlText
        ? [controlText]
        : customText
          ? [customText]
          : [];
    if (values.length > 0) answers[entry.id] = { answers: values };
  });
  return { answers };
}

/** 编排单次 server request；失败时打断原 turn，绝不回空答案继续执行。 */
export function dispatchCodexAppUserInput(
  params: unknown,
  context: CodexAppUserInputContext,
  callbacks: CodexAppUserInputCallbacks,
): void {
  void bridgeCodexAppUserInput(params, context).then(
    callbacks.respond,
    error => {
      const reason = error instanceof Error ? error.message : String(error);
      callbacks.log(`[codex-app] request_user_input failed: ${reason}`);
      const request = params && typeof params === 'object'
        ? params as Record<string, unknown>
        : {};
      if (typeof request.threadId !== 'string' || typeof request.turnId !== 'string') return;
      void callbacks.interrupt(request.threadId, request.turnId).catch(interruptError => {
        const detail = interruptError instanceof Error
          ? interruptError.message
          : String(interruptError);
        callbacks.log(`[codex-app] request_user_input interrupt failed: ${detail}`);
      });
    },
  );
}
