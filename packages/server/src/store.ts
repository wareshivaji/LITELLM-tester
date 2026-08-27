/**
 * Run history — an in-memory ring buffer, and that is the whole storage layer.
 *
 * No Mongo, no ClickHouse, no SQLite, no Redis. Restart the backend and the
 * history is gone; that is intended. Anything worth keeping gets written to
 * `out/` by an explicit Export (Phase 7), never as a side effect of using the
 * console.
 */

import type { Exchange, ExchangeSummary } from '@tokenshield/client';

export function summarize(exchange: Exchange): ExchangeSummary {
  return {
    id: exchange.id,
    profileId: exchange.profileId,
    profileLabel: exchange.profileLabel,
    baseUrl: exchange.baseUrl,
    keyAlias: exchange.keyAlias,
    surface: exchange.surface,
    mode: exchange.mode,
    method: exchange.request.method,
    path: exchange.request.path,
    status: exchange.response?.status ?? null,
    verdictKind: exchange.verdict.kind,
    envelope: exchange.verdict.envelope,
    totalMs: exchange.timings.totalMs,
    startedAt: exchange.timings.startedAt,
  };
}

export class RunStore {
  private readonly buffer: Exchange[] = [];

  constructor(private readonly limit: number) {}

  add(exchange: Exchange): void {
    this.buffer.push(exchange);
    while (this.buffer.length > this.limit) this.buffer.shift();
  }

  addAll(exchanges: readonly Exchange[]): void {
    for (const exchange of exchanges) this.add(exchange);
  }

  /** Newest first — the order the UI reads them in. */
  list(limit?: number): ExchangeSummary[] {
    const slice = limit !== undefined ? this.buffer.slice(-limit) : [...this.buffer];
    return slice.reverse().map(summarize);
  }

  get(id: string): Exchange | undefined {
    return this.buffer.find((e) => e.id === id);
  }

  get size(): number {
    return this.buffer.length;
  }

  get capacity(): number {
    return this.limit;
  }

  clear(): void {
    this.buffer.length = 0;
  }
}
