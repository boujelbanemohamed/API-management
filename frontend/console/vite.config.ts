import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// En développement, /api est relayé vers le back-end (même origine : pas de CORS).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: process.env.BACKEND_URL ?? 'http://localhost:3000', rewrite: (p) => p.replace(/^\/api/, '') } },
  },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], css: false },
});
