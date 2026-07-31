/**
 * 自定义发布版本规则：解析官方稳定版、候选版和部署版标签，并计算下一个 custom 序号。
 * 版本号沿用官方基线，避免与 upstream 的 `vX.Y.Z` 正式标签发生所有权冲突。
 */

const OFFICIAL_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const CUSTOM_TAG = /^(release|deploy)\/v(\d+)\.(\d+)\.(\d+)-custom\.(\d+)$/;

/** 解析官方稳定版标签；预发布和自定义标签返回 null。 */
export function parseOfficialTag(tag) {
  const match = String(tag).match(OFFICIAL_TAG);
  if (!match) return null;
  return {
    tag,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** 解析 fork 的候选版或部署版标签。 */
export function parseCustomTag(tag) {
  const match = String(tag).match(CUSTOM_TAG);
  if (!match) return null;
  return {
    tag,
    kind: match[1],
    officialTag: `v${match[2]}.${match[3]}.${match[4]}`,
    version: `${match[2]}.${match[3]}.${match[4]}-custom.${match[5]}`,
    custom: Number(match[5]),
  };
}

/** 按 SemVer 核心版本从新到旧比较官方标签。 */
export function compareOfficialTags(left, right) {
  const a = parseOfficialTag(left);
  const b = parseOfficialTag(right);
  if (!a || !b) throw new Error('只能比较官方稳定版标签');
  return b.major - a.major || b.minor - a.minor || b.patch - a.patch;
}

/** 从 HEAD 可达标签中选出最新官方稳定版。 */
export function latestOfficialTag(tags) {
  const stable = tags.filter(tag => parseOfficialTag(tag));
  stable.sort(compareOfficialTags);
  if (!stable[0]) throw new Error('当前提交没有可达的官方稳定版标签');
  return stable[0];
}

/** 计算指定官方基线下一个未占用的 custom 版本。 */
export function nextCustomVersion(officialTag, tags) {
  if (!parseOfficialTag(officialTag)) throw new Error(`无效官方版本标签: ${officialTag}`);
  const occupied = tags
    .map(parseCustomTag)
    .filter(value => value?.officialTag === officialTag)
    .map(value => value.custom);
  const next = Math.max(0, ...occupied) + 1;
  return `${officialTag.slice(1)}-custom.${next}`;
}

/** 生成候选版或部署版的完整标签。 */
export function customTag(kind, version) {
  if (kind !== 'release' && kind !== 'deploy') throw new Error(`无效标签类型: ${kind}`);
  const parsed = parseCustomTag(`${kind}/v${version}`);
  if (!parsed) throw new Error(`无效自定义版本: ${version}`);
  return parsed.tag;
}
