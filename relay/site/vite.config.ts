import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://127.0.0.1:8790',
      '/auth': 'http://127.0.0.1:8790',
      '/healthz': 'http://127.0.0.1:8790',
      '/readyz': 'http://127.0.0.1:8790',
    },
  },
});
