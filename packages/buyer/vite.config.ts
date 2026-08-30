import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'MARA Buyer',
        short_name: 'MARA Buyer',
        description: 'تطبيق مندوب المشتريات',
        lang: 'ar',
        dir: 'rtl',
        theme_color: '#0f1115',
        background_color: '#0f1115',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/],
        // The rep works in warehouses and car parks. The shell is cached so the
        // app always opens; approved requests are cached separately in
        // IndexedDB by the sync layer, which owns freshness and conflicts.
        runtimeCaching: [{ urlPattern: /\/api\/.*/, handler: 'NetworkOnly' }],
      },
    }),
  ],
  server: {
    port: 5174,
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
  preview: {
    port: 4174,
    // A Cloudflare quick tunnel (scripts/dev-up.sh --share) reaches this server
    // under a *.trycloudflare.com host, which Vite would otherwise refuse.
    allowedHosts: ['.trycloudflare.com', 'localhost', '127.0.0.1'],
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
  build: { target: 'es2020', outDir: 'dist' },
});
