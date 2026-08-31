import type { AuthScheme, LabKeyRef, LabProfile } from '@tokenshield/client';

/**
 * The target bar: which gateway, which credential, presented how.
 *
 * It is interactive on every page, not just Connect. Every page's behaviour
 * depends on the target, and having to navigate back to a settings page to
 * change it — then navigate forward again — was the single most annoying thing
 * about using this tool.
 *
 * It stays pinned and always readable because the most expensive recurring bug
 * in this workspace has been "which gateway did that run actually hit?".
 */
export function TargetBar({
  profiles,
  keys,
  profileId,
  keyAlias,
  scheme,
  onProfile,
  onKey,
  onScheme,
  logCount,
  logOpen,
  onToggleLog,
}: {
  profiles: LabProfile[];
  keys: LabKeyRef[];
  profileId: string;
  keyAlias: string | null;
  scheme: AuthScheme;
  onProfile: (id: string) => void;
  onKey: (alias: string | null) => void;
  onScheme: (scheme: AuthScheme) => void;
  logCount: number;
  logOpen: boolean;
  onToggleLog: () => void;
}) {
  const profile = profiles.find((p) => p.id === profileId);
  const apiKeys = keys.filter((k) => k.kind === 'api');
  const key = apiKeys.find((k) => k.alias === keyAlias);
  const isSession = profile?.source === 'session' || key?.source === 'session';

  const bare =
    'rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none hover:border-zinc-600 focus:border-sky-600';

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-800 bg-zinc-950/90 px-4 py-2">
      <span className="text-[10px] uppercase tracking-wider text-zinc-600">gateway</span>
      <select className={bare} value={profileId} onChange={(e) => onProfile(e.target.value)}>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
            {p.source === 'session' ? ' (session)' : ''}
          </option>
        ))}
      </select>
      <span className="mono hidden text-[11px] text-zinc-500 lg:inline">{profile?.baseUrl ?? '—'}</span>

      <span className="text-zinc-800">|</span>

      <span className="text-[10px] uppercase tracking-wider text-zinc-600">key</span>
      <select
        className={bare}
        value={keyAlias ?? ''}
        onChange={(e) => onKey(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">— none —</option>
        {apiKeys.map((k) => (
          <option key={k.alias} value={k.alias}>
            {k.alias}
            {k.source === 'session' ? ' (session)' : ''}
          </option>
        ))}
      </select>
      {key !== undefined && <span className="mono text-[11px] text-zinc-600">{key.masked}</span>}

      <span className="text-zinc-800">|</span>

      {/* Two options, so a toggle rather than a select — one click, not two. */}
      <button
        type="button"
        onClick={() => onScheme(scheme === 'bearer' ? 'x-api-key' : 'bearer')}
        title="Click to switch how the credential is presented. TokenShield accepts both."
        className="mono rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-sky-700 hover:text-sky-200"
      >
        {scheme === 'bearer' ? 'Authorization: Bearer' : 'x-api-key'}
      </button>

      {isSession && (
        <span
          className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300"
          title="This target was entered in the console and lives in memory only — it disappears when the lab server restarts."
        >
          session
        </span>
      )}

      <button
        type="button"
        onClick={onToggleLog}
        className={`ml-auto flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${
          logOpen
            ? 'border-sky-700 bg-sky-950/40 text-sky-200'
            : 'border-zinc-700 text-zinc-300 hover:border-zinc-600'
        }`}
      >
        Exchange log
        <span className="mono rounded bg-zinc-800 px-1.5 text-[10px] text-zinc-300">{logCount}</span>
        <span className="text-zinc-600">{logOpen ? '▾' : '▴'}</span>
      </button>
    </header>
  );
}
