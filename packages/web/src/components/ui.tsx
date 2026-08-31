import { useState } from 'react';
import type { ReactNode } from 'react';

import type { CheckStatus, VerdictKind } from '@tokenshield/client';

/** Re-exported so pages can type their own outcome→tone maps. */
export type CheckStatusLike = CheckStatus;

export function Card({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      <header className="flex items-start justify-between gap-4 border-b border-zinc-800 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-zinc-100">{title}</h2>
          {subtitle !== undefined && <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>}
        </div>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

const CHECK_TONE: Record<CheckStatus, string> = {
  pass: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30',
  warn: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
  fail: 'bg-rose-500/10 text-rose-300 ring-rose-500/30',
  skip: 'bg-zinc-500/10 text-zinc-400 ring-zinc-500/30',
};

const CHECK_GLYPH: Record<CheckStatus, string> = {
  pass: '✓',
  warn: '!',
  fail: '✕',
  skip: '–',
};

export function StatusPill({ status, label }: { status: CheckStatus; label?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${CHECK_TONE[status]}`}
    >
      <span aria-hidden>{CHECK_GLYPH[status]}</span>
      {label ?? status}
    </span>
  );
}

/** Verdicts that mean "the gateway did its job", not "something broke". */
const EXPECTED_REJECTIONS: ReadonlySet<VerdictKind> = new Set<VerdictKind>([
  'budget',
  'ratelimit',
  'guardrail',
  'model-denied',
  'ip-blocked',
  'tool-policy',
]);

export function verdictTone(kind: VerdictKind): CheckStatus {
  if (kind === 'ok') return 'pass';
  if (EXPECTED_REJECTIONS.has(kind)) return 'warn';
  return 'fail';
}

export function VerdictPill({ kind }: { kind: VerdictKind }) {
  return <StatusPill status={verdictTone(kind)} label={kind} />;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      {children}
      {hint !== undefined && <span className="mt-1 block text-xs text-zinc-600">{hint}</span>}
    </label>
  );
}

export const selectClass =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-600 focus:ring-1 focus:ring-sky-600/40';

/**
 * A JSON block you can actually get data out of.
 *
 * The copy button is the point: most of what this tool produces ends up pasted
 * into a ticket or a message, and selecting text out of a scrolling `<pre>` is
 * miserable. Large payloads collapse by default so a 1024-dimension embedding
 * does not bury the page.
 */
export function Json({
  value,
  maxHeight = 320,
  collapsedByDefault,
}: {
  value: unknown;
  maxHeight?: number;
  collapsedByDefault?: boolean;
}) {
  const text = JSON.stringify(value, null, 2) ?? 'undefined';
  const big = text.length > 4000;
  const [open, setOpen] = useState(!(collapsedByDefault ?? big));
  const [copied, setCopied] = useState(false);

  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-10 flex gap-1">
        {(big || collapsedByDefault === true) && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="rounded border border-zinc-700 bg-zinc-900/90 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:border-zinc-600"
          >
            {open ? 'collapse' : `expand (${text.length.toLocaleString()} chars)`}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard
              .writeText(text)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              })
              .catch(() => setCopied(false));
          }}
          className="rounded border border-zinc-700 bg-zinc-900/90 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:border-zinc-600"
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      {open ? (
        <pre
          className="mono overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 pr-20 text-xs leading-relaxed text-zinc-300"
          style={{ maxHeight }}
        >
          {text}
        </pre>
      ) : (
        <div className="mono rounded-md border border-zinc-800 bg-zinc-950 p-3 pr-32 text-xs text-zinc-600">
          {text.slice(0, 140).replace(/\s+/g, ' ')}…
        </div>
      )}
    </div>
  );
}

/**
 * What the verdict names mean, on tap.
 *
 * The whole point of the classifier is that "it failed" is useless and
 * `budget` versus `ratelimit` is not — but only if the reader knows the
 * vocabulary. Rather than a doc nobody opens, the legend sits next to where the
 * words appear.
 */
export function VerdictLegend() {
  const [open, setOpen] = useState(false);
  const rows: Array<[string, string]> = [
    ['ok', 'The gateway accepted it'],
    ['auth', 'Missing or invalid credential'],
    ['budget', 'A spend cap was reached — 429 with insufficient_quota'],
    ['ratelimit', 'The per-minute limiter refused it — a different 429 entirely'],
    ['model-denied', "The key's allowedModels does not include that model"],
    ['no-credential', 'The key has no credential mapped for that provider'],
    ['ip-blocked', 'The source IP is not in the key allowlist'],
    ['guardrail', 'Blocked by a content rule — arrives as a 400, not a 403'],
    ['tool-policy', 'A tool policy refused the request'],
    ['bad-request', 'Malformed request, with no more specific cause'],
    ['not-found', 'No such route, model or resource'],
    ['server-error', 'The gateway answered 5xx'],
    ['transport-error', 'No response at all — refused, timed out, unresolvable'],
  ];
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-zinc-500 underline decoration-dotted hover:text-zinc-300"
      >
        what do these verdicts mean?
      </button>
      {open && (
        <dl className="mt-2 grid gap-x-4 gap-y-1 rounded-md border border-zinc-800 bg-zinc-950/60 p-3 sm:grid-cols-2">
          {rows.map(([name, meaning]) => (
            <div key={name} className="flex gap-2">
              <dt className="mono w-28 shrink-0 text-zinc-400">{name}</dt>
              <dd className="text-zinc-500">{meaning}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** A prominent, actionable message for a state the operator must fix. */
export function Notice({
  tone,
  title,
  children,
}: {
  tone: 'warn' | 'info';
  title: string;
  children: ReactNode;
}) {
  const styles =
    tone === 'warn'
      ? 'border-amber-900/60 bg-amber-950/20 text-amber-200/90'
      : 'border-sky-900/60 bg-sky-950/20 text-sky-200/90';
  return (
    <div className={`rounded-lg border p-4 text-sm ${styles}`}>
      <h3 className="text-xs font-semibold uppercase tracking-wider">{title}</h3>
      <div className="mt-2 space-y-1">{children}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-zinc-600">{children}</p>;
}
