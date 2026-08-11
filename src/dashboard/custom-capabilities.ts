/**
 * Dashboard 自定义能力清单投影。
 * 数据来自仓库根目录的升级契约清单，只暴露展示和控制元数据，不泄露源码接入点。
 */
import { existsSync, readFileSync } from 'node:fs';

export type DashboardCapabilityControl = {
  key: 'askReminderPolicy' | 'codexAppImmediateProgressCard' | 'topicStatusDisplay';
  scope: 'bot';
  kind: 'boolean' | 'enum';
  defaultValue: boolean | string;
  options?: string[];
};

export type DashboardCustomCapability = {
  id: string;
  name: string;
  nameEn: string;
  category: 'interaction' | 'reliability' | 'release';
  criticality: 'release-blocking';
  description: string;
  descriptionEn: string;
  controls: DashboardCapabilityControl[];
};

type CapabilityManifest = {
  schemaVersion: number;
  baseline: {
    upstreamTag: string;
    integrationBranch: string;
    productionBranch: string;
  };
  capabilities: DashboardCustomCapability[];
};

const manifestUrls = [
  // 源码 checkout：src/dashboard/custom-capabilities.ts → 仓库根清单。
  new URL('../../custom-capabilities.json', import.meta.url),
  // npm 产物：dist/dashboard/custom-capabilities.js → dist 内随包清单。
  new URL('../custom-capabilities.json', import.meta.url),
];

/** 每次请求回读当前 checkout，便于源码升级后的清单立即成为 Dashboard 全景。 */
export function customCapabilitiesDashboardPayload(): {
  schemaVersion: number;
  baseline: CapabilityManifest['baseline'];
  capabilities: DashboardCustomCapability[];
} {
  const manifestUrl = manifestUrls.find(candidate => existsSync(candidate));
  if (!manifestUrl) throw new Error('custom-capabilities.json is missing from this Botmux runtime');
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as CapabilityManifest;
  return {
    schemaVersion: manifest.schemaVersion,
    baseline: manifest.baseline,
    capabilities: manifest.capabilities.map(capability => ({
      id: capability.id,
      name: capability.name,
      nameEn: capability.nameEn,
      category: capability.category,
      criticality: capability.criticality,
      description: capability.description,
      descriptionEn: capability.descriptionEn,
      controls: Array.isArray(capability.controls) ? capability.controls : [],
    })),
  };
}
