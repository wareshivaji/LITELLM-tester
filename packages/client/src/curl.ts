/**
 * Reproduce an exchange outside the lab.
 *
 * The point of "copy as curl" is handing someone else a command that
 * demonstrates the behaviour — in a bug report, a Slack message, a ticket. So
 * the credential is emitted as `$TOKENSHIELD_KEY`, not as the masked value:
 * masked would look runnable and silently 401, and the real value must never
 * be pasted into a ticket.
 */

import { isSecretHeader } from './redact.js';
import type { Exchange } from './types.js';

const KEY_VAR = '$TOKENSHIELD_KEY';

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Substitutes an env-var reference for whatever credential the header carried. */
function headerValueForCurl(name: string, value: string): string {
  if (!isSecretHeader(name)) return value;
  if (/^Bearer\s/i.test(value)) return `Bearer ${KEY_VAR}`;
  return KEY_VAR;
}

export function toCurl(exchange: Exchange): string {
  const parts: string[] = [`curl -sS -X ${exchange.request.method} ${quote(exchange.request.url)}`];

  for (const [name, value] of Object.entries(exchange.request.headers)) {
    // curl sets its own; echoing them adds noise without adding fidelity.
    if (name.toLowerCase() === 'user-agent' || name.toLowerCase() === 'accept') continue;
    parts.push(`  -H ${quote(`${name}: ${headerValueForCurl(name, value)}`)}`);
  }

  if (exchange.request.body !== undefined) {
    parts.push(`  -d ${quote(JSON.stringify(exchange.request.body))}`);
  }

  const command = parts.join(' \\\n');
  const needsKey = Object.keys(exchange.request.headers).some((h) => isSecretHeader(h));
  return needsKey ? `# export TOKENSHIELD_KEY=cg-ak-…\n${command}` : command;
}
