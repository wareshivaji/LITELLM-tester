import { useState } from 'react';
import type { ReactNode } from 'react';

import { toCurl } from '@tokenshield/client';
import type { Exchange } from '@tokenshield/client';

import { unknownFieldsIn } from '@tokenshield/client';

import { Json } from './ui';

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

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
      {children}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</div>
      <div className="mono mt-0.5 text-zinc-200">{value}</div>
    </div>
  );
}

function HeaderTable({
  headers,
  highlight,
}: {
  headers: Record<string, string>;
  highlight: boolean;
}) {
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
                <td className={`px-3 py-1.5 break-all ${isSignal ? 'text-sky-200' : 'text-zinc-300'}`}>
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

function CurlButton({ exchange }: { exchange: Exchange }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          .writeText(toCurl(exchange))
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => setCopied(false));
      }}
      className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
      title="The credential is emitted as $TOKENSHIELD_KEY, never the real value"
    >
      {copied ? 'copied' : 'copy as curl'}
    </button>
  );
}

export function ExchangeDetail({ exchange }: { exchange: Exchange }) {
  const res = exchange.response;
  return (
    <div className="space-y-4 border-t border-zinc-800 bg-zinc-950/60 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="grid flex-1 grid-cols-2 gap-4 text-xs sm:grid-cols-4">
          <Stat label="Status" value={res !== undefined ? `${res.status} ${res.statusText}` : '—'} />
          <Stat label="TTFB" value={`${exchange.timings.ttfbMs} ms`} />
          <Stat label="Total" value={`${exchange.timings.totalMs} ms`} />
          <Stat label="Auth" value={exchange.authScheme} />
        </div>
        <CurlButton exchange={exchange} />
      </div>

      <div>
        <SectionLabel>
          Request — {exchange.request.method} {exchange.request.url}
        </SectionLabel>
        <HeaderTable headers={exchange.request.headers} highlight={false} />
        {/*
          What was sent that this surface's contract does not list. On a
          recorded exchange this is the durable answer to "did we send a field
          the endpoint never accepted" — which is the first question when a
          result looks wrong and nothing errored.
        */}
        {(() => {
          const stray = unknownFieldsIn(exchange.surface, exchange.request.body);
          return stray.length > 0 ? (
            <p className="mt-2 text-[11px] leading-relaxed text-amber-300/80">
              Sent {stray.length} field{stray.length === 1 ? '' : 's'} outside the{' '}
              <code className="mono">{exchange.surface}</code> contract:{' '}
              {stray.map((f) => (
                <code key={f} className="mono mr-1 rounded bg-amber-500/10 px-1">
                  {f}
                </code>
              ))}
            </p>
          ) : null;
        })()}
        {exchange.request.body !== undefined && (
          <div className="mt-2">
            <Json value={exchange.request.body} maxHeight={220} />
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
