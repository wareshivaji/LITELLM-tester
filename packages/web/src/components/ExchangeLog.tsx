import { Fragment, useState } from 'react';

import type { Exchange, ExchangeSummary } from '@tokenshield/client';

import { api } from '../api';
import { Card, Empty, Json, VerdictPill } from './ui';

/**
 * Headers worth pulling to the front. These are exactly the ones a browser
 * cannot read for itself — the gateway sets no CORS ExposeHeaders — which is
 * why every call goes through the lab backend.
 */
const SIGNAL_HEADERS = [
  'x-request-id',
  'x-organization-id',
  'retry-after',
  'x-should-retry',
  'x-tokenshield-guardrail-ms',
  'mcp-session-id',
  'x-budget-limit',
  'x-budget-spend',
  'x-budget-warning',
  'x-key-budget-limit',
  'x-key-budget-spend',
  'x-key-budget-warning',
  'x-user-budget-limit',
  'x-user-budget-spend',
  'x-user-budget-warning',
  'x-group-budget-limit',
  'x-group-budget-spend',
  'x-group-budget-warning',
];

function HeaderTable({ headers, highlight }: { headers: Record<string, string>; highlight: boolean }) {
  const entries = Object.entries(headers).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return <p className="text-xs text-zinc-600">none</p>;
  return (
    <div className="mono overflow-hidden rounded-md border border-zinc-800">
      <table className="w-full text-xs">
        <tbody>
          {entries.map(([name, value]) => {
            const isSignal = highlight && SIGNAL_HEADERS.includes(name.toLowerCase());
            return (
              <tr key={name} className="border-b border-zinc-800/60 last:border-0">
                <td
                  className={`w-64 px-3 py-1.5 align-top ${isSignal ? 'text-sky-300' : 'text-zinc-500'}`}
                >
                  {name}
                </td>
                <td
                  className={`px-3 py-1.5 break-all ${isSignal ? 'text-sky-200' : 'text-zinc-300'}`}
                >
                  {value}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Detail({ exchange }: { exchange: Exchange }) {
  const res = exchange.response;
  return (
    <div className="space-y-4 border-t border-zinc-800 bg-zinc-950/60 p-4">
      <div className="grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
        <Stat label="Status" value={res !== undefined ? `${res.status} ${res.statusText}` : '—'} />
        <Stat label="TTFB" value={`${exchange.timings.ttfbMs} ms`} />
        <Stat label="Total" value={`${exchange.timings.totalMs} ms`} />
        <Stat label="Auth" value={exchange.authScheme} />
      </div>

      <div>
        <SectionLabel>
          Request — {exchange.request.method} {exchange.request.url}
        </SectionLabel>
        <HeaderTable headers={exchange.request.headers} highlight={false} />
        {exchange.request.body !== undefined && (
          <div className="mt-2">
            <Json value={exchange.request.body} maxHeight={200} />
          </div>
        )}
      </div>

      <div>
        <SectionLabel>Response headers — gateway signal in blue</SectionLabel>
        <HeaderTable headers={res?.headers ?? {}} highlight />
      </div>

      {exchange.transportError !== undefined && (
        <div className="rounded-md border border-rose-900/60 bg-rose-950/30 p-3 text-xs text-rose-300">
          {exchange.transportError}
        </div>
      )}

      {res?.body !== undefined && (
        <div>
          <SectionLabel>Response body</SectionLabel>
          <Json value={res.body} />
        </div>
      )}
      {res?.body === undefined && res?.bodyText !== undefined && res.bodyText.length > 0 && (
        <div>
          <SectionLabel>Response body (not JSON)</SectionLabel>
          <pre className="mono max-h-64 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300">
            {res.bodyText}
          </pre>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</div>
      <div className="mono mt-0.5 text-zinc-200">{value}</div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
      {children}
    </div>
  );
}

export function ExchangeLog({
  runs,
  total,
  capacity,
  onRefresh,
}: {
  runs: ExchangeSummary[];
  total: number;
  capacity: number;
  onRefresh: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Exchange | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(id: string): Promise<void> {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetail(null);
    setError(null);
    try {
      setDetail(await api.exchange(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Card
      title="Exchange log"
      subtitle={`${total} of ${capacity} kept in memory · nothing is written to a database`}
      right={
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
        >
          Refresh
        </button>
      }
    >
      {runs.length === 0 ? (
        <Empty>No calls yet. Run a preflight to populate the log.</Empty>
      ) : (
        <div className="overflow-hidden rounded-md border border-zinc-800">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-900/80 text-[10px] uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Surface</th>
                <th className="px-3 py-2 font-medium">Request</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Verdict</th>
                <th className="px-3 py-2 text-right font-medium">ms</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <Fragment key={run.id}>
                  <tr
                    onClick={() => void toggle(run.id)}
                    className={`cursor-pointer border-t border-zinc-800/60 hover:bg-zinc-900/60 ${
                      openId === run.id ? 'bg-zinc-900/80' : ''
                    }`}
                  >
                    <td className="mono px-3 py-2 text-zinc-500">
                      {run.startedAt.slice(11, 23)}
                    </td>
                    <td className="px-3 py-2 text-zinc-300">{run.surface}</td>
                    <td className="mono px-3 py-2 text-zinc-400">
                      {run.method} {run.path}
                    </td>
                    <td className="px-3 py-2 text-zinc-500">
                      {run.profileLabel}
                      {run.keyAlias !== null && (
                        <span className="mono ml-1 text-zinc-600">· {run.keyAlias}</span>
                      )}
                    </td>
                    <td className="mono px-3 py-2 text-zinc-300">{run.status ?? '—'}</td>
                    <td className="px-3 py-2">
                      <VerdictPill kind={run.verdictKind} />
                    </td>
                    <td className="mono px-3 py-2 text-right text-zinc-400">{run.totalMs}</td>
                  </tr>
                  {openId === run.id && (
                    <tr>
                      <td colSpan={7} className="p-0">
                        {error !== null ? (
                          <div className="p-4 text-xs text-rose-400">{error}</div>
                        ) : detail === null ? (
                          <div className="p-4 text-xs text-zinc-500">Loading…</div>
                        ) : (
                          <Detail exchange={detail} />
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
