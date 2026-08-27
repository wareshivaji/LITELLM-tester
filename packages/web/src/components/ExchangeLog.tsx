import { Fragment, useState } from 'react';

import type { Exchange, ExchangeSummary } from '@tokenshield/client';

import { api } from '../api';
import { ExchangeDetail } from './ExchangeDetail';
import { Card, Empty, VerdictPill } from './ui';

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
        <Empty>No calls yet.</Empty>
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
                    <td className="mono px-3 py-2 text-zinc-500">{run.startedAt.slice(11, 23)}</td>
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
                          <ExchangeDetail exchange={detail} />
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
