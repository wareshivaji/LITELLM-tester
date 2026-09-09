import type { ReactNode } from 'react';

import { gapsMovingTo, probesFor, unknownFieldsIn } from '@tokenshield/client';
import type { SurfaceSpec } from '@tokenshield/client';

import { cn } from '../lib/utils';
import type { Composer } from '../hooks/useComposer';
import {
  Button,
  Card,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from './ui';

/**
 * The active tab's colour, by surface family.
 *
 * Kept through the move to Tabs rather than flattened to the primary colour.
 * In a COMPATIBILITY lab the family is information: an OpenAI-shaped surface,
 * an Anthropic-shaped one and a utility endpoint answer differently, and which
 * kind you are pointed at is the first thing you need to know when reading a
 * result. Losing it would have been a real regression dressed as consistency.
 */
const FAMILY_ACTIVE: Record<string, string> = {
  openai:
    'data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:ring-primary/40',
  anthropic:
    'data-[state=active]:bg-violet-500/15 data-[state=active]:text-violet-300 data-[state=active]:ring-violet-400/40',
  utility:
    'data-[state=active]:bg-secondary data-[state=active]:text-foreground data-[state=active]:ring-border',
};

export function RequestComposer({
  composer,
  surfaces,
  showProbes = false,
  extraControls,
  actions,
  sendHint,
  onSubmit,
}: {
  composer: Composer;
  surfaces: readonly SurfaceSpec[];
  showProbes?: boolean;
  /** Surface-specific toggles, rendered beside the model and prompt. */
  extraControls?: ReactNode;
  /** The send / stop row. */
  actions: ReactNode;
  sendHint?: ReactNode;
  /** Ctrl/Cmd+Enter in the body editor. Sending is the only thing you do here. */
  onSubmit?: () => void;
}) {
  const probes = showProbes ? probesFor(composer.surface.id) : [];

  // Fields in the body that this surface's contract does not list, per LiteLLM
  // v1.100.0 (see fields.ts). Deliberately a NOTE and not an error: sending an
  // out-of-contract field is often the whole point of the test — whether the
  // gateway rejects it or silently ignores it is the finding. Blocking send
  // here would remove the only way to ask.
  const strayFields = composer.parsed.ok
    ? unknownFieldsIn(composer.surface.id, composer.parsed.value)
    : [];

  // What a request loses arriving at THIS surface from the other one. Only the
  // gaps with no replacement are shown: those are the ones that fail silently.
  const silentLosses = gapsMovingTo(
    composer.surface.id === 'responses' ? 'responses' : 'chat.completions',
  ).filter((g) => g.equivalent === null);
  const showLosses =
    composer.surface.id === 'responses' || composer.surface.id === 'chat.completions';

  return (
    <div className="space-y-5">
      <Card title="Surface" subtitle={composer.surface.docs}>
        {/* Radix Tabs for the keyboard behaviour: arrow keys move between
            surfaces and the group carries one tab stop, where the old button
            row needed a Tab press per surface and announced no relationship
            between them. There is no TabsContent - selecting a surface changes
            what the composer BUILDS rather than revealing a panel. */}
        <Tabs value={composer.surface.id} onValueChange={composer.setSurfaceId}>
          <TabsList aria-label="Surface">
            {surfaces.map((s) => (
              <TabsTrigger
                key={s.id}
                value={s.id}
                data-family={s.family}
                title={s.docs}
                className={cn('text-xs', FAMILY_ACTIVE[s.family])}
              >
                {s.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Model">
            {/* An empty `value` is not a legal Radix item value — it is how the
                component spells "nothing selected" internally — so the
                no-models case becomes a placeholder on a disabled trigger
                rather than a selectable option nobody should pick. */}
            <Select
              value={composer.model === '' ? undefined : composer.model}
              onValueChange={composer.setModel}
              disabled={composer.models.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder="— no models for this key —" />
              </SelectTrigger>
              <SelectContent>
                {composer.models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {composer.modelsError !== null && (
              <span className="mt-1 block text-xs text-warn-foreground">
                {composer.modelsError}
              </span>
            )}
          </Field>

          <Field label="Prompt">
            <Textarea
              rows={2}
              value={composer.prompt}
              onChange={(e) => composer.setPrompt(e.target.value)}
            />
          </Field>
        </div>

        {extraControls !== undefined && <div className="mt-4">{extraControls}</div>}
      </Card>

      {showProbes && (
        <Card
          title="Probes"
          subtitle="Each one patches the body below to answer a specific question. ⚠ marks behaviour believed to be wrong today."
        >
          <div className="flex flex-wrap gap-1.5">
            {/* Buttons, not a toggle group: each one PATCHES the body below
                and nothing stays pressed. The amber variant marks a probe that
                exercises behaviour we believe is wrong today - the same amber
                the ledger uses for a landmine. */}
            {probes.map((probe) => (
              <Button
                key={probe.id}
                type="button"
                variant={probe.landmine ? 'warn' : 'outline'}
                size="sm"
                title={`${probe.why} (expected: ${probe.expectation})`}
                onClick={() => composer.applyProbe(probe)}
                disabled={!composer.parsed.ok}
                className="h-7 px-2 text-[11px] font-normal"
              >
                {probe.label}
              </Button>
            ))}
          </div>
          {composer.lastProbe !== null && (
            <p className="mt-3 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
              <span className="text-zinc-200">{composer.lastProbe.label}</span> —{' '}
              {composer.lastProbe.why}
              <span className="mt-1 block text-zinc-600">
                expected: {composer.lastProbe.expectation}
              </span>
            </p>
          )}
        </Card>
      )}

      <Card
        title="Request body"
        subtitle="Sent verbatim. Nothing here is validated or corrected — that is the point."
        right={
          <Button type="button" onClick={composer.reset} variant="outline" size="sm">
            reset
          </Button>
        }
      >
        <textarea
          className="mono h-64 w-full resize-y rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-200 outline-none focus:border-sky-700"
          spellCheck={false}
          value={composer.bodyText}
          onChange={(e) => composer.setBodyText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              onSubmit?.();
            }
          }}
        />
        {onSubmit !== undefined && (
          <p className="mt-1 text-right text-[10px] text-zinc-700">
            <span className="mono">Ctrl</span>/<span className="mono">⌘</span> +{' '}
            <span className="mono">Enter</span> to send
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {actions}
          {composer.parsed.ok ? (
            sendHint
          ) : (
            <span className="mono text-xs text-rose-400">JSON: {composer.parsed.error}</span>
          )}
        </div>

        {strayFields.length > 0 && (
          <div className="mt-3 rounded border border-amber-900/50 bg-amber-950/20 px-3 py-2">
            <p className="text-[11px] leading-relaxed text-amber-200/90">
              <strong>Not in this surface&rsquo;s contract:</strong>{' '}
              {strayFields.map((f) => (
                <code key={f} className="mono mr-1 rounded bg-amber-500/10 px-1 text-amber-300">
                  {f}
                </code>
              ))}
            </p>
            <p className="mt-1 text-[10px] leading-tight text-amber-200/60">
              Per LiteLLM v1.100.0. Sending anyway is allowed and often the point — whether the
              gateway refuses these or quietly ignores them is the finding. A silently ignored{' '}
              <code className="mono">max_tokens</code> on Responses caps nothing, so the whole
              answer is billed.
            </p>
          </div>
        )}

        {showLosses && silentLosses.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-[11px] text-zinc-500">
              {silentLosses.length} fields have no equivalent on{' '}
              <code className="mono">{composer.surface.id}</code>
            </summary>
            <ul className="mt-1.5 space-y-1">
              {silentLosses.map((g) => (
                <li key={g.field} className="text-[10px] leading-relaxed text-zinc-500">
                  <code className="mono text-zinc-400">{g.field}</code> — {g.consequence}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[10px] leading-tight text-zinc-600">
              These are the porting hazards: a request carrying one of them succeeds on this surface
              and behaves differently, with nothing raised.
            </p>
          </details>
        )}
      </Card>
    </div>
  );
}
