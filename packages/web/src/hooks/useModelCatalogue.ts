import { useCallback, useEffect, useState } from 'react';

import type { ModelInfo } from '@tokenshield/client';

import { api } from '../api';
import type { TargetRef } from '../api';

/**
 * The key's model catalogue, fetched once for the whole app.
 *
 * Previously each page fetched its own, which meant four `GET /v1/models` calls
 * on a page tour, a separate model selection per page that silently reset when
 * you navigated, and — under React's development double-invoke — two calls per
 * page instead of one. Lifting it means one fetch per target change and a
 * selection that survives moving between pages.
 */
export interface ModelCatalogue {
  models: ModelInfo[];
  error: string | null;
  loading: boolean;
  /** First chat-capable id, or '' — a reasonable default for a fresh picker. */
  defaultModel: string;
  /** First embedding-looking id, for the surfaces that need one. */
  defaultEmbedModel: string;
  reload: () => void;
}

function looksLikeEmbedding(id: string): boolean {
  return /embed/i.test(id);
}

export function useModelCatalogue(target: TargetRef): ModelCatalogue {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (target.keyAlias === null) {
      setModels([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .models(target)
      .then((res) => {
        if (cancelled) return;
        setModels(res.models);
        if (res.models.length === 0) {
          setError(`${res.verdict.kind}: ${res.verdict.detail}`);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setModels([]);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.profileId, target.keyAlias, target.scheme, nonce]);

  const chatModels = models.filter((m) => !looksLikeEmbedding(m.id));
  const embedModels = models.filter((m) => looksLikeEmbedding(m.id));

  return {
    models,
    error,
    loading,
    defaultModel: chatModels[0]?.id ?? models[0]?.id ?? '',
    defaultEmbedModel: embedModels[0]?.id ?? '',
    reload,
  };
}
