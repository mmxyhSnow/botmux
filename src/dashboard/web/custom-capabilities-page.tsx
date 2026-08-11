/** 自定义能力全景页：展示升级契约清单，并集中编辑清单中已有的 Bot 级控制。 */
import { useEffect, useMemo, useState } from 'react';
import { fetchBotDefaults, type BotDefaultsRow } from './bot-defaults.js';
import { useDashboardLocale, useT } from './react-hooks.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';

type CapabilityControl = {
  key: 'askReminderPolicy' | 'codexAppImmediateProgressCard' | 'topicStatusDisplay';
  scope: 'bot';
  kind: 'boolean' | 'enum';
  defaultValue: boolean | string;
  options?: string[];
};

type CustomCapability = {
  id: string;
  name: string;
  nameEn: string;
  category: 'interaction' | 'reliability' | 'release';
  criticality: 'release-blocking';
  description: string;
  descriptionEn: string;
  controls: CapabilityControl[];
};

type CapabilityPayload = {
  baseline: { upstreamTag: string; integrationBranch: string; productionBranch: string };
  capabilities: CustomCapability[];
};

type SaveState = { key: string; ok?: boolean; message?: string } | null;

const categoryOrder: CustomCapability['category'][] = ['interaction', 'reliability', 'release'];

function botLabel(bot: BotDefaultsRow): string {
  return bot.botName ? `${bot.botName} · ${bot.larkAppId}` : bot.larkAppId;
}

function controlValue(bot: BotDefaultsRow, control: CapabilityControl): boolean | string {
  if (control.key === 'codexAppImmediateProgressCard') return bot.codexAppImmediateProgressCard !== false;
  if (control.key === 'askReminderPolicy') {
    return bot.askReminderPolicy === 'repeat-reminder' ? 'repeat-reminder' : 'auto-recommend';
  }
  return bot.topicStatusDisplay === 'reply-preview' || bot.topicStatusDisplay === 'bot-root'
    ? bot.topicStatusDisplay
    : 'off';
}

async function writeControl(bot: BotDefaultsRow, control: CapabilityControl, value: boolean | string): Promise<Record<string, unknown>> {
  const appId = encodeURIComponent(bot.larkAppId);
  const topicStatus = control.key === 'topicStatusDisplay';
  const path = topicStatus
    ? `/api/bots/${appId}/topic-status-display`
    : `/api/bots/${appId}/card-prefs`;
  const response = await fetch(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [control.key]: value }),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || body.ok !== true) throw new Error(String(body.error ?? `HTTP ${response.status}`));
  return body;
}

function CustomCapabilitiesPage() {
  const tr = useT();
  const locale = useDashboardLocale();
  const [catalog, setCatalog] = useState<CapabilityPayload | null>(null);
  const [bots, setBots] = useState<BotDefaultsRow[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<SaveState>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      fetch('/api/custom-capabilities').then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(body.capabilities)) throw new Error(body.error ?? `HTTP ${response.status}`);
        return body as CapabilityPayload;
      }),
      fetchBotDefaults(),
    ]).then(([nextCatalog, botResult]) => {
      if (!active) return;
      if (botResult.error) throw new Error(botResult.error);
      setCatalog(nextCatalog);
      setBots(botResult.bots);
      setSelectedId(current => current || botResult.bots[0]?.larkAppId || '');
    }).catch(error => {
      if (active) setLoadError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, []);

  const selectedBot = bots.find(bot => bot.larkAppId === selectedId) ?? bots[0] ?? null;
  const grouped = useMemo(() => categoryOrder.map(category => ({
    category,
    capabilities: catalog?.capabilities.filter(capability => capability.category === category) ?? [],
  })), [catalog]);

  async function save(control: CapabilityControl, value: boolean | string): Promise<void> {
    if (!selectedBot) return;
    setSaving({ key: control.key });
    try {
      const body = await writeControl(selectedBot, control, value);
      setBots(current => current.map(bot => bot.larkAppId === selectedBot.larkAppId
        ? { ...bot, [control.key]: body[control.key] }
        : bot));
      setSaving({ key: control.key, ok: true, message: tr('customCapabilities.saved') });
    } catch (error) {
      setSaving({ key: control.key, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <section className="page custom-capabilities-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.customCapabilities')}</p>
          <h1>{tr('customCapabilities.title')}</h1>
          <p>{tr('customCapabilities.subtitle', { count: catalog?.capabilities.length ?? 0 })}</p>
        </div>
      </div>

      {loadError ? <div className="custom-capabilities-error">{tr('customCapabilities.loadFailed')}: {loadError}</div> : null}
      {!loadError && !catalog ? <div className="custom-capabilities-loading">{tr('customCapabilities.loading')}</div> : null}

      {catalog ? (
        <>
          <div className="custom-capabilities-toolbar">
            <div>
              <strong>{tr('customCapabilities.botScope')}</strong>
              <small>{tr('customCapabilities.botScopeHelp')}</small>
            </div>
            <select aria-label={tr('customCapabilities.botScope')} value={selectedBot?.larkAppId ?? ''} disabled={bots.length === 0} onChange={event => setSelectedId(event.currentTarget.value)}>
              {bots.length === 0 ? <option value="">{tr('customCapabilities.noBots')}</option> : null}
              {bots.map(bot => <option key={bot.larkAppId} value={bot.larkAppId}>{botLabel(bot)}</option>)}
            </select>
            <span className="custom-capabilities-baseline">{tr('customCapabilities.baseline', { tag: catalog.baseline.upstreamTag })}</span>
          </div>

          {grouped.map(group => group.capabilities.length > 0 ? (
            <section className="custom-capability-group" key={group.category}>
              <h2>{tr(`customCapabilities.category.${group.category}`)}</h2>
              <div className="custom-capability-grid">
                {group.capabilities.map(capability => (
                  <article className="custom-capability-card" key={capability.id} data-capability-id={capability.id}>
                    <div className="custom-capability-head">
                      <h3>{locale === 'en' ? capability.nameEn : capability.name}</h3>
                      <span>{capability.controls.length > 0 ? tr('customCapabilities.configurable') : tr('customCapabilities.alwaysOn')}</span>
                    </div>
                    <p>{locale === 'en' ? capability.descriptionEn : capability.description}</p>
                    {capability.controls.length === 0 ? (
                      <div className="custom-capability-static">{tr('customCapabilities.noControl')}</div>
                    ) : capability.controls.map(control => (
                      <ControlEditor
                        key={control.key}
                        bot={selectedBot}
                        control={control}
                        saving={saving}
                        onSave={save}
                      />
                    ))}
                  </article>
                ))}
              </div>
            </section>
          ) : null)}
        </>
      ) : null}
    </section>
  );
}

function ControlEditor(props: {
  bot: BotDefaultsRow | null;
  control: CapabilityControl;
  saving: SaveState;
  onSave(control: CapabilityControl, value: boolean | string): Promise<void>;
}) {
  const tr = useT();
  const busy = props.saving?.key === props.control.key && props.saving.message === undefined;
  const value = props.bot ? controlValue(props.bot, props.control) : props.control.defaultValue;
  const status = props.saving?.key === props.control.key && props.saving.message
    ? <small className={props.saving.ok ? 'ok' : 'error'}>{props.saving.ok ? '✓ ' : '✗ '}{props.saving.message}</small>
    : null;
  if (props.control.kind === 'boolean') {
    return (
      <div className="custom-capability-control">
        <label className="toggle-row">
          <input type="checkbox" checked={value === true} disabled={!props.bot || busy} onChange={event => void props.onSave(props.control, event.currentTarget.checked)} />
          <span className="switch" aria-hidden="true" />
          <span className="toggle-tx"><strong>{tr(`customCapabilities.control.${props.control.key}`)}</strong><small>{tr(`customCapabilities.control.${props.control.key}.help`)}</small></span>
        </label>
        {status}
      </div>
    );
  }
  return (
    <div className="custom-capability-control">
      <label>
        <strong>{tr(`customCapabilities.control.${props.control.key}`)}</strong>
        <select value={String(value)} disabled={!props.bot || busy} onChange={event => void props.onSave(props.control, event.currentTarget.value)}>
          {(props.control.options ?? []).map(option => <option key={option} value={option}>{tr(`customCapabilities.option.${props.control.key}.${option}`)}</option>)}
        </select>
      </label>
      <small>{tr(`customCapabilities.control.${props.control.key}.help`)}</small>
      {status}
    </div>
  );
}

export function renderCustomCapabilitiesPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <CustomCapabilitiesPage />);
}
