/**
 * Target registry — the file-declared targets from `.env.local` plus whatever
 * was typed into the console this session, resolved through one lookup.
 *
 * Session entries exist so that pointing the lab at a different gateway, or
 * trying a different key, does not mean editing a file and restarting a
 * server. They are held in memory only: never written to `.env.local`, never
 * returned to the browser in raw form, and gone when the backend restarts.
 *
 * The one rule this enforces without exception: **an alias may never be
 * shadowed.** Adding a session key whose alias already exists is rejected, not
 * silently preferred. Silent credential precedence is exactly the failure that
 * made a whole test run authenticate as the wrong key in the Python suite, and
 * reintroducing it behind a friendlier form would be worse, not better.
 */

import { maskSecret } from '@tokenshield/client';
import type { KeyKind, LabKeyRef, LabProfile, Profile } from '@tokenshield/client';

import type { LabConfig } from './config.js';

export type AddResult<T> = { ok: true; value: T; warning?: string } | { ok: false; error: string };

interface SessionKey {
  alias: string;
  kind: KeyKind;
  secret: string;
}

const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_ALIAS = 64;
const MAX_LABEL = 60;
const MIN_SECRET = 12;
const KEY_KINDS: readonly KeyKind[] = ['api', 'management', 'admin'];

/** `Prod EU (staging)` → `prod-eu-staging`. */
function slug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export class TargetRegistry {
  private readonly sessionProfiles = new Map<string, Profile>();
  private readonly sessionKeys = new Map<string, SessionKey>();

  constructor(private readonly config: LabConfig) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  profiles(): LabProfile[] {
    return [
      ...this.config.profiles.map((p) => ({ ...p, source: 'file' as const })),
      ...[...this.sessionProfiles.values()].map((p) => ({ ...p, source: 'session' as const })),
    ];
  }

  keyRefs(): LabKeyRef[] {
    return [
      ...this.config.keyRefs.map((k) => ({ ...k, source: 'file' as const })),
      ...[...this.sessionKeys.values()].map((k) => ({
        alias: k.alias,
        kind: k.kind,
        masked: maskSecret(k.secret),
        source: 'session' as const,
      })),
    ];
  }

  profile(id: string): Profile | undefined {
    return this.config.profile(id) ?? this.sessionProfiles.get(id);
  }

  secretFor(alias: string): string | null {
    return this.config.secretFor(alias) ?? this.sessionKeys.get(alias)?.secret ?? null;
  }

  /** Which side an alias lives on, or undefined if it does not exist. */
  private aliasSource(alias: string): 'file' | 'session' | undefined {
    if (this.config.keyRef(alias) !== undefined) return 'file';
    if (this.sessionKeys.has(alias)) return 'session';
    return undefined;
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  addProfile(input: { label?: unknown; baseUrl?: unknown }): AddResult<LabProfile> {
    const label = asTrimmedString(input.label);
    const rawUrl = asTrimmedString(input.baseUrl);

    if (rawUrl.length === 0) return fail('Base URL is required.');
    if (label.length > MAX_LABEL) return fail(`Label must be ${MAX_LABEL} characters or fewer.`);

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return fail('Base URL must be a full URL, for example https://gateway.example.com');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return fail(`Unsupported scheme "${url.protocol.replace(':', '')}" — use http or https.`);
    }
    if (url.username.length > 0 || url.password.length > 0) {
      return fail('Do not put credentials in the URL. Add the key as a separate entry.');
    }
    if (url.search.length > 0 || url.hash.length > 0) {
      return fail('Base URL must not contain a query string or fragment.');
    }

    // Keep any path prefix (a gateway can sit behind /gateway on a proxy) but
    // drop the trailing slash so path joining stays predictable.
    const baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    const finalLabel = label.length > 0 ? label : url.host;
    const id = slug(finalLabel) || slug(url.host);

    if (id.length === 0) return fail('Could not derive an id from that label — try a simpler one.');
    if (this.profile(id) !== undefined) {
      const existing = this.config.profile(id) !== undefined ? '.env.local' : 'this session';
      return fail(`A gateway with id "${id}" already exists (from ${existing}). Use a different label.`);
    }

    const profile: Profile = { id, label: finalLabel, baseUrl };
    this.sessionProfiles.set(id, profile);
    return { ok: true, value: { ...profile, source: 'session' } };
  }

  addKey(input: { alias?: unknown; secret?: unknown; kind?: unknown }): AddResult<LabKeyRef> {
    const alias = asTrimmedString(input.alias);
    const secret = asTrimmedString(input.secret);
    const requestedKind = asTrimmedString(input.kind);

    if (alias.length === 0) return fail('Alias is required — it is how the key is labelled in the UI.');
    if (alias.length > MAX_ALIAS) return fail(`Alias must be ${MAX_ALIAS} characters or fewer.`);
    if (!ALIAS_PATTERN.test(alias)) {
      return fail('Alias may contain letters, numbers, hyphens and underscores, and must start with a letter or number.');
    }
    if (secret.length === 0) return fail('Key value is required.');
    if (secret.length < MIN_SECRET) return fail('That is too short to be a gateway key.');

    const existing = this.aliasSource(alias);
    if (existing !== undefined) {
      return fail(
        `An entry named "${alias}" already exists (from ${existing === 'file' ? '.env.local' : 'this session'}). ` +
          'Aliases are never shadowed — pick a different name or remove the existing one first.',
      );
    }

    const kind: KeyKind = (KEY_KINDS as readonly string[]).includes(requestedKind)
      ? (requestedKind as KeyKind)
      : 'api';

    this.sessionKeys.set(alias, { alias, kind, secret });

    const value: LabKeyRef = { alias, kind, masked: maskSecret(secret), source: 'session' };
    const expected = kind === 'api' ? 'cg-ak-' : kind === 'management' ? 'cg-mk-' : '';
    if (expected.length > 0 && !secret.startsWith(expected)) {
      return { ok: true, value, warning: `Added, but this does not start with "${expected}" — check the kind.` };
    }
    return { ok: true, value };
  }

  removeProfile(id: string): AddResult<null> {
    if (this.config.profile(id) !== undefined) {
      return fail('That gateway comes from .env.local — remove it there and restart.');
    }
    if (!this.sessionProfiles.delete(id)) return fail(`No session gateway with id "${id}".`);
    return { ok: true, value: null };
  }

  removeKey(alias: string): AddResult<null> {
    if (this.config.keyRef(alias) !== undefined) {
      return fail('That key comes from .env.local — remove it there and restart.');
    }
    if (!this.sessionKeys.delete(alias)) return fail(`No session key named "${alias}".`);
    return { ok: true, value: null };
  }

  get sessionCounts(): { profiles: number; keys: number } {
    return { profiles: this.sessionProfiles.size, keys: this.sessionKeys.size };
  }
}
