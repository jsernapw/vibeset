import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiPort = Number(process.env.VIBESET_PORT ?? 4317);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/trpc': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
      '/ws': {
        target: `http://127.0.0.1:${apiPort}`,
        ws: true,
        changeOrigin: false,
      },
      '/healthz': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
