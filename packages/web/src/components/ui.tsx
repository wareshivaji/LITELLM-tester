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

export function Json({ value, maxHeight = 320 }: { value: unknown; maxHeight?: number }) {
  return (
    <pre
      className="mono overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-300"
      style={{ maxHeight }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-zinc-600">{children}</p>;
}
