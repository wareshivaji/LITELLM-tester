/**
 * Configuration — deliberately one source, deliberately not the environment.
 *
 * Keys are read from `.env.local` in the repo root and NOWHERE else. The
 * ambient process environment is never consulted for a credential.
 *
 * That is not paranoia. In the Python suite a stale `TS_KEY` left over in a
 * PowerShell session silently outranked the key the runner thought it was
 * using, and every request authenticated as the wrong key — two hours of "it
 * works when I run it, 403 when you run it". Reading the file only, with a
 * `TSLAB_` prefix that collides with nothing else in this workspace, makes
 * that failure mode structurally impossible.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { maskSecret } from '@tokenshield/client';
import type { KeyKind, KeyRef, Profile } from '@tokenshield/client';

/** Repo root: this file sits at packages/server/{src,dist}/config.{ts,js}. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENV_FILE = resolve(REPO_ROOT, '.env.local');

const FALLBACK_PROFILES: Profile[] = [
  { id: 'local', label: 'Local gateway', baseUrl: 'http://localhost:4000' },
  { id: 'prod-us', label: 'Prod US', baseUrl: 'https://gateway.cloudgov.ai' },
  { id: 'prod-mumbai', label: 'Prod Mumbai', baseUrl: 'https://gateway-mumbai.cloudgov.ai' },
];

/** Minimal dotenv: `KEY=value`, `#` comments, optional surrounding quotes. */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) out[key] = value;
  }
  return out;
}

/** `TSLAB_PROFILE_PROD_US` → `prod-us`. */
function idFromVarName(name: string, prefix: string): string {
  return name.slice(prefix.length).toLowerCase().replace(/_/g, '-');
}

/** `TSLAB_KEY_GLM_TESTING` → `GLM_TESTING`, shown verbatim in the UI. */
function aliasFromVarName(name: string, prefix: string): string {
  return name.slice(prefix.length);
}

interface StoredKey {
  alias: string;
  kind: KeyKind;
  secret: string;
}

export interface LabConfig {
  port: number;
  historyLimit: number;
  timeoutMs: number;
  profiles: Profile[];
  defaultProfileId: string;
  defaultKeyAlias: string | null;
  /** Public view — masked, safe to hand the browser. */
  keyRefs: KeyRef[];
  /** Non-fatal setup problems the UI should show rather than hide. */
  warnings: string[];
  envFile: string;
  envFileFound: boolean;
  secretFor(alias: string): string | null;
  keyRef(alias: string): KeyRef | undefined;
  profile(id: string): Profile | undefined;
}

const KEY_PREFIXES: ReadonlyArray<{ prefix: string; kind: KeyKind; expects: string }> = [
  { prefix: 'TSLAB_KEY_', kind: 'api', expects: 'cg-ak-' },
  { prefix: 'TSLAB_MGMT_', kind: 'management', expects: 'cg-mk-' },
  { prefix: 'TSLAB_ADMIN_', kind: 'admin', expects: '' },
];

function intOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(): LabConfig {
  const warnings: string[] = [];
  let raw: Record<string, string> = {};
  let envFileFound = false;

  try {
    raw = parseEnvFile(readFileSync(ENV_FILE, 'utf8'));
    envFileFound = true;
  } catch {
    warnings.push(
      'No .env.local found. Copy .env.example to .env.local and add at least one TSLAB_KEY_<ALIAS> to run authenticated checks.',
    );
  }

  // Profiles
  const profiles: Profile[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!name.startsWith('TSLAB_PROFILE_')) continue;
    const [label, baseUrl] = value.split('|');
    if (baseUrl === undefined || baseUrl.trim().length === 0) {
      warnings.push(`${name} is malformed — expected "Label|https://host". Ignored.`);
      continue;
    }
    profiles.push({
      id: idFromVarName(name, 'TSLAB_PROFILE_'),
      label: (label ?? '').trim() || idFromVarName(name, 'TSLAB_PROFILE_'),
      baseUrl: baseUrl.trim().replace(/\/+$/, ''),
    });
  }
  if (profiles.length === 0) {
    profiles.push(...FALLBACK_PROFILES);
    if (envFileFound) warnings.push('No TSLAB_PROFILE_* entries found — using built-in defaults.');
  }

  // Credentials
  const keys = new Map<string, StoredKey>();
  for (const [name, value] of Object.entries(raw)) {
    const match = KEY_PREFIXES.find((p) => name.startsWith(p.prefix));
    if (match === undefined) continue;
    const alias = aliasFromVarName(name, match.prefix);
    const secret = value.trim();
    if (alias.length === 0 || secret.length === 0) continue;
    if (match.expects.length > 0 && !secret.startsWith(match.expects)) {
      warnings.push(`${name} does not start with "${match.expects}" — check you pasted the right key.`);
    }
    if (keys.has(alias)) {
      warnings.push(`Duplicate credential alias "${alias}" — the last one wins.`);
    }
    keys.set(alias, { alias, kind: match.kind, secret });
  }
  if (keys.size === 0 && envFileFound) {
    warnings.push('No TSLAB_KEY_* entries found — the auth and catalogue checks will be skipped.');
  }

  const keyRefs: KeyRef[] = [...keys.values()].map((k) => ({
    alias: k.alias,
    kind: k.kind,
    masked: maskSecret(k.secret),
  }));

  const requestedProfile = raw['TSLAB_DEFAULT_PROFILE'];
  const defaultProfileId =
    requestedProfile !== undefined && profiles.some((p) => p.id === requestedProfile)
      ? requestedProfile
      : (profiles[0]?.id ?? 'local');

  const requestedKey = raw['TSLAB_DEFAULT_KEY'];
  const apiKeyAliases = keyRefs.filter((k) => k.kind === 'api');
  const defaultKeyAlias =
    requestedKey !== undefined && keys.has(requestedKey)
      ? requestedKey
      : (apiKeyAliases[0]?.alias ?? null);

  return {
    // The ONE value read from the ambient environment, and deliberately not
    // a credential. During the Go migration the Node backend moves behind the
    // Go front door, and the dev script needs to say so without editing a
    // gitignored file. The rule at the top of this module is about KEYS — the
    // stale-TS_KEY story that cost two hours was a credential outranking the
    // one the runner thought it had. A port cannot authenticate as anything.
    //
    // Do not extend this to a second value without a reason at least this
    // specific.
    port: intOr(process.env['TSLAB_PORT'] ?? raw['TSLAB_PORT'], 8787),
    historyLimit: intOr(raw['TSLAB_HISTORY_LIMIT'], 200),
    timeoutMs: intOr(raw['TSLAB_TIMEOUT_MS'], 60_000),
    profiles,
    defaultProfileId,
    defaultKeyAlias,
    keyRefs,
    warnings,
    envFile: ENV_FILE,
    envFileFound,
    secretFor: (alias: string) => keys.get(alias)?.secret ?? null,
    keyRef: (alias: string) => keyRefs.find((k) => k.alias === alias),
    profile: (id: string) => profiles.find((p) => p.id === id),
  };
}
