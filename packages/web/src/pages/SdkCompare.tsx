import { Fragment, useEffect, useMemo, useState } from 'react';

import { cn } from '../lib/utils';

import { readOutput, sdkModesFor, SURFACES } from '@tokenshield/client';
import type { AuthScheme, Exchange, SdkMode, SdkOutcome } from '@tokenshield/client';

import { api } from '../api';
import { ExchangeDetail } from '../components/ExchangeDetail';
import { RequestComposer } from '../components/RequestComposer';
import {
  Button,
  Card,
  Empty,
  Json,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ToggleGroup,
  ToggleGroupItem,
  VerdictPill,
} from '../components/ui';
import { useComposer } from '../hooks/useComposer';
import type { ModelCatalogue } from '../hooks/useModelCatalogue';

const MODE_LABEL: Record<SdkMode, string> = {
  raw: 'raw HTTP',
  'openai-sdk': 'openai',
  'anthropic-sdk': '@anthropic-ai/sdk',
};

const MODE_BLURB: Record<SdkMode, string> = {
  raw: 'Hand-built request. Sends exactly what the body says.',
  'openai-sdk': 'The stock openai package, unmodified.',
  'anthropic-sdk': 'The stock @anthropic-ai/sdk package, unmodified.',
};

interface SdkCompareProps {
  profileId: string;
  keyAlias: string | null;
  scheme: AuthScheme;
  onRecorded: () => void;
  catalogue: ModelCatalogue;
}

export function SdkCompare(props: SdkCompareProps) {
  const target = { profileId: props.profileId, keyAlias: props.keyAlias, scheme: props.scheme };
  const composer = useComposer({
    surfaces: SURFACES,
    initialSurfaceId: 'chat.completions',
    models: props.catalogue.models,
    modelsError: props.catalogue.error,
  });

  const available = useMemo(() => sdkModesFor(composer.surface.id), [composer.surface.id]);
  const [selected, setSelected] = useState<SdkMode[]>(['raw', 'openai-sdk']);
  const [maxRetries, setMaxRetries] = useState(0);
  const [running, setRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<SdkOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keep the selection legal when the surface changes. The Anthropic SDK now
  // has NO legal surface at all — /v1/messages left the tested scope — so this
  // guard resolves it away rather than offering a mode that cannot run.
  // Previously the reason was that the SDK had no method for /v1/embeddings, and
  // offering it would produce a confusing
  // client-side error rather than a gateway finding.
  useEffect(() => {
    setSelected((current) => {
      const legal = current.filter((m) => available.includes(m));
      return legal.length > 0 ? legal : available.slice(0, 2);
    });
  }, [available]);

  function run(): void {
    if (!composer.parsed.ok || selected.length === 0) return;
    setRunning(true);
    setError(null);
    setOutcomes(null);
    api
      .compare({
        ...target,
        surfaceId: composer.surface.id,
        body: composer.parsed.value,
        modes: selected,
        maxRetries,
      })
      .then((res) => setOutcomes(res.outcomes))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setRunning(false);
        props.onRecorded();
      });
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-2">
        <RequestComposer
          composer={composer}
          surfaces={SURFACES}
          showProbes
          extraControls={
            <div className="space-y-3">
              <div>
                <Label className="mb-1.5">Clients</Label>
                {/* Multi-select, and that is the feature: running `raw` and
                    `openai-sdk` against the SAME request is how the two get
                    diffed. A single-select control would make the comparison
                    impossible to express.

                    `unavailable` is a distinct look rather than just "not
                    selected". A client with no method for the current surface
                    used to differ from an unselected one only in shade, so
                    "can't" and "didn't" were the same picture. */}
                <ToggleGroup
                  type="multiple"
                  value={selected}
                  onValueChange={(v) => setSelected(v as SdkMode[])}
                  aria-label="Clients"
                >
                  {(['raw', 'openai-sdk', 'anthropic-sdk'] as const).map((mode) => {
                    const usable = available.includes(mode);
                    return (
                      <ToggleGroupItem
                        key={mode}
                        value={mode}
                        disabled={!usable}
                        unavailable={!usable}
                        title={
                          usable
                            ? MODE_BLURB[mode]
                            : `No method on this SDK for ${composer.surface.label}`
                        }
                      >
                        {MODE_LABEL[mode]}
                      </ToggleGroupItem>
                    );
                  })}
                </ToggleGroup>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <Label>SDK maxRetries</Label>
                <Select value={String(maxRetries)} onValueChange={(v) => setMaxRetries(Number(v))}>
                  <SelectTrigger size="sm" className="mono w-16">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[0, 1, 2, 3].map((r) => (
                      <SelectItem key={r} value={String(r)} className="mono">
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-muted-foreground">
                  raise it to watch an SDK retry a 429 or 5xx on its own schedule
                </span>
              </div>
            </div>
          }
          actions={
            <Button
              type="button"
              onClick={run}
              disabled={running || !composer.parsed.ok || selected.length === 0}
            >
              {running ? 'Running…' : `Send via ${selected.length} client(s)`}
            </Button>
          }
          onSubmit={run}
          sendHint={
            <span className="text-xs text-amber-500/80">
              one call per client, run in sequence · real tokens
            </span>
          }
        />

        <Card
          title="Verdict comparison"
          subtitle="Same body, different clients. Divergence is the finding."
        >
          {error !== null && (
            <p className="rounded-md border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
              {error}
            </p>
          )}
          {outcomes === null ? (
            <Empty>
              Send the same request through raw HTTP and a vendor SDK to see where they disagree.
            </Empty>
          ) : (
            <Divergence outcomes={outcomes} />
          )}
        </Card>
      </div>

      {outcomes !== null && (
        <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
          {outcomes.map((outcome) => (
            <OutcomeCard key={outcome.mode} outcome={outcome} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The one-glance answer: did the clients agree? */
function Divergence({ outcomes }: { outcomes: SdkOutcome[] }) {
  const rows = outcomes.map((o) => {
    const last = o.attempts[o.attempts.length - 1];
    return {
      mode: o.mode,
      ok: o.ok,
      status: last?.response?.status ?? null,
      verdict: last?.verdict.kind ?? 'unknown',
      envelope: last?.verdict.envelope ?? 'none',
      attempts: o.attempts.length,
      reported: o.ok
        ? (readOutput(last?.surface ?? '', last?.response?.body).text ?? '(no text)')
        : `${o.failure?.name ?? 'Error'}: ${o.failure?.message ?? ''}`,
      totalMs: o.attempts.reduce((sum, a) => sum + a.timings.totalMs, 0),
    };
  });

  const statuses = new Set(rows.map((r) => String(r.status)));
  const oks = new Set(rows.map((r) => r.ok));
  const agree = statuses.size === 1 && oks.size === 1;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <StatusPill
          status={agree ? 'pass' : 'warn'}
          label={agree ? 'clients agree' : 'clients disagree'}
        />
        {!agree && (
          <span className="text-xs text-amber-400/80">
            the same request got different answers depending on who sent it
          </span>
        )}
      </div>
      <div className="overflow-hidden rounded-md border border-zinc-800">
        <Table className="text-xs">
          <TableHeader className="bg-muted/50 text-[10px] text-muted-foreground">
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead>HTTP</TableHead>
              <TableHead>Verdict</TableHead>
              <TableHead>Envelope</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead className="text-right">ms</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <Fragment key={r.mode}>
                <TableRow className="border-border">
                  <TableCell className="mono text-foreground">{MODE_LABEL[r.mode]}</TableCell>
                  <TableCell className="mono text-foreground/80">{r.status ?? '—'}</TableCell>
                  <TableCell>
                    <VerdictPill kind={r.verdict} />
                  </TableCell>
                  <TableCell className="mono text-muted-foreground">{r.envelope}</TableCell>
                  <TableCell
                    className={cn(
                      'mono',
                      r.attempts > 1 ? 'text-warn-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {r.attempts}
                  </TableCell>
                  <TableCell className="mono text-right text-muted-foreground">
                    {Math.round(r.totalMs)}
                  </TableCell>
                </TableRow>
                <TableRow className="border-zinc-900">
                  <TableCell colSpan={6} className="pb-2 text-[11px] text-muted-foreground">
                    <span className="text-zinc-600">what the client reported: </span>
                    <span className={r.ok ? 'text-zinc-300' : 'text-rose-300'}>
                      {r.reported.slice(0, 220)}
                    </span>
                  </TableCell>
                </TableRow>
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function OutcomeCard({ outcome }: { outcome: SdkOutcome }) {
  const [openAttempt, setOpenAttempt] = useState<Exchange | null>(null);

  return (
    <Card
      title={MODE_LABEL[outcome.mode]}
      subtitle={MODE_BLURB[outcome.mode]}
      right={
        <StatusPill status={outcome.ok ? 'pass' : 'fail'} label={outcome.ok ? 'ok' : 'threw'} />
      }
    >
      <div className="space-y-3">
        {outcome.failure !== undefined && (
          <div className="rounded-md border border-rose-900/60 bg-rose-950/20 p-3">
            <div className="text-[10px] uppercase tracking-wider text-rose-400/70">
              What a developer&rsquo;s catch block receives
            </div>
            <div className="mono mt-1 text-sm text-rose-200">{outcome.failure.name}</div>
            <div className="mt-1 text-xs text-rose-300/90">{outcome.failure.message}</div>
            <div className="mono mt-2 flex flex-wrap gap-2 text-[10px] text-rose-400/70">
              <span>status: {outcome.failure.status ?? '—'}</span>
              <span>type: {outcome.failure.type ?? '—'}</span>
              <span>code: {outcome.failure.code ?? '—'}</span>
              <span className={outcome.failure.typed ? '' : 'text-amber-400'}>
                {outcome.failure.typed
                  ? 'typed API error'
                  : 'untyped — the SDK could not classify it'}
              </span>
            </div>
          </div>
        )}

        {outcome.sdkHeaders.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-600">
              Headers this SDK added
            </div>
            <div className="mono flex flex-wrap gap-1 text-[10px]">
              {outcome.sdkHeaders.map((h) => (
                <span key={h} className="rounded bg-zinc-900 px-1.5 py-0.5 text-zinc-400">
                  {h}
                </span>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-600">
            HTTP attempts ({outcome.attempts.length})
          </div>
          <div className="space-y-1">
            {outcome.attempts.map((a, i) => (
              <Button
                key={a.id}
                type="button"
                variant="outline"
                onClick={() => setOpenAttempt(openAttempt?.id === a.id ? null : a)}
                aria-expanded={openAttempt?.id === a.id}
                className="mono h-auto w-full justify-start gap-2 px-2 py-1 text-left text-[11px] font-normal text-muted-foreground"
              >
                <span className="text-zinc-600">#{i + 1}</span>
                <span className="text-zinc-300">{a.response?.status ?? '—'}</span>
                <span>{a.verdict.kind}</span>
                <span className="ml-auto text-muted-foreground">{a.timings.totalMs} ms</span>
              </Button>
            ))}
          </div>
        </div>

        {openAttempt !== null && (
          <div className="-mx-4 -mb-4">
            <ExchangeDetail exchange={openAttempt} />
          </div>
        )}

        {outcome.ok && outcome.result !== undefined && (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-600">
              What the client parsed
            </div>
            <Json value={outcome.result} maxHeight={180} />
          </div>
        )}
      </div>
    </Card>
  );
}
