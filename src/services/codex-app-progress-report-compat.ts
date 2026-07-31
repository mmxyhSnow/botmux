/**
 * Codex App 历史完整报告的样式兼容层。
 * 旧报告被冻结在数据目录时，通过精确替换已知 CSS 规则恢复行内列表布局。
 */
import { readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

const LEGACY_FINAL_RESPONSE_LIST_STYLE = '.final-response li{display:grid;grid-template-columns:28px minmax(0,1fr);gap:8px;padding:14px 0;border-bottom:1px solid var(--border);color:var(--muted)}';
const LEGACY_FINAL_RESPONSE_INDEX_STYLE = '.final-response li:before{counter-increment:outcome;content:counter(outcome,decimal-leading-zero);padding-top:2px;color:#858a9a;font:700 9px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}';

export const FINAL_RESPONSE_LIST_STYLE = '.final-response li{position:relative;padding:14px 0 14px 36px;border-bottom:1px solid var(--border);color:var(--muted)}';
export const FINAL_RESPONSE_INDEX_STYLE = '.final-response li:before{position:absolute;top:16px;left:0;width:28px;counter-increment:outcome;content:counter(outcome,decimal-leading-zero);color:#858a9a;font:700 9px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}';

/** 读取历史冻结报告时替换旧网格规则，使已生成的报告也能恢复正常行内排版。 */
export function normalizeCodexAppProgressReportHtml(html: string): string {
  return html
    .replace(LEGACY_FINAL_RESPONSE_LIST_STYLE, FINAL_RESPONSE_LIST_STYLE)
    .replace(LEGACY_FINAL_RESPONSE_INDEX_STYLE, FINAL_RESPONSE_INDEX_STYLE);
}

/** 按需原子升级历史报告样式；文件缺失或不可写时保留现有路由与错误处理语义。 */
export function normalizeHistoricalCodexAppProgressReportFile(filePath: string): void {
  try {
    const html = readFileSync(filePath, 'utf8');
    const normalized = normalizeCodexAppProgressReportHtml(html);
    if (normalized !== html) atomicWriteFileSync(filePath, normalized);
  } catch {
    // Dashboard 会继续按原有 stat/静态文件逻辑处理缺失或不可读文件。
  }
}
