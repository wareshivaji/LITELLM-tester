import type { ReactNode } from 'react';

import { probesFor } from '@tokenshield/client';
import type { SurfaceSpec } from '@tokenshield/client';

import type { Composer } from '../hooks/useComposer';
import { Card, selectClass } from './ui';

const FAMILY_TONE: Record<string, string> = {
  openai: 'border-sky-800/60 text-sky-200 bg-sky-950/30',
  anthropic: 'border-violet-800/60 text-violet-200 bg-violet-950/30',
  utility: 'border-zinc-700 text-zinc-300 bg-zinc-900/60',
};

function SurfaceTab({
  spec,
  active,
  onClick,
}: {
  spec: SurfaceSpec;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-2.5 py-1 text-xs ${
        active
          ? FAMILY_TONE[spec.family]
          : 'border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
      }`}
    >
      {spec.label}
    </button>
  );
}

export function RequestComposer({
  composer,
  surfaces,
  showProbes = false,
  extraControls,
  actions,
  sendHint,
}: {
  composer: Composer;
  surfaces: readonly SurfaceSpec[];
  showProbes?: boolean;
  /** Surface-specific toggles, rendered beside the model and prompt. */
  extraControls?: ReactNode;
  /** The send / stop row. */
  actions: ReactNode;
  sendHint?: ReactNode;
}) {
  const probes = showProbes ? probesFor(composer.surface.id) : [];

  return (
    <div className="space-y-5">
      <Card title="Surface" subtitle={composer.surface.docs}>
        <div className="flex flex-wrap gap-1.5">
          {surfaces.map((s) => (
            <SurfaceTab
              key={s.id}
              spec={s}
              active={s.id === composer.surface.id}
              onClick={() => composer.setSurfaceId(s.id)}
            />
          ))}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-500">
              Model
            </span>
            <select
              className={selectClass}
              value={composer.model}
              onChange={(e) => composer.setModel(e.target.value)}
              disabled={composer.models.length === 0}
            >
              {composer.models.length === 0 && <option value="">— none loaded —</option>}
              {composer.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
            {composer.modelsError !== null && (
              <span className="mt-1 block text-xs text-amber-500">{composer.modelsError}</span>
            )}
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-500">
              Prompt
            </span>
            <textarea
              className={`${selectClass} min-h-[42px] resize-y`}
              rows={2}
              value={composer.prompt}
              onChange={(e) => composer.setPrompt(e.target.value)}
            />
          </label>
        </div>

        {extraControls !== undefined && <div className="mt-4">{extraControls}</div>}
      </Card>

      {showProbes && (
        <Card
          title="Probes"
          subtitle="Each one patches the body below to answer a specific question. ⚠ marks behaviour believed to be wrong today."
        >
          <div className="flex flex-wrap gap-1.5">
            {probes.map((probe) => (
              <button
                key={probe.id}
                type="button"
                title={`${probe.why} (expected: ${probe.expectation})`}
                onClick={() => composer.applyProbe(probe)}
                disabled={!composer.parsed.ok}
                className={`rounded-md border px-2 py-1 text-[11px] disabled:opacity-40 ${
                  probe.landmine
                    ? 'border-amber-800/70 text-amber-300 hover:bg-amber-950/30'
                    : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800/60'
                }`}
              >
                {probe.label}
              </button>
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
          <button
            type="button"
            onClick={composer.reset}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
          >
            reset
          </button>
        }
      >
        <textarea
          className="mono h-64 w-full resize-y rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-200 outline-none focus:border-sky-700"
          spellCheck={false}
          value={composer.bodyText}
          onChange={(e) => composer.setBodyText(e.target.value)}
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {actions}
          {composer.parsed.ok ? (
            sendHint
          ) : (
            <span className="mono text-xs text-rose-400">JSON: {composer.parsed.error}</span>
          )}
        </div>
      </Card>
    </div>
  );
}
