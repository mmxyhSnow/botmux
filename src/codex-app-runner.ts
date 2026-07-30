#!/usr/bin/env node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Buffer } from 'node:buffer';
import {
  buildCodexAppTurnStartParams,
  codexVersionAtLeast,
  isCleanInputCapabilityError,
  supportsClientUserMessageId,
} from './adapters/cli/codex-app-turn.js';
import { RunnerControlWriter } from './adapters/cli/runner-control-channel.js';
import {
  CodexAppRpcResponseError,
  CodexAppTransportError,
  CodexAppTurnController,
  type CodexAppPreparedInput,
} from './services/codex-app-turn-controller.js';
import {
  CODEX_APP_INPUT_PREFIX,
  decodeCodexAppRunnerInput,
  type CodexAppRunnerInput,
} from './services/codex-app-runner-protocol.js';
import { codexAppDeveloperInstructions } from './services/codex-app-developer-instructions.js';
import { emitCodexAppFinalWithOutbox } from './services/codex-app-final-outbox.js';
import { dispatchCodexAppUserInput } from './services/codex-app-user-input.js';
import { detectCodexAppVersion } from './services/codex-app-version.js';
type JsonObject = Record<string, any>;
interface Args {
  sessionId: string;
  codexBin: string;
  cwd: string;
  threadId?: string;
  botName?: string;
  botOpenId?: string;
  locale?: string;
}
interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  method: string;
}
const output = new RunnerControlWriter();
function parseArgs(argv: string[]): Args {
  const out: Args = {
    sessionId: '',
    codexBin: 'codex',
    cwd: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--session-id' && val !== undefined) { out.sessionId = val; i++; }
    else if (key === '--codex-bin' && val !== undefined) { out.codexBin = val; i++; }
    else if (key === '--cwd' && val !== undefined) { out.cwd = val; i++; }
    else if (key === '--thread-id' && val !== undefined) { out.threadId = val; i++; }
    else if (key === '--bot-name' && val !== undefined) { out.botName = val; i++; }
    else if (key === '--bot-open-id' && val !== undefined) { out.botOpenId = val; i++; }
    else if (key === '--locale' && val !== undefined) { out.locale = val; i++; }
  }
  if (!out.sessionId) throw new Error('--session-id is required');
  return out;
}

function emitMarker(kind: string, payload: unknown): void {
  output.marker(kind, payload);
}

function writeLine(text = ''): void {
  output.line(text);
}

function prompt(): void {
  output.display('› ');
}

class AppServerClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stdoutBuffer = '';
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers: Array<(msg: JsonObject) => void> = [];
  private requestHandlers: Array<(msg: JsonObject) => boolean> = [];
  private fatalHandlers: Array<(error: CodexAppTransportError) => void> = [];
  private lastStderr = '';
  private fatalError?: CodexAppTransportError;

  constructor(
    private readonly codexBin: string,
    private readonly cwd: string,
    enableDefaultUserInput: boolean,
  ) {
    const featureArgs = enableDefaultUserInput
      ? ['--enable', 'default_mode_request_user_input']
      : [];
    this.child = spawn(codexBin, ['app-server', ...featureArgs, '--listen', 'stdio://'], {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', chunk => this.onStdout(chunk.toString('utf8')));
    this.child.stdin.on('error', err => this.failAll(new CodexAppTransportError(`Codex app-server stdin error: ${err.message}`)));
    this.child.stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      this.lastStderr = (this.lastStderr + text).slice(-8000);
      if (process.env.BOTMUX_CODEX_APP_DEBUG === '1') output.error(text);
    });
    this.child.on('error', err => {
      const hint = (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? '\nHint: install the Codex CLI, or set cliPathOverride to the Codex App bundled binary, for example /Applications/Codex.app/Contents/Resources/codex.'
        : '';
      this.failAll(new CodexAppTransportError(`Failed to start Codex app-server with "${codexBin}": ${err.message}${hint}`));
    });
    this.child.on('exit', (code, signal) => {
      const err = this.fatalError ?? new CodexAppTransportError(`Codex app-server exited (code=${code}, signal=${signal})${this.lastStderr ? `\n${this.lastStderr}` : ''}`);
      this.failAll(err);
    });
  }

  onNotification(handler: (msg: JsonObject) => void): void {
    this.notificationHandlers.push(handler);
  }

  onRequest(handler: (msg: JsonObject) => boolean): void {
    this.requestHandlers.push(handler);
  }

  onFatal(handler: (error: CodexAppTransportError) => void): void {
    this.fatalHandlers.push(handler);
    if (this.fatalError) handler(this.fatalError);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'botmux-codex-app', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.failAll(new CodexAppTransportError(`Codex app-server write failed: ${message}`));
      }
    });
  }

  respond(id: number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  notify(method: string, params?: unknown): void {
    const msg: JsonObject = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    this.write(msg);
  }

  close(): void {
    try { this.child.kill(); } catch { /* already gone */ }
  }

  private write(msg: JsonObject): void {
    if (this.fatalError) throw this.fatalError;
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  private failAll(err: Error): void {
    const firstFailure = this.fatalError === undefined;
    this.fatalError = this.fatalError ?? (
      err instanceof CodexAppTransportError
        ? err
        : new CodexAppTransportError(err.message)
    );
    const fatal = this.fatalError;
    for (const pending of this.pending.values()) pending.reject(fatal);
    this.pending.clear();
    if (firstFailure) {
      for (const handler of this.fatalHandlers) handler(fatal);
    }
  }

  private onStdout(data: string): void {
    this.stdoutBuffer += data;
    for (;;) {
      const nl = this.stdoutBuffer.indexOf('\n');
      if (nl < 0) return;
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonObject;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonObject): void {
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new CodexAppRpcResponseError(pending.method, msg.error));
      else pending.resolve(msg.result);
      return;
    }

    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      for (const handler of this.requestHandlers) {
        if (handler(msg)) return;
      }
      this.respond(msg.id, { decision: 'decline' });
      return;
    }

    if (typeof msg.method === 'string') {
      for (const handler of this.notificationHandlers) handler(msg);
    }
  }
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err: any) {
  output.error(`${err?.message ?? err}\n`);
  process.exit(2);
}

let threadId = args.threadId;
let threadReady = false;
let inputBuffer = '';
let cleanVersionWarningShown = false;
let controller: CodexAppTurnController;

const currentCodexVersion = detectCodexAppVersion(args.codexBin, args.cwd, process.env);
const client = new AppServerClient(
  args.codexBin,
  args.cwd,
  !!currentCodexVersion && codexVersionAtLeast(currentCodexVersion, 0, 146, 0),
);

function handleServerRequest(msg: JsonObject): boolean {
  const method = msg.method;
  if (method === 'item/commandExecution/requestApproval') {
    client.respond(msg.id, { decision: 'acceptForSession' });
    return true;
  }
  if (method === 'item/fileChange/requestApproval') {
    client.respond(msg.id, { decision: 'acceptForSession' });
    return true;
  }
  if (method === 'item/permissions/requestApproval') {
    client.respond(msg.id, { permissions: {}, scope: 'turn' });
    return true;
  }
  if (method === 'item/tool/requestUserInput') {
    dispatchCodexAppUserInput(msg.params, {
      sessionId: args.sessionId,
      env: process.env,
    }, {
      respond: result => client.respond(msg.id, result),
      interrupt: (threadId, turnId) => client.request('turn/interrupt', { threadId, turnId }),
      log: writeLine,
    });
    return true;
  }
  if (method === 'mcpServer/elicitation/request') {
    client.respond(msg.id, { action: 'cancel', content: null, _meta: null });
    return true;
  }
  if (method === 'item/tool/call') {
    client.respond(msg.id, { contentItems: [], success: false });
    return true;
  }
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    client.respond(msg.id, { decision: 'approved_for_session' });
    return true;
  }
  return false;
}

function handleNotification(msg: JsonObject): void {
  controller?.handleNotification(msg);
}

async function ensureThread(): Promise<string> {
  if (threadReady && threadId) return threadId;

  if (threadId) {
    try {
      const resumed = await client.request('thread/resume', {
        threadId,
        cwd: args.cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        config: { shell_environment_policy: { inherit: 'all' } },
        developerInstructions: codexAppDeveloperInstructions(args),
        excludeTurns: true,
        // Keep Codex App's rich history in sync with turns created by this
        // external runner so the desktop UI can render follow-up messages.
        persistExtendedHistory: true,
      });
      const resumedThreadId = String(resumed.thread.id);
      threadId = resumedThreadId;
      threadReady = true;
      emitMarker('thread', { threadId: resumedThreadId });
      return resumedThreadId;
    } catch (err: any) {
      writeLine(`[codex-app] resume failed, starting a fresh thread: ${err?.message ?? err}`);
      threadId = undefined;
      threadReady = false;
    }
  }

  const started = await client.request('thread/start', {
    cwd: args.cwd,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    config: { shell_environment_policy: { inherit: 'all' } },
    serviceName: 'botmux',
    developerInstructions: codexAppDeveloperInstructions(args),
    ephemeral: false,
    experimentalRawEvents: false,
    // Keep Codex App's rich history in sync with turns created by this
    // external runner so the desktop UI can render follow-up messages.
    persistExtendedHistory: true,
  });
  const startedThreadId = String(started.thread.id);
  threadId = startedThreadId;
  threadReady = true;
  emitMarker('thread', { threadId: startedThreadId });
  try {
    await client.request('thread/name/set', {
      threadId: startedThreadId,
      name: `botmux ${args.sessionId.slice(0, 8)}`,
    });
  } catch { /* naming is cosmetic */ }
  return startedThreadId;
}

function prepareControllerInput(
  message: CodexAppRunnerInput,
  structuredDisabled: boolean,
): CodexAppPreparedInput {
  const version = message.codexAppInput || message.replyTurnId
    ? currentCodexVersion
    : undefined;
  const built = buildCodexAppTurnStartParams({
    threadId: threadId ?? '',
    cwd: args.cwd,
    legacyContent: message.content,
    codexAppInput: message.codexAppInput,
    codexVersion: version,
    structuredDisabled,
  });
  if (
    message.codexAppInput
    && !built.structured
    && !structuredDisabled
    && !cleanVersionWarningShown
  ) {
    cleanVersionWarningShown = true;
    const found = version ? `${version.major}.${version.minor}.${version.patch}` : 'unknown';
    writeLine(`[codex-app] clean input requires codex >= 0.135.0 (found ${found}); using legacy prompt`);
  }
  const clientUserMessageId = !structuredDisabled
    && message.replyTurnId
    && version
    && supportsClientUserMessageId(version)
    ? message.replyTurnId
    : built.params.clientUserMessageId;
  return {
    input: built.params.input,
    ...(built.params.additionalContext
      ? { additionalContext: built.params.additionalContext }
      : {}),
    ...(clientUserMessageId ? { clientUserMessageId } : {}),
    visibleText: message.codexAppInput?.text ?? message.content,
    structured: built.structured,
    skippedImages: built.skippedImages,
  };
}

controller = new CodexAppTurnController({
  cwd: args.cwd,
  ensureThread,
  request: (method, params) => client.request(method, params),
  prepareInput: prepareControllerInput,
  isStartCapabilityError: isCleanInputCapabilityError,
  onTurnInput(_input, prepared) {
    writeLine();
    writeLine('[user]');
    writeLine(prepared.visibleText);
    writeLine();
  },
  onOutput: text => output.display(text),
  onProgress: snapshot => {
    if (!snapshot.turnId) return;
    emitMarker('progress', {
      content: snapshot.content,
      updatedAtMs: snapshot.updatedAtMs,
      replyTurnId: snapshot.turnId,
    });
  },
  onDiagnostic: writeLine,
  onLifecycle: event => emitMarker('lifecycle', event),
  onFinal: marker => {
    const dataDir = process.env.SESSION_DATA_DIR;
    if (!dataDir) {
      output.error('[codex-app] final outbox write failed: SESSION_DATA_DIR is missing\n');
      return;
    }
    try {
      emitCodexAppFinalWithOutbox(
        dataDir,
        args.sessionId,
        marker,
        persisted => emitMarker('final', persisted),
      );
    } catch (error) {
      output.error(
        `[codex-app] final outbox write failed: `
        + `${error instanceof Error ? error.message : String(error)}\n`,
      );
      return;
    }
    writeLine();
  },
  onPrompt: prompt,
});

function enqueueLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed.startsWith(CODEX_APP_INPUT_PREFIX)) {
    const decoded = decodeCodexAppRunnerInput(trimmed);
    if (decoded) controller.enqueue(decoded);
    else writeLine('[codex-app] bad botmux input');
    return;
  }
  controller.enqueue({ type: 'message', content: line });
}

function handleInput(data: Buffer): void {
  const text = data.toString('utf8');
  for (const ch of text) {
    if (ch === '\u0003') {
      process.exit(130);
    } else if (ch === '\r' || ch === '\n') {
      const line = inputBuffer;
      inputBuffer = '';
      enqueueLine(line);
    } else if (ch === '\u007f' || ch === '\b') {
      inputBuffer = inputBuffer.slice(0, -1);
    } else {
      inputBuffer += ch;
    }
  }
}

async function main(): Promise<void> {
  client.onRequest(handleServerRequest);
  client.onNotification(handleNotification);
  client.onFatal(error => {
    controller.handleFatal(error);
    process.exitCode = 1;
    process.stdout.write('', () => process.exit(1));
  });
  await client.initialize();
  await ensureThread();
  writeLine('Codex App connected.');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleInput);
  prompt();
}

process.on('SIGTERM', () => {
  client.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  client.close();
  process.exit(130);
});

main().catch(err => {
  output.error(`${err?.stack ?? err?.message ?? err}\n`);
  process.exit(1);
});
