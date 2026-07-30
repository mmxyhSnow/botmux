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

/** 读取可选自动决策窗口；普通阻塞选择最多等待一小时。 */
function askTimeoutMs(params: unknown): number {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 3_600_000;
  const value = (params as Record<string, unknown>).autoResolutionMs;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1_000
    ? Math.min(value, 3_600_000)
    : 3_600_000;
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
  const body = {
    sessionId: context.sessionId,
    chatId,
    larkAppId,
    rootMessageId: root?.startsWith('om_') ? root : null,
    questions: parsed.questions.map(entry => entry.question),
    timeoutMs: askTimeoutMs(params),
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
  };
  if (result.kind !== 'answered') {
    throw new Error(`ask not answered (${result.kind ?? 'unknown'})`);
  }

  const customText = result.comment?.trim() ?? '';
  const answers: CodexAppUserInputResponse['answers'] = {};
  parsed.questions.forEach((entry, index) => {
    const selected = result.answers?.[index] ?? [];
    const values = selected.length > 0 ? [...selected] : customText ? [customText] : [];
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
