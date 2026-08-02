#!/usr/bin/env node
/**
 * 主动通知架构审计。
 *
 * 该门禁不判断业务文案，只阻止生产源码绕过 OwnerNoticeService 直接使用底层卡片槽位，
 * 并拦截把 owner/admin 作为接收人的直接飞书发送。确属用户主动请求的 Dashboard 私聊
 * 响应必须显式列入小型白名单，避免未来新增入口默认放行。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import typescript from 'typescript';

const { ScriptTarget, ScriptKind, SyntaxKind, createSourceFile, forEachChild } = typescript;
const args = process.argv.slice(2);
const rootArg = args.indexOf('--root');
const root = resolve(rootArg >= 0 ? args[rootArg + 1] ?? '' : process.cwd());
const sourceRoot = resolve(root, 'src');

const FACADE = 'src/services/owner-notice.ts';
/**
 * 现存直接私信都是用户主动请求或专用交互卡；数量也固定，新增调用必须修改本表接受审查。
 * OwnerNoticeService 自身保留唯一一处底层传输调用。
 */
const DIRECT_USER_MESSAGE_CALLS = new Map(Object.entries({
  'src/core/command-handler.ts': 1,
  'src/core/dashboard-command/groups.ts': 1,
  'src/core/dashboard-command/index.ts': 1,
  'src/core/dashboard-command/overview.ts': 1,
  'src/core/dashboard-command/schedules.ts': 1,
  'src/core/dashboard-command/sessions.ts': 1,
  'src/core/dashboard-command/settings.ts': 1,
  'src/core/worker-pool.ts': 2,
  'src/daemon.ts': 1,
  'src/im/lark/card-handler.ts': 1,
  [FACADE]: 1,
}));
const REVIEWED_OWNER_ADMIN_SENDS = new Set([
  'src/core/dashboard-command/groups.ts',
  'src/core/dashboard-command/index.ts',
  'src/core/dashboard-command/overview.ts',
  'src/core/dashboard-command/schedules.ts',
  'src/core/dashboard-command/sessions.ts',
  'src/core/dashboard-command/settings.ts',
]);

function filesBelow(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) files.push(...filesBelow(path));
    else if (/\.(?:ts|tsx)$/.test(name)) files.push(path);
  }
  return files;
}

function repoPath(path) {
  return relative(root, path).split(sep).join('/');
}

function importedModule(node) {
  if (node.kind !== SyntaxKind.ImportDeclaration && node.kind !== SyntaxKind.ExportDeclaration) return undefined;
  const value = node.moduleSpecifier?.text;
  return typeof value === 'string' ? value : undefined;
}

function calledName(node) {
  if (node.kind !== SyntaxKind.CallExpression) return undefined;
  const expression = node.expression;
  if (expression?.kind === SyntaxKind.Identifier) return expression.text;
  return undefined;
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

const violations = [];
const directUserMessageCalls = new Map();
for (const path of filesBelow(sourceRoot)) {
  const file = repoPath(path);
  const text = readFileSync(path, 'utf8');
  const source = createSourceFile(path, text, ScriptTarget.Latest, true, ScriptKind.TS);
  const visit = (node) => {
    const moduleName = importedModule(node);
    if (
      file !== FACADE
      && moduleName
      && /(?:^|\/)(?:owner-notice-card|owner-notice-card-store)\.js$/.test(moduleName)
    ) {
      violations.push(`${file}:${lineOf(source, node)} 只能由 ${FACADE} 导入主动通知底层模块`);
    }

    const call = calledName(node);
    if (file !== FACADE && (call === 'buildOwnerNoticeCard' || call === 'upsertOwnerNoticeCard')) {
      violations.push(`${file}:${lineOf(source, node)} 必须改用 deliverOwnerNotice`);
    }
    if (call === 'sendUserMessage') {
      directUserMessageCalls.set(file, (directUserMessageCalls.get(file) ?? 0) + 1);
      const recipient = node.arguments?.[1]?.getText(source) ?? '';
      if (/(?:owner|admin)/i.test(recipient) && !REVIEWED_OWNER_ADMIN_SENDS.has(file)) {
        violations.push(`${file}:${lineOf(source, node)} owner/admin 主动私信必须改用 deliverOwnerNotice`);
      }
    }
    forEachChild(node, visit);
  };
  visit(source);
}

for (const [file, count] of directUserMessageCalls) {
  const expected = DIRECT_USER_MESSAGE_CALLS.get(file);
  if (expected === undefined) violations.push(`${file} 新增了未登记的 sendUserMessage 调用`);
  else if (count !== expected) violations.push(`${file} sendUserMessage 调用数 ${count} 与登记值 ${expected} 不一致`);
}
for (const [file, expected] of DIRECT_USER_MESSAGE_CALLS) {
  const actual = directUserMessageCalls.get(file) ?? 0;
  if (actual !== expected && !violations.some(item => item.startsWith(`${file} sendUserMessage`))) {
    violations.push(`${file} sendUserMessage 调用数 ${actual} 与登记值 ${expected} 不一致`);
  }
}

if (violations.length > 0) {
  console.error(`Owner notice architecture audit failed (${violations.length}):`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}
console.log(`Owner notice architecture audit passed (${filesBelow(sourceRoot).length} source files)`);
