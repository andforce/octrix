import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const backendPort = parseInt(process.env.CLI_BRIDGE_PORT ?? '39800', 10);
const backendHttpTarget = `http://127.0.0.1:${backendPort}`;

function fixXtermUndeclaredVar(): Plugin {
  return {
    name: 'fix-xterm-undeclared-var',
    transform(code, id) {
      if (!id.includes('@xterm/xterm')) return null;
      if (!code.includes('for(Ue of')) return null;
      return code
        .replace('_verifyIntegers(...t){for(Ue of t)', '_verifyIntegers(...t){for(let Ue of t)')
        .replace('_verifyPositiveIntegers(...t){for(Ue of t)', '_verifyPositiveIntegers(...t){for(let Ue of t)');
    },
  };
}

export default defineConfig({
  build: {
    sourcemap: false,
    minify: 'terser',
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return;
          if (id.includes('/node_modules/@xterm/')) return 'vendor-xterm';
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/')) return 'vendor-react';
          return 'vendor';
        },
      },
    },
  },
  define: {
    __CLI_BRIDGE_PORT__: JSON.stringify(backendPort),
  },
  plugins: [fixXtermUndeclaredVar(), react()],
  server: {
    port: 5173,
    proxy: {
      '/v1': backendHttpTarget,
      '/api': backendHttpTarget,
    },
  },
  test: {
    environment: 'jsdom',
  },
});
