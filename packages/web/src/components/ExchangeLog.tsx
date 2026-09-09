import { Fragment, useState } from 'react';

import type { Exchange, ExchangeSummary } from '@tokenshield/client';

import { api } from '../api';
import { ExchangeDetail } from './ExchangeDetail';
import {
  Button,
  Card,
  Empty,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  VerdictLegend,
  VerdictPill,
} from './ui';

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
        <Button type="button" onClick={onRefresh} variant="outline" size="sm">
          Refresh
        </Button>
      }
    >
      <div className="mb-3">
        <VerdictLegend />
      </div>
      {runs.length === 0 ? (
        <Empty>No calls yet. Anything this lab sends lands here.</Empty>
      ) : (
        <div className="overflow-hidden rounded-md border border-zinc-800">
          <Table className="text-xs">
            <TableHeader className="bg-muted/50 text-[10px] text-muted-foreground">
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Surface</TableHead>
                <TableHead>Request</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Verdict</TableHead>
                <TableHead className="text-right">ms</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <Fragment key={run.id}>
                  {/* `data-state="selected"` is the hook TableRow already styles, so
                      the open row no longer carries a colour of its own. */}
                  <TableRow
                    onClick={() => void toggle(run.id)}
                    data-state={openId === run.id ? 'selected' : undefined}
                    className="cursor-pointer"
                  >
                    <TableCell className="mono text-muted-foreground">
                      {run.startedAt.slice(11, 23)}
                    </TableCell>
                    <TableCell className="text-foreground/80">{run.surface}</TableCell>
                    <TableCell className="mono text-muted-foreground">
                      {run.method} {run.path}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {run.profileLabel}
                      {run.keyAlias !== null && (
                        <span className="mono ml-1 text-zinc-600">· {run.keyAlias}</span>
                      )}
                    </TableCell>
                    <TableCell className="mono text-foreground/80">{run.status ?? '—'}</TableCell>
                    <TableCell>
                      <VerdictPill kind={run.verdictKind} />
                    </TableCell>
                    <TableCell className="mono text-right text-muted-foreground">
                      {run.totalMs}
                    </TableCell>
                  </TableRow>
                  {openId === run.id && (
                    <TableRow>
                      <TableCell colSpan={7} className="p-0">
                        {error !== null ? (
                          <div className="p-4 text-xs text-rose-400">{error}</div>
                        ) : detail === null ? (
                          <div className="p-4 text-xs text-zinc-500">Loading…</div>
                        ) : (
                          <ExchangeDetail exchange={detail} />
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}
