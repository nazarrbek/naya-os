import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'NAYA BALLOONS',
        short_name: 'NAYA',
        description: 'Заказы, склад и деньги NAYA BALLOONS',
        lang: 'ru',
        start_url: '/',
        display: 'standalone',
        background_color: '#fff7f9',
        theme_color: '#e8467c',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        // data always comes from the network; only the app shell is cached
        runtimeCaching: [],
      },
    }),
  ],
  server: { port: 5173 },
});
