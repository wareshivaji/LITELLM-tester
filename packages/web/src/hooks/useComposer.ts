import { useCallback, useEffect, useMemo, useState } from 'react';

import { SURFACES } from '@tokenshield/client';
import type { ModelInfo, Probe, SurfaceSpec } from '@tokenshield/client';

export type ParsedBody = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Shared state for "compose a request": which surface, which model, the prompt,
 * and the JSON body that is actually sent.
 *
 * The body editor is the source of truth. Changing the surface, model or prompt
 * regenerates it — but only until it has been hand-edited, after which the edit
 * wins. Silently overwriting someone's hand-built request is the fastest way to
 * make a tool untrustworthy.
 *
 * The model catalogue arrives as a prop rather than being fetched here: four
 * pages use this hook, and each fetching its own meant four `GET /v1/models`
 * calls on a page tour and a selection that reset whenever you navigated.
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
  /** The key's catalogue, owned by the app shell. */
  models: ModelInfo[];
  modelsError?: string | null;
  /**
   * Applied to the generated sample body — used by the Streaming page to fold
   * in `stream: true`. Memoise it, or the regeneration effect will loop.
   */
  transform?: (surface: SurfaceSpec, body: unknown) => unknown;
}

export function useComposer(options: UseComposerOptions): Composer {
  const { surfaces, initialSurfaceId, transform, models } = options;

  const [surfaceId, setSurfaceId] = useState(initialSurfaceId);
  const surface = useMemo(
    () => surfaces.find((s) => s.id === surfaceId) ?? surfaces[0] ?? SURFACES[0]!,
    [surfaces, surfaceId],
  );

  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState(options.initialPrompt ?? 'Reply with exactly: pong');
  const [bodyText, setBodyText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [lastProbe, setLastProbe] = useState<Probe | null>(null);

  // Keep the selection legal as the catalogue arrives or the key changes,
  // without discarding a still-valid choice.
  useEffect(() => {
    setModel((current) =>
      current.length > 0 && models.some((m) => m.id === current) ? current : (models[0]?.id ?? ''),
    );
  }, [models]);

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
    modelsError: options.modelsError ?? null,
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
