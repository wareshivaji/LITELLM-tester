import { useState } from 'react';

import type { AuthScheme, KeyKind, LabKeyRef, LabProfile } from '@tokenshield/client';

import { api } from '../api';
import { Card, Field, selectClass } from './ui';

const inputClass =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-600 focus:ring-1 focus:ring-sky-600/40';

function AddButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[11px] text-sky-400 hover:text-sky-300"
    >
      {open ? 'cancel' : '+ add'}
    </button>
  );
}

/** Splits the dropdown so a target that vanishes on restart is never a surprise. */
function SourceOptions<T extends { source: 'file' | 'session' }>({
  items,
  render,
}: {
  items: T[];
  render: (item: T) => { value: string; label: string };
}) {
  const file = items.filter((i) => i.source === 'file');
  const session = items.filter((i) => i.source === 'session');
  return (
    <>
      {file.length > 0 && (
        <optgroup label="From .env.local">
          {file.map((item) => {
            const { value, label } = render(item);
            return (
              <option key={value} value={value}>
                {label}
              </option>
            );
          })}
        </optgroup>
      )}
      {session.length > 0 && (
        <optgroup label="This session — gone on restart">
          {session.map((item) => {
            const { value, label } = render(item);
            return (
              <option key={value} value={value}>
                {label}
              </option>
            );
          })}
        </optgroup>
      )}
    </>
  );
}

interface TargetPickerProps {
  profiles: LabProfile[];
  keys: LabKeyRef[];
  profileId: string;
  keyAlias: string | null;
  scheme: AuthScheme;
  onProfile: (id: string) => void;
  onKey: (alias: string | null) => void;
  onScheme: (scheme: AuthScheme) => void;
  /** Refetch config after the registry changed. */
  onTargetsChanged: () => void;
  onRun: () => void;
  running: boolean;
  runError: string | null;
}

export function TargetPicker(props: TargetPickerProps) {
  const apiKeys = props.keys.filter((k) => k.kind === 'api');
  const selectedProfile = props.profiles.find((p) => p.id === props.profileId);
  const selectedKey = apiKeys.find((k) => k.alias === props.keyAlias);

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
      props.onTargetsChanged();
      props.onProfile(created.id);
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
      props.onTargetsChanged();
      if (created.kind === 'api') props.onKey(created.alias);
      if (created.warning !== undefined) setKeyNotice(created.warning);
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeProfile(id: string): Promise<void> {
    setProfileError(null);
    try {
      await api.removeProfile(id);
      props.onTargetsChanged();
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeKey(alias: string): Promise<void> {
    setKeyError(null);
    try {
      await api.removeKey(alias);
      props.onTargetsChanged();
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Card
      title="Target"
      subtitle="Which gateway, which credential, presented how. Stamped on every exchange."
    >
      <div className="grid gap-4 md:grid-cols-3">
        {/* ── Gateway ── */}
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Gateway
            </span>
            <AddButton
              open={addingProfile}
              onClick={() => {
                setAddingProfile(!addingProfile);
                setProfileError(null);
              }}
            />
          </div>
          {addingProfile ? (
            <div className="space-y-2">
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
          ) : (
            <>
              <select
                className={selectClass}
                value={props.profileId}
                onChange={(e) => props.onProfile(e.target.value)}
              >
                <SourceOptions
                  items={props.profiles}
                  render={(p) => ({ value: p.id, label: p.label })}
                />
              </select>
              <div className="mono mt-1 flex items-center gap-2 text-xs text-zinc-600">
                <span className="truncate">{selectedProfile?.baseUrl ?? '—'}</span>
                {selectedProfile?.source === 'session' && (
                  <button
                    type="button"
                    onClick={() => void removeProfile(selectedProfile.id)}
                    className="shrink-0 text-rose-400/70 hover:text-rose-300"
                  >
                    remove
                  </button>
                )}
              </div>
            </>
          )}
          {profileError !== null && <p className="mt-1.5 text-xs text-rose-400">{profileError}</p>}
        </div>

        {/* ── API key ── */}
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              API key
            </span>
            <AddButton
              open={addingKey}
              onClick={() => {
                setAddingKey(!addingKey);
                setKeyError(null);
                setKeySecret('');
              }}
            />
          </div>
          {addingKey ? (
            <div className="space-y-2">
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
                Held in the backend’s memory only — never written to .env.local, never sent back to
                this page, gone when the server restarts.
              </p>
            </div>
          ) : (
            <>
              <select
                className={selectClass}
                value={props.keyAlias ?? ''}
                onChange={(e) => props.onKey(e.target.value === '' ? null : e.target.value)}
              >
                <option value="">— none (unauthenticated) —</option>
                <SourceOptions
                  items={apiKeys}
                  render={(k) => ({ value: k.alias, label: k.alias })}
                />
              </select>
              <div className="mono mt-1 flex items-center gap-2 text-xs text-zinc-600">
                <span className="truncate">
                  {selectedKey?.masked ?? (apiKeys.length === 0 ? 'no keys configured' : 'unauthenticated')}
                </span>
                {selectedKey?.source === 'session' && (
                  <button
                    type="button"
                    onClick={() => void removeKey(selectedKey.alias)}
                    className="shrink-0 text-rose-400/70 hover:text-rose-300"
                  >
                    remove
                  </button>
                )}
              </div>
            </>
          )}
          {keyError !== null && <p className="mt-1.5 text-xs text-rose-400">{keyError}</p>}
          {keyNotice !== null && <p className="mt-1.5 text-xs text-amber-400">{keyNotice}</p>}
        </div>

        {/* ── Auth header ── */}
        <Field label="Auth header" hint="TokenShield accepts both; clients in the wild use both.">
          <div className="flex gap-2">
            {(['bearer', 'x-api-key'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => props.onScheme(s)}
                className={`mono flex-1 rounded-md border px-3 py-2 text-xs ${
                  props.scheme === s
                    ? 'border-sky-600 bg-sky-950/40 text-sky-200'
                    : 'border-zinc-700 text-zinc-400 hover:border-zinc-600'
                }`}
              >
                {s === 'bearer' ? 'Authorization: Bearer' : 'x-api-key'}
              </button>
            ))}
          </div>
        </Field>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={props.onRun}
          disabled={props.running}
          className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {props.running ? 'Running preflight…' : 'Run preflight'}
        </button>
        <span className="text-xs text-zinc-600">5 checks · no provider call · costs nothing</span>
      </div>

      {props.runError !== null && (
        <p className="mt-3 rounded-md border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
          {props.runError}
        </p>
      )}
    </Card>
  );
}
