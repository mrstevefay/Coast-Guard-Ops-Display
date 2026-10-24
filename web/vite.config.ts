import { defineConfig } from 'vite';

// Dev server proxies API + WebSocket to the Fastify server on :8080.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', ws: true },
      '/healthz': 'http://localhost:8080',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022' },
});
