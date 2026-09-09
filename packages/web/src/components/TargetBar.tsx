import { ChevronDownIcon } from 'lucide-react';

import type { AuthScheme, LabKeyRef, LabProfile } from '@tokenshield/client';

import { cn } from '../lib/utils';

import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Toggle,
} from './ui';

/** "no key selected" — Radix reserves '' to mean "nothing selected". */
const NO_KEY = '__none__';

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

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-background/90 px-4 py-2">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">gateway</span>
      <Select value={profileId} onValueChange={onProfile}>
        <SelectTrigger size="sm" className="w-auto gap-1.5 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {profiles.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.label}
              {p.source === 'session' ? ' (session)' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="mono hidden text-[11px] text-muted-foreground lg:inline">
        {profile?.baseUrl ?? '—'}
      </span>

      <Separator orientation="vertical" className="h-5" />

      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">key</span>
      <Select value={keyAlias ?? NO_KEY} onValueChange={(v) => onKey(v === NO_KEY ? null : v)}>
        <SelectTrigger size="sm" className="w-auto gap-1.5 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_KEY}>— none —</SelectItem>
          {apiKeys.map((k) => (
            <SelectItem key={k.alias} value={k.alias}>
              {k.alias}
              {k.source === 'session' ? ' (session)' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {key !== undefined && (
        <span className="mono text-[11px] text-muted-foreground">{key.masked}</span>
      )}

      <Separator orientation="vertical" className="h-5" />

      {/* Two options, so a toggle rather than a select — one click, not two. */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => onScheme(scheme === 'bearer' ? 'x-api-key' : 'bearer')}
        title="Click to switch how the credential is presented. TokenShield accepts both."
        className="mono h-8 px-2 text-[11px]"
      >
        {scheme === 'bearer' ? 'Authorization: Bearer' : 'x-api-key'}
      </Button>

      {isSession && (
        <span
          className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300"
          title="This target was entered in the console and lives in memory only — it disappears when the lab server restarts."
        >
          session
        </span>
      )}

      {/* A Toggle, not a Button: the log panel is open or shut and this control
          reflects which. It previously said so in colour and a glyph only, so a
          screen reader announced "Exchange log, button" either way. Radix
          supplies `aria-pressed`; the chevron stays as the sighted
          affordance. */}
      <Toggle
        pressed={logOpen}
        onPressedChange={onToggleLog}
        aria-label="Exchange log"
        className="ml-auto font-sans"
      >
        Exchange log
        <span className="mono rounded bg-secondary px-1.5 text-[10px] text-foreground/80">
          {logCount}
        </span>
        <ChevronDownIcon
          className={cn('size-3.5 transition-transform', logOpen && 'rotate-180')}
          aria-hidden
        />
      </Toggle>
    </header>
  );
}
