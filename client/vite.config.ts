import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Writes dist/sw-manifest.json at the end of a build.
 *
 * The service worker precaches the shell, but the routes are lazy chunks: the
 * reader opens /letters and /play's code shipped apart. A network error on a
 * lazy chunk used to mean a blank document on a train, so the install fetches
 * this manifest and takes every emitted asset. The file is generated, never
 * committed, and its absence only costs the offline window its completeness.
 */
function swManifest() {
  return {
    name: 'sw-manifest',
    apply: 'build' as const,
    closeBundle() {
      const dist = path.resolve(__dirname, 'dist');
      const dir = path.join(dist, 'assets');
      const assets = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.css')).map((f) => `/assets/${f}`)
        : [];
      fs.writeFileSync(path.join(dist, 'sw-manifest.json'), JSON.stringify(assets));
    },
  };
}

export default defineConfig({
  plugins: [react(), swManifest()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
