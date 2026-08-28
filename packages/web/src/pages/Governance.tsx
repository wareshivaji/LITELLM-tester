import { useState } from 'react';

import { GATES } from '@tokenshield/client';
import type { AuthScheme, Gate, LabKeyRef, VerdictKind } from '@tokenshield/client';

import { api } from '../api';
import type { BurstResult, MintResult, ProbeResult } from '../api';
import { Card, Empty, selectClass, StatusPill, verdictTone, VerdictPill } from '../components/ui';

interface GovernanceProps {
  profileId: string;
  keyAlias: string | null;
  scheme: AuthScheme;
  keys: LabKeyRef[];
  onTargetsChanged: () => void;
  onKey: (alias: string) => void;
  onRecorded: () => void;
}

export function Governance(props: GovernanceProps) {
  const target = { profileId: props.profileId, keyAlias: props.keyAlias, scheme: props.scheme };
  const managementKeys = props.keys.filter((k) => k.kind === 'management');

  return (
    <div className="space-y-5">
      <MintCard
        target={target}
        managementKeys={managementKeys}
        onMinted={(alias) => {
          props.onTargetsChanged();
          props.onKey(alias);
        }}
        onRecorded={props.onRecorded}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        {GATES.map((gate) => (
          <GateCard
            key={gate.id}
            gate={gate}
            target={target}
            hasKey={props.keyAlias !== null}
            onRecorded={props.onRecorded}
          />
        ))}
      </div>
    </div>
  );
}

// ── Minting ──────────────────────────────────────────────────────────────────

function MintCard({
  target,
  managementKeys,
  onMinted,
  onRecorded,
}: {
  target: { profileId: string; keyAlias: string | null; scheme: AuthScheme };
  managementKeys: LabKeyRef[];
  onMinted: (alias: string) => void;
  onRecorded: () => void;
}) {
  const [mgmt, setMgmt] = useState(managementKeys[0]?.alias ?? '');
  const [name, setName] = useState('sdk-lab-budget-probe');
  const [budget, setBudget] = useState('0.02');
  const [expires, setExpires] = useState('1');
  const [allowed, setAllowed] = useState('');
  const [ipList, setIpList] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MintResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function mint(): void {
    setBusy(true);
    setError(null);
    setResult(null);
    const request: Record<string, unknown> = { name: name.trim() };
    const budgetNum = Number.parseFloat(budget);
    if (Number.isFinite(budgetNum) && budgetNum > 0) {
      request['budget_limit_usd'] = budgetNum;
      request['budget_period'] = 'daily';
    }
    const expiresNum = Number.parseInt(expires, 10);
    if (Number.isFinite(expiresNum) && expiresNum > 0) request['expires_in_days'] = expiresNum;
    const models = allowed
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
    if (models.length > 0) request['allowed_models'] = models;
    const ips = ipList
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
    if (ips.length > 0) request['ip_allow_list'] = ips;

    api
      .mintKey({ ...target, managementAlias: mgmt, request })
      .then((res) => {
        setResult(res);
        if (res.ok && res.key !== undefined) onMinted(res.key.alias);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setBusy(false);
        onRecorded();
      });
  }

  return (
    <Card
      title="Mint a disposable key"
      subtitle="Several gates cannot be tested on a shared production key. A two-cent cap and a one-day expiry can."
      right={
        managementKeys.length === 0 ? (
          <StatusPill status="warn" label="needs a cg-mk- key" />
        ) : undefined
      }
    >
      {managementKeys.length === 0 ? (
        <div className="rounded-md border border-amber-900/60 bg-amber-950/20 p-3 text-sm text-amber-200/90">
          <p>
            No management key is configured. Add one as{' '}
            <span className="mono">TSLAB_MGMT_&lt;ALIAS&gt;=cg-mk-…</span> in{' '}
            <span className="mono">.env.local</span>, or add it from the Connect page with kind{' '}
            <em>management key</em>.
          </p>
          <p className="mt-2 text-amber-200/60">
            Without one, the budget-cap and IP-allowlist gates below stay untestable.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Management key">
              <select className={selectClass} value={mgmt} onChange={(e) => setMgmt(e.target.value)}>
                {managementKeys.map((k) => (
                  <option key={k.alias} value={k.alias}>
                    {k.alias}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name">
              <input className={selectClass} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Budget USD (daily)" hint="the cap you intend to blow through">
              <input
                className={`mono ${selectClass}`}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </Field>
            <Field label="Expires in days">
              <input
                className={`mono ${selectClass}`}
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
            </Field>
            <Field label="allowed_models" hint="comma separated; blank = whatever the org allows">
              <input
                className={`mono ${selectClass}`}
                placeholder="bedrock-nova-micro"
                value={allowed}
                onChange={(e) => setAllowed(e.target.value)}
              />
            </Field>
            <Field label="ip_allow_list" hint="to test the gate, use an address this machine has not got">
              <input
                className={`mono ${selectClass}`}
                placeholder="203.0.113.0/24"
                value={ipList}
                onChange={(e) => setIpList(e.target.value)}
              />
            </Field>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={mint}
              disabled={busy || name.trim().length === 0}
              className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {busy ? 'Minting…' : 'Mint key'}
            </button>
            <span className="text-xs text-zinc-600">
              the new key is registered as a session credential and selected — its raw value never
              reaches this page
            </span>
          </div>
        </>
      )}

      {error !== null && (
        <p className="mt-3 rounded-md border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
          {error}
        </p>
      )}
      {result !== null && !result.ok && (
        <p className="mt-3 rounded-md border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
          {result.verdict?.kind}: {result.verdict?.detail}
        </p>
      )}
      {result?.ok === true && result.key !== undefined && (
        <p className="mt-3 rounded-md border border-emerald-900/60 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-200">
          Minted <span className="mono">{result.key.alias}</span>{' '}
          <span className="mono text-emerald-300/70">{result.key.masked}</span> and selected it as
          the active key.
        </p>
      )}
    </Card>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      {children}
      {hint !== undefined && <span className="mt-1 block text-[11px] text-zinc-600">{hint}</span>}
    </label>
  );
}

// ── Gates ────────────────────────────────────────────────────────────────────

type GateOutcome =
  | { kind: 'burst'; data: BurstResult }
  | { kind: 'probe'; data: ProbeResult }
  | { kind: 'note'; text: string };

function GateCard({
  gate,
  target,
  hasKey,
  onRecorded,
}: {
  gate: Gate;
  target: { profileId: string; keyAlias: string | null; scheme: AuthScheme };
  hasKey: boolean;
  onRecorded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<GateOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runnable = gate.id === 'rate-limit' || gate.id === 'allowed-models' || gate.id === 'provider-binding';

  function trip(): void {
    setBusy(true);
    setError(null);
    setOutcome(null);
    const done = (): void => {
      setBusy(false);
      onRecorded();
    };

    if (gate.id === 'rate-limit') {
      api
        .burst({ ...target, count: 80 })
        .then((data) => setOutcome({ kind: 'burst', data }))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(done);
      return;
    }

    // allowedModels and provider-binding are the same probe read two ways: the
    // gateway distinguishes "not allowed for this key" from "no credential for
    // that provider", and which one comes back depends on how the org is set up.
    api
      .probeModels({ ...target })
      .then((data) => setOutcome({ kind: 'probe', data }))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(done);
  }

  return (
    <Card
      title={gate.label}
      subtitle={gate.what}
      right={
        gate.spends ? (
          <StatusPill status="warn" label="spends" />
        ) : (
          <StatusPill status="pass" label="free" />
        )
      }
    >
      <p className="text-xs text-zinc-400">{gate.how}</p>
      <p className="mt-2 text-[11px] text-zinc-600">
        expects verdict <span className="mono text-zinc-400">{gate.expects}</span>
      </p>

      {gate.caution !== undefined && (
        <p className="mt-2 rounded-md border border-amber-900/50 bg-amber-950/15 px-2.5 py-1.5 text-[11px] text-amber-200/90">
          {gate.caution}
        </p>
      )}
      {gate.requires !== undefined && (
        <p className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-1.5 text-[11px] text-zinc-400">
          <span className="text-zinc-500">needs: </span>
          {gate.requires}
        </p>
      )}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={trip}
          disabled={busy || !runnable || !hasKey}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Running…' : 'Trip it'}
        </button>
        {!runnable && (
          <span className="text-[11px] text-zinc-600">
            drive this one from the Playground with the key it needs
          </span>
        )}
        {!hasKey && <span className="text-[11px] text-zinc-600">select a key first</span>}
      </div>

      {error !== null && <p className="mt-3 text-xs text-rose-400">{error}</p>}
      {outcome?.kind === 'burst' && <BurstReport gate={gate} data={outcome.data} />}
      {outcome?.kind === 'probe' && <ProbeReport gate={gate} data={outcome.data} />}
    </Card>
  );
}

function BurstReport({ gate, data }: { gate: Gate; data: BurstResult }) {
  const fired = data.firstRejectedAt !== null;
  const matched = data.verdict?.kind === gate.expects;
  if (data.abandoned !== null) {
    return (
      <div className="mt-3 space-y-2">
        <StatusPill status="warn" label="inconclusive" />
        <p className="text-[11px] text-amber-300/90">{data.abandoned}</p>
      </div>
    );
  }
  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill
          status={fired ? (matched ? 'pass' : 'warn') : 'warn'}
          label={fired ? (matched ? 'gate fired, correctly named' : 'gate fired') : 'never fired'}
        />
        {data.verdict !== null && <VerdictPill kind={data.verdict.kind} />}
      </div>
      <div className="mono text-[11px] text-zinc-400">
        {fired
          ? `refused at request #${data.firstRejectedAt} of ${data.attempted}, ${data.elapsedMs} ms in`
          : `${data.attempted} requests in ${data.elapsedMs} ms, never refused`}
        {data.retryAfterSeconds !== null && ` · retry-after ${data.retryAfterSeconds}s`}
      </div>
      {data.verdict !== null && (
        <p className="text-[11px] text-zinc-500">{data.verdict.detail}</p>
      )}
      {!fired && (
        <p className="text-[11px] text-zinc-600">
          Either the limit is above {data.attempted} for this key, or the window rolled mid-burst.
        </p>
      )}
    </div>
  );
}

function ProbeReport({ gate, data }: { gate: Gate; data: ProbeResult }) {
  const hit = data.results.filter((r) => r.verdict === gate.expects);
  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill
          status={hit.length > 0 ? 'pass' : 'warn'}
          label={hit.length > 0 ? `${hit.length} model(s) hit this gate` : 'gate not reached'}
        />
      </div>
      <div className="overflow-hidden rounded-md border border-zinc-800">
        <table className="w-full text-left text-[11px]">
          <tbody>
            {data.results.map((r) => (
              <tr key={r.model} className="border-b border-zinc-800/60 last:border-0">
                <td className="mono px-2 py-1 text-zinc-300">{r.model}</td>
                <td className="mono px-2 py-1 text-zinc-500">{r.status ?? '—'}</td>
                <td className="px-2 py-1">
                  <span
                    className={
                      r.verdict === gate.expects
                        ? 'text-emerald-300'
                        : verdictTone(r.verdict as VerdictKind) === 'pass'
                          ? 'text-zinc-400'
                          : 'text-zinc-500'
                    }
                  >
                    {r.verdict}
                  </span>
                </td>
                <td className="px-2 py-1 text-zinc-600">{r.detail.slice(0, 70)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-zinc-600">
        404 means the gateway does not route that model at all. {gate.expects} means it does, and
        this key may not use it — only that exercises the gate.
      </p>
      {data.results.length === 0 && <Empty>No models probed.</Empty>}
    </div>
  );
}
