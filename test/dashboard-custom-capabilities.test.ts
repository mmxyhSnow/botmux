/** 自定义能力 Dashboard 契约：清单、Tab 路由和现有控制必须保持同源。 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { customCapabilitiesDashboardPayload } from '../src/dashboard/custom-capabilities.js';

describe('dashboard custom capabilities', () => {
  it('projects all upgrade-contract capabilities and their existing controls', () => {
    const payload = customCapabilitiesDashboardPayload();
    expect(payload.capabilities).toHaveLength(10);
    expect(payload.capabilities.map(capability => capability.id)).toEqual([
      'progress-card',
      'request-user-input',
      'final-reply-actions',
      'durable-turn-recovery',
      'topic-status',
      'owner-notices',
      'custom-release-lifecycle',
      'versioned-runtime-rollback',
      'production-skill-sync',
      'official-source-update-gates',
    ]);
    expect(payload.capabilities.flatMap(capability => capability.controls.map(control => control.key))).toEqual([
      'codexAppImmediateProgressCard',
      'askReminderPolicy',
      'topicStatusDisplay',
    ]);
    expect(payload.capabilities.every(capability => capability.name && capability.nameEn
      && capability.description && capability.descriptionEn)).toBe(true);
    expect(payload.capabilities[0]).not.toHaveProperty('entrypoints');
  });

  it('places the new Tab immediately after Global Settings and uses existing write APIs', () => {
    const app = readFileSync(new URL('../src/dashboard/web/app.tsx', import.meta.url), 'utf8');
    const page = readFileSync(new URL('../src/dashboard/web/custom-capabilities-page.tsx', import.meta.url), 'utf8');
    expect(app.indexOf("id: 'custom-capabilities'")).toBeGreaterThan(app.indexOf("id: 'settings'"));
    expect(page).toContain('/api/custom-capabilities');
    expect(page).toContain('/card-prefs');
    expect(page).toContain('/topic-status-display');
  });

  it('ships the manifest inside the npm dist payload', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: { build: string } };
    const distAudit = readFileSync(new URL('../scripts/audit-dist.mjs', import.meta.url), 'utf8');
    expect(pkg.scripts.build).toContain('cp custom-capabilities.json dist/');
    expect(distAudit).toContain("resolve(distDir, 'custom-capabilities.json')");
  });
});
