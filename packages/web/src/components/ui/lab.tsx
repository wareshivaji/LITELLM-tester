import type { CheckStatus, VerdictKind } from '@tokenshield/client';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * The lab's own components - the ones that encode something about THIS domain
 * rather than about buttons.
 *
 * This file is what `components/ui.tsx` used to be. It kept its exports and
 * lost its styling: every colour and radius that used to be spelled out here as
 * literal utility classes now comes from a token or a primitive variant. The
 * public API is unchanged on purpose, so the thirteen files that import from
 * `components/ui` did not have to be touched to gain the new look.
 *
 * What stayed here and what moved out was decided by one question: would a
 * different app want this? `Button` and `Select` would go in any app, so they
 * are primitives. `VerdictLegend` explains the classifier's vocabulary and
 * `Json` exists because this tool's output gets pasted into tickets - neither
 * means anything elsewhere.
 */

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
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-card-foreground">{title}</h2>
          {subtitle !== undefined && (
            <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

const CHECK_GLYPH: Record<CheckStatus, string> = {
  pass: '✓',
  warn: '!',
  fail: '✕',
  skip: '–',
};

/**
 * A check outcome.
 *
 * `CheckStatus` and `Badge`'s variants are deliberately the same four names, so
 * this is a lookup rather than a mapping table. The glyph is kept because these
 * pills are read in dense rows where colour alone is not enough - and colour
 * alone is not an accessible distinction in any case.
 */
export function StatusPill({ status, label }: { status: CheckStatus; label?: string }) {
  return (
    <Badge variant={status}>
      <span aria-hidden>{CHECK_GLYPH[status]}</span>
      {label ?? status}
    </Badge>
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

/**
 * A labelled control.
 *
 * No longer a `<label>` wrapping its child. It could be while every control was
 * a native `<select>`; a composed Radix control is several elements and nesting
 * one inside a label makes the label's implicit association ambiguous. `Label`
 * handles the association instead, and `htmlFor` can be passed when a control
 * needs it explicitly.
 */
export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="block">
      <Label htmlFor={htmlFor} className="mb-1.5">
        {label}
      </Label>
      {children}
      {hint !== undefined && (
        <span className="mt-1 block text-xs text-muted-foreground/70">{hint}</span>
      )}
    </div>
  );
}

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
          <Button variant="outline" size="xs" onClick={() => setOpen(!open)}>
            {open ? 'collapse' : `expand (${text.length.toLocaleString()} chars)`}
          </Button>
        )}
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            void navigator.clipboard
              .writeText(text)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              })
              .catch(() => setCopied(false));
          }}
        >
          {copied ? 'copied' : 'copy'}
        </Button>
      </div>
      {open ? (
        <pre
          className="mono overflow-auto rounded-md border border-border bg-background p-3 pr-20 text-xs leading-relaxed text-foreground/80"
          style={{ maxHeight }}
        >
          {text}
        </pre>
      ) : (
        <div className="mono rounded-md border border-border bg-background p-3 pr-32 text-xs text-muted-foreground">
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
      <Button
        variant="link"
        size="xs"
        className="text-xs text-muted-foreground underline decoration-dotted hover:text-foreground hover:no-underline"
        onClick={() => setOpen(!open)}
      >
        what do these verdicts mean?
      </Button>
      {open && (
        <dl className="mt-2 grid gap-x-4 gap-y-1 rounded-md border border-border bg-background/60 p-3 sm:grid-cols-2">
          {rows.map(([name, meaning]) => (
            <div key={name} className="flex gap-2">
              <dt className="mono w-28 shrink-0 text-foreground/70">{name}</dt>
              <dd className="text-muted-foreground">{meaning}</dd>
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
  return (
    <div
      className={cn(
        'rounded-lg border p-4 text-sm',
        tone === 'warn'
          ? 'border-warn-foreground/25 bg-warn text-warn-foreground'
          : 'border-info-foreground/25 bg-info text-info-foreground',
      )}
    >
      <h3 className="text-xs font-semibold uppercase tracking-wider">{title}</h3>
      <div className="mt-2 space-y-1 opacity-90">{children}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}
