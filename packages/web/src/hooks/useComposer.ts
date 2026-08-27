import { useCallback, useEffect, useMemo, useState } from 'react';

import { SURFACES } from '@tokenshield/client';
import type { ModelInfo, Probe, SurfaceSpec } from '@tokenshield/client';

import { api } from '../api';
import type { TargetRef } from '../api';

export type ParsedBody = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Shared state for "compose a request": which surface, which model, the prompt,
 * and the JSON body that is actually sent.
 *
 * The body editor is the source of truth. Changing the surface, model or prompt
 * regenerates it — but only until it has been hand-edited, after which the edit
 * wins. Silently overwriting someone's hand-built request is the fastest way to
 * make a tool untrustworthy.
 */
export interface Composer {
  surface: SurfaceSpec;
  setSurfaceId: (id: string) => void;
  models: ModelInfo[];
  modelsError: string | null;
  model: string;
  setModel: (model: string) => void;
  prompt: string;
  setPrompt: (prompt: string) => void;
  bodyText: string;
  setBodyText: (text: string) => void;
  parsed: ParsedBody;
  dirty: boolean;
  reset: () => void;
  applyProbe: (probe: Probe) => void;
  lastProbe: Probe | null;
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export interface UseComposerOptions {
  surfaces: readonly SurfaceSpec[];
  initialSurfaceId: string;
  initialPrompt?: string;
  /**
   * Applied to the generated sample body — used by the Streaming page to fold
   * in `stream: true`. Memoise it, or the regeneration effect will loop.
   */
  transform?: (surface: SurfaceSpec, body: unknown) => unknown;
  /** Notified whenever a call was recorded, so the shared log can refresh. */
  onRecorded?: () => void;
}

export function useComposer(target: TargetRef, options: UseComposerOptions): Composer {
  const { surfaces, initialSurfaceId, transform, onRecorded } = options;

  const [surfaceId, setSurfaceId] = useState(initialSurfaceId);
  const surface = useMemo(
    () => surfaces.find((s) => s.id === surfaceId) ?? surfaces[0] ?? SURFACES[0]!,
    [surfaces, surfaceId],
  );

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState(options.initialPrompt ?? 'Reply with exactly: pong');
  const [bodyText, setBodyText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [lastProbe, setLastProbe] = useState<Probe | null>(null);

  // The key's own catalogue. Free — one GET /v1/models.
  useEffect(() => {
    if (target.keyAlias === null) {
      setModels([]);
      setModelsError('Select a key on the Connect page to load its model catalogue.');
      return;
    }
    let cancelled = false;
    setModelsError(null);
    api
      .models(target)
      .then((res) => {
        if (cancelled) return;
        setModels(res.models);
        if (res.models.length === 0) {
          setModelsError(`No models available — ${res.verdict.kind}: ${res.verdict.detail}`);
        }
        setModel((current) =>
          res.models.some((m) => m.id === current) ? current : (res.models[0]?.id ?? ''),
        );
        onRecorded?.();
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setModels([]);
        setModelsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.profileId, target.keyAlias, target.scheme]);

  const build = useCallback((): string => {
    const sample = surface.sample(model, prompt);
    return pretty(transform !== undefined ? transform(surface, sample) : sample);
  }, [surface, model, prompt, transform]);

  useEffect(() => {
    if (!dirty) setBodyText(build());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build]);

  const parsed = useMemo((): ParsedBody => {
    try {
      return { ok: true, value: JSON.parse(bodyText) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON' };
    }
  }, [bodyText]);

  const reset = useCallback(() => {
    setBodyText(build());
    setDirty(false);
    setLastProbe(null);
  }, [build]);

  const applyProbe = useCallback(
    (probe: Probe) => {
      if (!parsed.ok) return;
      setBodyText(pretty(probe.apply(parsed.value)));
      setDirty(true);
      setLastProbe(probe);
    },
    [parsed],
  );

  return {
    surface,
    setSurfaceId: (id: string) => {
      setSurfaceId(id);
      setDirty(false);
      setLastProbe(null);
    },
    models,
    modelsError,
    model,
    setModel,
    prompt,
    setPrompt,
    bodyText,
    setBodyText: (text: string) => {
      setBodyText(text);
      setDirty(true);
    },
    parsed,
    dirty,
    reset,
    applyProbe,
    lastProbe,
  };
}
