/**
 * 官方源码同步的重启后部署留痕：新 daemon 先核对真实运行 HEAD、远端生产 HEAD
 * 与候选标签，再复用 release:record-deploy 写入不可变 deploy 标签。
 */
import { spawn } from 'node:child_process';
import { botmuxInstallRoot } from '../utils/install-info.js';

const RESULT_PREFIX = 'BOTMUX_CUSTOM_RELEASE_RESULT=';
const RELEASE_TAG = /^release\/v\d+\.\d+\.\d+-custom\.\d+$/;
const COMMIT = /^[0-9a-f]{40}$/;
const MAX_TAIL = 64 * 1024;

interface CommandResult {
  code: number;
  output: string;
}

export interface SourceUpdateDeployResult {
  productionHead: string;
  deployTag: string;
}

export interface SourceUpdateDeployDeps {
  activePackageRoot: () => string;
  run: (command: string, args: string[], cwd: string) => Promise<CommandResult>;
}

function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const capture = (chunk: Buffer | string): void => {
      output = (output + String(chunk)).slice(-MAX_TAIL);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', reject);
    child.once('close', code => resolve({ code: code ?? 1, output }));
  });
}

const PRODUCTION_DEPS: SourceUpdateDeployDeps = {
  activePackageRoot: botmuxInstallRoot,
  run: runCommand,
};

async function checkedRun(
  deps: SourceUpdateDeployDeps,
  label: string,
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  const result = await deps.run(command, args, cwd);
  if (result.code !== 0) {
    throw new Error(`${label}：${result.output.trim().slice(-1000) || `exit ${result.code}`}`);
  }
  return result.output.trim();
}

function parseResult(output: string): Record<string, unknown> {
  const line = output.split(/\r?\n/).reverse().find(item => item.startsWith(RESULT_PREFIX));
  if (!line) throw new Error('部署留痕命令没有结构化终态');
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length)) as Record<string, unknown>;
  } catch {
    throw new Error('部署留痕命令返回的结构化终态无效');
  }
}

/** 仅在重启后的运行态三方 HEAD 一致时记录官方同步对应的 deploy 标签。 */
export async function finalizeSourceUpdateDeployment(
  releaseTag: string,
  expectedHead: string,
  deps: SourceUpdateDeployDeps = PRODUCTION_DEPS,
): Promise<SourceUpdateDeployResult> {
  if (!RELEASE_TAG.test(releaseTag)) throw new Error('官方同步候选标签无效');
  if (!COMMIT.test(expectedHead)) throw new Error('官方同步候选 HEAD 无效');
  const root = deps.activePackageRoot();
  const branch = await checkedRun(deps, '无法回读运行分支', 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
  if (branch !== 'custom/prod') throw new Error('新 daemon 未运行在 custom/prod');
  const localHead = await checkedRun(deps, '无法回读运行 HEAD', 'git', ['rev-parse', 'HEAD'], root);
  if (localHead !== expectedHead) throw new Error('新 daemon 运行 HEAD 与官方同步候选不一致');
  const tagHead = await checkedRun(deps, '无法回读候选标签', 'git', ['rev-list', '-n', '1', releaseTag], root);
  if (tagHead !== expectedHead) throw new Error('官方同步候选标签与预期 HEAD 不一致');
  const remote = await checkedRun(
    deps,
    '无法回读远端 custom/prod',
    'git',
    ['ls-remote', 'origin', 'refs/heads/custom/prod'],
    root,
  );
  if (remote.split(/\s+/)[0] !== expectedHead) throw new Error('远端 custom/prod 与官方同步候选不一致');

  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const recorded = await deps.run(pnpm, ['release:record-deploy', '--', '--tag', releaseTag], root);
  if (recorded.code !== 0) {
    throw new Error(`部署留痕失败：${recorded.output.trim().slice(-1000) || `exit ${recorded.code}`}`);
  }
  const payload = parseResult(recorded.output);
  const deployTag = `deploy/${releaseTag.slice('release/'.length)}`;
  if (
    payload.ok !== true
    || payload.action !== 'record-deploy'
    || payload.releaseTag !== releaseTag
    || payload.deployTag !== deployTag
    || payload.commit !== expectedHead
  ) throw new Error('部署留痕结果与官方同步候选不一致');
  return { productionHead: expectedHead, deployTag };
}
