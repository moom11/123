import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Safari on iPad is the primary POS target, so the manifest and icons
      // are declared explicitly rather than relying on browser guesses.
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'MARA Lounge',
        short_name: 'MARA',
        description: 'نظام إدارة مارا لاونج',
        lang: 'ar',
        dir: 'rtl',
        theme_color: '#0f1115',
        background_color: '#0f1115',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The shell is cached so the till survives a brief network blip, but
        // API responses are never served stale: money and stock must be live.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            urlPattern: /\/api\/.*/,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
  // `vite preview` serves the production build; it needs the same proxy so the
  // built bundle can be exercised against a real API before deployment.
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
  build: { target: 'es2020', sourcemap: false },
});
