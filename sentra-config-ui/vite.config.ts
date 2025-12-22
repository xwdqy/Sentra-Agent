import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const clientPort = parseInt(env.CLIENT_PORT || '7244');
  const serverPort = parseInt(env.SERVER_PORT || '7245');

  return {
    plugins: [react()],
    server: {
      host: true,
      port: clientPort,
      proxy: {
        '/api': {
          target: `http://localhost:${serverPort}`,
          changeOrigin: true,
        },
        '/v1': {
          target: `http://localhost:${serverPort}`,
          changeOrigin: true,
          timeout: 0,
          proxyTimeout: 0,
        },
      },
    },
    preview: {
      host: true,
    },
    build: {
      outDir: 'dist',
      rollupOptions: {
        output: {
          manualChunks: {
            'monaco-editor': ['monaco-editor'],
            'react-vendor': ['react', 'react-dom', 'framer-motion'],
            'icons': ['react-icons']
          }
        }
      }
    },
  };
});
