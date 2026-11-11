import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Three pages share one build: / (TV kiosk), /m/ (crew PWA), /sm/ (search console).
// Dev server proxies API + WebSocket + OwnTracks to the Fastify server on :8080.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', ws: true },
      '/ot': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      input: {
        tv: resolve(__dirname, 'index.html'),
        m: resolve(__dirname, 'm/index.html'),
        sm: resolve(__dirname, 'sm/index.html'),
      },
    },
    chunkSizeWarningLimit: 1500,
  },
  plugins: [
    VitePWA({
      // Only the crew app is installable; TV and console stay plain pages.
      registerType: 'autoUpdate',
      injectRegister: null,
      filename: 'm/sw.js',
      manifestFilename: 'm/manifest.webmanifest',
      scope: '/m/',
      manifest: {
        name: 'Howth Coast Guard',
        short_name: 'Howth CG',
        description: 'Crew app: callouts, weather, tide, sea state, search teams',
        start_url: '/m/',
        scope: '/m/',
        display: 'standalone',
        background_color: '#0b1016',
        theme_color: '#0b1016',
        orientation: 'portrait',
        icons: [
          { src: '/m/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/m/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/m/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // push alerts: the handler lives in a plain file next to the generated worker
        importScripts: ['/m/push-sw.js'],
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        globIgnores: ['index.html', 'sm/**'],
        navigateFallback: '/m/index.html',
        navigateFallbackAllowlist: [/^\/m(\/|$)/],
        runtimeCaching: [
          { urlPattern: /^https:\/\/tile\.openstreetmap\.org\//, handler: 'CacheFirst', options: { cacheName: 'osm-tiles', expiration: { maxEntries: 500, maxAgeSeconds: 7 * 86400 } } },
          { urlPattern: /^https:\/\/tiles\.openseamap\.org\//, handler: 'CacheFirst', options: { cacheName: 'seamark-tiles', expiration: { maxEntries: 300, maxAgeSeconds: 7 * 86400 } } },
          { urlPattern: /\/api\//, handler: 'NetworkOnly' },
          { urlPattern: /\/ot$/, handler: 'NetworkOnly' },
        ],
      },
    }),
  ],
});
