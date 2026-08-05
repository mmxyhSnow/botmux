/**
 * 在隔离 Codex App 线程中执行一次无工具、结构化的后台模型请求。
 * 仅继承登录凭据与显式模型配置，不加载工作区、Skill、MCP、插件或 Hook。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCommand } from '../adapters/cli/registry.js';

type JsonObject = Record<string, any>;

export interface CodexAppEphemeralStructuredTurnOptions {
  prompt: string;
  outputSchema: JsonObject;
  developerInstructions: string;
  serviceName: string;
  codexBin?: string;
  env?: NodeJS.ProcessEnv;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DISABLED_FEATURES = {
  apps: false,
  browser_use: false,
  browser_use_external: false,
  browser_use_full_cdp_access: false,
  code_mode: false,
  code_mode_host: false,
  computer_use: false,
  enable_mcp_apps: false,
  hooks: false,
  image_generation: false,
  in_app_browser: false,
  memories: false,
  multi_agent: false,
  multi_agent_v2: false,
  plugin_sharing: false,
  plugins: false,
  remote_plugin: false,
  skill_mcp_dependency_install: false,
  shell_tool: false,
  shell_snapshot: false,
  standalone_web_search: false,
  unified_exec: false,
  workspace_dependencies: false,
} as const;

/** 临时客户端只实现单次结构化 turn 需要的最小 JSON-RPC 协议。 */
class EphemeralStructuredClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();
  private active?: {
    threadId: string;
    turnId?: string;
    text: string;
    resolve: (text: string) => void;
    reject: (error: Error) => void;
  };

  constructor(codexBin: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', chunk => this.onStdout(chunk.toString('utf8')));
    this.child.on('error', error => this.failAll(error));
    this.child.on('exit', (code, signal) => {
      this.failAll(new Error(`Codex app-server exited (code=${code}, signal=${signal})`));
    });
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed'));
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  /** 先登记接收器再发 turn/start，避免响应与完成通知同批到达造成丢失。 */
  async run(threadId: string, prompt: string, outputSchema: JsonObject): Promise<string> {
    if (this.active) throw new Error('Codex app-server already has an active structured turn');
    let resolveTurn!: (text: string) => void;
    let rejectTurn!: (error: Error) => void;
    const completed = new Promise<string>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    this.active = { threadId, text: '', resolve: resolveTurn, reject: rejectTurn };
    const result = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      effort: 'low',
      environments: [],
      runtimeWorkspaceRoots: [],
      outputSchema,
    });
    if (typeof result?.turn?.id === 'string' && this.active) this.active.turnId = result.turn.id;
    return completed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.child.kill('SIGTERM'); } catch { /* 子进程已经退出 */ }
    const forceKill = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        try { this.child.kill('SIGKILL'); } catch { /* 子进程已经退出 */ }
      }
    }, 2_000);
    forceKill.unref?.();
    this.child.once('exit', () => clearTimeout(forceKill));
    this.failAll(new Error('Codex app-server closed'));
  }

  private onStdout(data: string): void {
    this.buffer += data;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonObject;
      try { message = JSON.parse(line); } catch { continue; }
      if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else if (typeof message.id === 'number' && typeof message.method === 'string') {
        this.answerServerRequest(message.id, message.method);
      } else if (typeof message.method === 'string') {
        this.onNotification(message.method, message.params);
      }
    }
  }

  /** 临时总结线程没有外部能力，所有服务端反向请求都明确拒绝。 */
  private answerServerRequest(id: number, method: string): void {
    let result: unknown;
    if (method === 'item/permissions/requestApproval') result = { permissions: {}, scope: 'turn' };
    else if (method === 'item/tool/requestUserInput') result = { answers: {} };
    else if (method === 'mcpServer/elicitation/request') result = { action: 'cancel', content: null, _meta: null };
    else if (method === 'item/tool/call') result = { contentItems: [], success: false };
    else result = { decision: 'decline' };
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  private onNotification(method: string, params: unknown): void {
    if (!this.active || !params || typeof params !== 'object') return;
    const event = params as JsonObject;
    if (event.threadId !== this.active.threadId) return;
    const turnId = typeof event.turnId === 'string' ? event.turnId : event.turn?.id;
    if (this.active.turnId && turnId && this.active.turnId !== turnId) return;
    if (!this.active.turnId && typeof turnId === 'string') this.active.turnId = turnId;
    if (method === 'item/agentMessage/delta' && typeof event.delta === 'string') {
      this.active.text += event.delta;
    } else if (method === 'item/completed' && event.item?.type === 'agentMessage') {
      if (typeof event.item.text === 'string') this.active.text = event.item.text;
    } else if (method === 'turn/failed') {
      const active = this.active;
      this.active = undefined;
      active.reject(new Error(`Codex structured turn failed: ${JSON.stringify(event.error ?? event.turn ?? {})}`));
    } else if (method === 'turn/completed') {
      const active = this.active;
      this.active = undefined;
      active.resolve(active.text);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.active?.reject(error);
    this.active = undefined;
  }
}

/** 只复制认证文件；其它 Codex 配置一律不进入临时总结线程。 */
function isolatedEnv(source: NodeJS.ProcessEnv | undefined, scratchDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(source ?? process.env) };
  const sourceHome = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  const targetHome = join(scratchDir, 'codex-home');
  mkdirSync(targetHome, { recursive: true, mode: 0o700 });
  try {
    const sourceAuth = join(sourceHome, 'auth.json');
    if (existsSync(sourceAuth)) {
      const targetAuth = join(targetHome, 'auth.json');
      copyFileSync(sourceAuth, targetAuth);
      chmodSync(targetAuth, 0o600);
    }
  } catch { /* 环境变量认证仍可继续使用 */ }
  env.CODEX_HOME = targetHome;
  delete env.BOTMUX_MCP_GATEWAY_REQUIRED;
  delete env.BOTMUX_MCP_GATEWAY_SOCKET;
  return env;
}

/** 执行一次有硬超时的隔离结构化请求；任何失败都返回 undefined。 */
export async function runCodexAppEphemeralStructuredTurn(
  options: CodexAppEphemeralStructuredTurnOptions,
): Promise<string | undefined> {
  if (!options.prompt.trim() || options.signal?.aborted) return undefined;
  const timeoutMs = Math.max(1, options.timeoutMs ?? 30_000);
  const scratchDir = mkdtempSync(join(tmpdir(), 'botmux-codex-structured-'));
  const client = new EphemeralStructuredClient(
    resolveCommand(options.codexBin ?? 'codex'),
    scratchDir,
    isolatedEnv(options.env, scratchDir),
  );
  let timer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    const abort = new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
      if (options.signal) {
        abortHandler = () => resolve(undefined);
        options.signal.addEventListener('abort', abortHandler, { once: true });
      }
    });
    const execute = (async (): Promise<string | undefined> => {
      await client.request('initialize', {
        clientInfo: { name: options.serviceName, version: '0.0.0' },
        capabilities: { experimentalApi: true },
      });
      client.notify('initialized');
      const config: JsonObject = {
        model_reasoning_effort: 'low',
        shell_environment_policy: { inherit: 'none' },
        project_doc_max_bytes: 0,
        project_doc_fallback_filenames: [],
        tools: { web_search: false },
        features: DISABLED_FEATURES,
      };
      if (options.model?.trim()) config.model = options.model.trim();
      const started = await client.request('thread/start', {
        cwd: scratchDir,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        serviceName: options.serviceName,
        developerInstructions: options.developerInstructions,
        ephemeral: true,
        threadSource: 'system',
        runtimeWorkspaceRoots: [],
        selectedCapabilityRoots: [],
        environments: [],
        dynamicTools: null,
        config,
      });
      const threadId = typeof started?.thread?.id === 'string' ? started.thread.id : undefined;
      return threadId ? client.run(threadId, options.prompt, options.outputSchema) : undefined;
    })();
    return await Promise.race([execute, abort]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
    if (options.signal && abortHandler) options.signal.removeEventListener('abort', abortHandler);
    client.close();
    try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* 由系统稍后清理 */ }
  }
}
