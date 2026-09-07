import { useState } from 'react';

import type { KeyKind, LabKeyRef, LabProfile } from '@tokenshield/client';

import { api } from '../api';
import { Card, selectClass } from './ui';

const inputClass =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-600 focus:ring-1 focus:ring-sky-600/40';

/**
 * Target *management* — adding and removing gateways and keys.
 *
 * Deliberately not a selector. Selection moved to the bar at the top of every
 * page, and leaving a second copy of the same three controls here meant one
 * screen with two ways to change the same thing and no hint which one mattered.
 * This is the inventory; the bar is the switch.
 */
export function TargetPicker({
  profiles,
  keys,
  activeProfileId,
  activeKeyAlias,
  onTargetsChanged,
  onProfile,
  onKey,
  onRun,
  running,
  runError,
}: {
  profiles: LabProfile[];
  keys: LabKeyRef[];
  activeProfileId: string;
  activeKeyAlias: string | null;
  onTargetsChanged: () => void;
  onProfile: (id: string) => void;
  onKey: (alias: string) => void;
  onRun: () => void;
  running: boolean;
  runError: string | null;
}) {
  const [addingProfile, setAddingProfile] = useState(false);
  const [profileLabel, setProfileLabel] = useState('');
  const [profileUrl, setProfileUrl] = useState('');
  const [profileError, setProfileError] = useState<string | null>(null);

  const [addingKey, setAddingKey] = useState(false);
  const [keyAliasInput, setKeyAliasInput] = useState('');
  const [keySecret, setKeySecret] = useState('');
  const [keyKind, setKeyKind] = useState<KeyKind>('api');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyNotice, setKeyNotice] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);

  async function submitProfile(): Promise<void> {
    setBusy(true);
    setProfileError(null);
    try {
      const created = await api.addProfile({ label: profileLabel, baseUrl: profileUrl });
      setProfileLabel('');
      setProfileUrl('');
      setAddingProfile(false);
      onTargetsChanged();
      onProfile(created.id);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitKey(): Promise<void> {
    setBusy(true);
    setKeyError(null);
    setKeyNotice(null);
    try {
      const created = await api.addKey({ alias: keyAliasInput, secret: keySecret, kind: keyKind });
      // Clear the pasted value immediately — the backend holds it now, and the
      // tab has no reason to keep it in a form field.
      setKeySecret('');
      setKeyAliasInput('');
      setAddingKey(false);
      onTargetsChanged();
      if (created.kind === 'api') onKey(created.alias);
      if (created.warning !== undefined) setKeyNotice(created.warning);
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(kind: 'profile' | 'key', id: string): Promise<void> {
    const setErr = kind === 'profile' ? setProfileError : setKeyError;
    setErr(null);
    try {
      if (kind === 'profile') await api.removeProfile(id);
      else await api.removeKey(id);
      onTargetsChanged();
    } catch (err) {
      setErr(err instanceof Error ? err.message : String(err));
    }
  }

  const apiKeys = keys.filter((k) => k.kind === 'api');
  const otherKeys = keys.filter((k) => k.kind !== 'api');

  return (
    <Card
      title="Targets"
      subtitle="Everything this lab can point at. Switch between them in the bar above; add and remove them here."
      right={
        <button
          type="button"
          onClick={onRun}
          disabled={running}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {running ? 'Running preflight…' : 'Run preflight'}
        </button>
      }
    >
      <div className="grid gap-5 md:grid-cols-2">
        {/* ── Gateways ── */}
        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Gateways
            </h3>
            <button
              type="button"
              onClick={() => {
                setAddingProfile(!addingProfile);
                setProfileError(null);
              }}
              className="text-[11px] text-sky-400 hover:text-sky-300"
            >
              {addingProfile ? 'cancel' : '+ add gateway'}
            </button>
          </div>

          {addingProfile && (
            <div className="mb-2 space-y-2 rounded-md border border-sky-900/50 bg-sky-950/10 p-2">
              <input
                className={inputClass}
                placeholder="Label — e.g. Staging"
                value={profileLabel}
                onChange={(e) => setProfileLabel(e.target.value)}
              />
              <input
                className={`mono ${inputClass}`}
                placeholder="https://gateway.example.com"
                value={profileUrl}
                onChange={(e) => setProfileUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitProfile();
                }}
              />
              <button
                type="button"
                disabled={busy || profileUrl.trim().length === 0}
                onClick={() => void submitProfile()}
                className="w-full rounded-md border border-sky-700 bg-sky-950/40 px-3 py-1.5 text-xs text-sky-200 hover:bg-sky-900/40 disabled:opacity-40"
              >
                Add gateway
              </button>
            </div>
          )}

          <ul className="space-y-1">
            {profiles.map((p) => (
              <li
                key={p.id}
                className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs ${
                  p.id === activeProfileId
                    ? 'border-sky-800/70 bg-sky-950/20'
                    : 'border-zinc-800 bg-zinc-950/40'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onProfile(p.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="text-zinc-200">{p.label}</span>
                  <span className="mono ml-2 truncate text-[10px] text-zinc-600">{p.baseUrl}</span>
                </button>
                {p.source === 'session' ? (
                  <>
                    <span className="rounded bg-amber-500/10 px-1 text-[10px] text-amber-300">
                      session
                    </span>
                    <button
                      type="button"
                      onClick={() => void remove('profile', p.id)}
                      className="text-[10px] text-rose-400/70 hover:text-rose-300"
                    >
                      remove
                    </button>
                  </>
                ) : (
                  <span className="text-[10px] text-zinc-700">.env.local</span>
                )}
              </li>
            ))}
          </ul>
          {profileError !== null && <p className="mt-1.5 text-xs text-rose-400">{profileError}</p>}
        </section>

        {/* ── Keys ── */}
        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Credentials
            </h3>
            <button
              type="button"
              onClick={() => {
                setAddingKey(!addingKey);
                setKeyError(null);
                setKeySecret('');
              }}
              className="text-[11px] text-sky-400 hover:text-sky-300"
            >
              {addingKey ? 'cancel' : '+ add key'}
            </button>
          </div>

          {addingKey && (
            <div className="mb-2 space-y-2 rounded-md border border-sky-900/50 bg-sky-950/10 p-2">
              <input
                className={inputClass}
                placeholder="Alias — e.g. STAGING_BEDROCK"
                value={keyAliasInput}
                onChange={(e) => setKeyAliasInput(e.target.value)}
              />
              <input
                className={`mono ${inputClass}`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="cg-ak-…"
                value={keySecret}
                onChange={(e) => setKeySecret(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitKey();
                }}
              />
              <select
                className={selectClass}
                value={keyKind}
                onChange={(e) => setKeyKind(e.target.value as KeyKind)}
              >
                <option value="api">api key (cg-ak-)</option>
                <option value="management">management key (cg-mk-)</option>
                <option value="admin">admin key</option>
              </select>
              <button
                type="button"
                disabled={busy || keySecret.trim().length === 0 || keyAliasInput.trim().length === 0}
                onClick={() => void submitKey()}
                className="w-full rounded-md border border-sky-700 bg-sky-950/40 px-3 py-1.5 text-xs text-sky-200 hover:bg-sky-900/40 disabled:opacity-40"
              >
                Add key
              </button>
              <p className="text-[11px] leading-relaxed text-zinc-600">
                Held in the backend&rsquo;s memory only — never written to .env.local, never sent
                back to this page, gone when the server restarts.
              </p>
            </div>
          )}

          <ul className="space-y-1">
            {[...apiKeys, ...otherKeys].map((k) => (
              <li
                key={k.alias}
                className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs ${
                  k.alias === activeKeyAlias
                    ? 'border-sky-800/70 bg-sky-950/20'
                    : 'border-zinc-800 bg-zinc-950/40'
                }`}
              >
                <button
                  type="button"
                  disabled={k.kind !== 'api'}
                  onClick={() => onKey(k.alias)}
                  className="min-w-0 flex-1 text-left disabled:cursor-default"
                >
                  <span className="text-zinc-200">{k.alias}</span>
                  <span className="mono ml-2 text-[10px] text-zinc-600">{k.masked}</span>
                </button>
                {k.kind !== 'api' && (
                  <span className="rounded bg-violet-500/10 px-1 text-[10px] text-violet-300">
                    {k.kind}
                  </span>
                )}
                {k.source === 'session' ? (
                  <>
                    <span className="rounded bg-amber-500/10 px-1 text-[10px] text-amber-300">
                      session
                    </span>
                    <button
                      type="button"
                      onClick={() => void remove('key', k.alias)}
                      className="text-[10px] text-rose-400/70 hover:text-rose-300"
                    >
                      remove
                    </button>
                  </>
                ) : (
                  <span className="text-[10px] text-zinc-700">.env.local</span>
                )}
              </li>
            ))}
          </ul>
          {keyError !== null && <p className="mt-1.5 text-xs text-rose-400">{keyError}</p>}
          {keyNotice !== null && <p className="mt-1.5 text-xs text-amber-400">{keyNotice}</p>}
        </section>
      </div>

      <p className="mt-4 text-xs text-zinc-600">
        Preflight runs six checks against the selected target. No provider call, costs nothing.
      </p>
      {runError !== null && (
        <p className="mt-3 rounded-md border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
          {runError}
        </p>
      )}
    </Card>
  );
}
