/**
 * Run a command with env vars set, portably.
 *
 * `FOO=bar npm run x` is POSIX shell syntax and fails on Windows cmd, and
 * `cross-env` is another dependency for four characters of behaviour. This is
 * the smallest thing that works on both.
 *
 *   node scripts/with-env.mjs TSLAB_PORT=8789 npm run dev -w @tokenshield/lab-web
 */
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const env = { ...process.env };

let i = 0;
for (; i < args.length; i += 1) {
  const eq = args[i].indexOf('=');
  // The first argument without an `=` is the command; everything before it is
  // an assignment. A command containing `=` would be misread, which no command
  // here does.
  if (eq <= 0) break;
  env[args[i].slice(0, eq)] = args[i].slice(eq + 1);
}

const [command, ...rest] = args.slice(i);
if (command === undefined) {
  console.error('with-env: nothing to run. Usage: with-env.mjs KEY=value <command> [args…]');
  process.exit(2);
}

// `shell: true` so `npm` resolves to npm.cmd on Windows without hard-coding it.
const child = spawn(command, rest, { stdio: 'inherit', env, shell: true });
child.on('exit', (code, signal) => {
  // Propagate the child's fate: a wrapper that always exits 0 turns a failing
  // dev server into a silent one.
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
