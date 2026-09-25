import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig({
  base: process.env.BASE_URL || (process.env.NODE_ENV === 'production' ? '/isoweb/' : '/'),
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    headers: {
      // OPFS and SharedArrayBuffer require Cross-Origin-Opener-Policy & Cross-Origin-Embedder-Policy
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
