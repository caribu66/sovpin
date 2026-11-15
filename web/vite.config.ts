import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5174,
    // Allow the Tailscale Serve hostname (MagicDNS) through Vite's host check.
    allowedHosts: ['penguin.tail2cc975.ts.net', 'chromebook.tail2cc975.ts.net'],
    proxy: {
      '/v1': 'http://127.0.0.1:3001',
      '/api': 'http://127.0.0.1:3001',
      // /healthz is fetched directly by App.tsx and DashboardPage.tsx.
      // Without this, dev on :5174 serves index.html (200 HTML, no JSON)
      // and the UI falls back to all-down. Production serves web/dist
      // from Express so same-origin /healthz already hits the backend.
      '/healthz': 'http://127.0.0.1:3001',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
