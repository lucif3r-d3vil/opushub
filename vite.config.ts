import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The built app is served by the OpusHub node server itself (same-origin /api) — that is the
// production shape. `vite dev` proxies to it for development; nothing is ever fetched cross-origin.
const API = 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // the app is also opened through the sandbox preview proxy, which sends its own Host header
    allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'],
    proxy: {
      '/api': API,
      '/user': API,
    },
  },
  build: { outDir: 'dist', target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 700 },
});
