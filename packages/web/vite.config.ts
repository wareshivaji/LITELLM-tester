import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The dev server proxies /api to the lab backend, so the browser has one
 * origin and no CORS of its own to think about. The backend port lives in
 * .env.local, so read it from there rather than duplicating the number.
 */
function labPort(): number {
  try {
    const contents = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf8');
    const match = /^\s*TSLAB_PORT\s*=\s*(\d+)\s*$/m.exec(contents);
    if (match?.[1] !== undefined) return Number.parseInt(match[1], 10);
  } catch {
    // No .env.local yet — the default below is also the server's default.
  }
  return 8787;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
