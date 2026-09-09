import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The dev server proxies /api to the lab backend, so the browser has one
 * origin and no CORS of its own to think about. The backend port lives in
 * .env.local, so read it from there rather than duplicating the number.
 *
 * Since Phase 8.1b the backend is the PYTHON engine. It moved to its own repo
 * on 2026-09-09 - it had been living inside the compat-TEST repo, which is not
 * where a backend belongs. Sibling tokenshield-lab-engine, started with:
 *
 *     python -m uvicorn engine.app:app --host 127.0.0.1 --port 8801
 *
 * The Node backend that used to answer on 8787 no longer exists. The default
 * below moved with it - a default pointing at a deleted process is worse than
 * no default, because the failure looks like the engine being down.
 */
function labPort(): number {
  try {
    const contents = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf8');
    const match = /^\s*TSLAB_PORT\s*=\s*(\d+)\s*$/m.exec(contents);
    if (match?.[1] !== undefined) return Number.parseInt(match[1], 10);
  } catch {
    // No .env.local yet — the default below is also the engine's default.
  }
  return 8801;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The other half of the `@/*` alias declared in tsconfig.json. TypeScript
  // resolves types through `paths`; the bundler needs its own mapping or the
  // build fails on imports that typecheck cleanly.
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${labPort()}`, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
