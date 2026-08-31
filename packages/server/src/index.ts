/**
 * Lab server bootstrap.
 *
 * Bound to 127.0.0.1 on purpose: this console holds live gateway credentials
 * and has no authentication of its own. It is a local developer tool and must
 * never be exposed on a network interface.
 */

import Fastify from 'fastify';

import { loadConfig } from './config.js';
import { MockMcpServer, registerMockMcp } from './mockMcp.js';
import { TargetRegistry } from './registry.js';
import { registerRoutes } from './routes.js';
import { RunStore } from './store.js';

const HOST = '127.0.0.1';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new RunStore(config.historyLimit);
  const registry = new TargetRegistry(config);

  const app = Fastify({
    logger: {
      level: 'info',
      // One line per event. Anything a credential could ride in on is masked
      // before it reaches a log call, but keeping the format minimal means
      // there is less surface to get that wrong on.
      base: undefined,
    },
    bodyLimit: 8 * 1024 * 1024,
  });

  registerRoutes(app, { config, registry, store, startedAt: Date.now() });

  // The lab runs its own MCP server. Without it, every MCP test depended on
  // someone else providing a configured org, which made the feature the lab
  // exists to test the one feature it could not test. It is the instrument, not
  // the subject: it records exactly what reaches it.
  registerMockMcp(app, new MockMcpServer());

  try {
    await app.listen({ host: HOST, port: config.port });
  } catch (error) {
    // `tsx watch` runs the server in a child process, so killing the terminal
    // job can leave that child holding the port. It happens often enough in
    // normal development that a stack trace here is actively unhelpful — say
    // what happened and how to clear it.
    if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
      app.log.error(
        `Port ${config.port} is already in use — most likely an earlier lab server that outlived its terminal. ` +
          `Clear it with:  npx kill-port ${config.port}   (or see README → "Port already in use")`,
      );
    } else {
      app.log.error(error);
    }
    process.exit(1);
  }

  app.log.info(`TokenShield Lab server → http://${HOST}:${config.port}`);
  app.log.info(
    `config: ${config.envFileFound ? config.envFile : 'no .env.local (using defaults)'} · ` +
      `${config.profiles.length} profile(s) · ${config.keyRefs.length} credential(s) · ` +
      `history ${config.historyLimit} in memory, no database`,
  );
  for (const warning of config.warnings) app.log.warn(warning);

  const shutdown = (signal: string): void => {
    app.log.info(`${signal} received — shutting down (history is discarded, by design)`);
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
