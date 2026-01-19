import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const clientPort = parseInt(env.CLIENT_PORT || '7244');
  const serverPort = parseInt(env.SERVER_PORT || '7245');

  const sentraFontsPlugin = () => {
    const virtualId = 'virtual:sentra-fonts';
    const resolvedVirtualId = '\0' + virtualId;

    return {
      name: 'sentra-fonts',
      resolveId(id: string) {
        if (id === virtualId) return resolvedVirtualId;
        return null;
      },
      load(id: string) {
        if (id !== resolvedVirtualId) return null;

        const fontsDir = path.resolve(process.cwd(), 'public', 'fonts');
        let files: string[] = [];
        try {
          files = fs
            .readdirSync(fontsDir)
            .filter((f) => /\.(ttf|otf|woff2?|ttc)$/i.test(f))
            .sort((a, b) => a.localeCompare(b));
        } catch {
          files = [];
        }

        return `export const fontFiles = ${JSON.stringify(files)};\n`;
      },
    };
  };

  return {
    plugins: [react(), sentraFontsPlugin()],
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
            'antd': ['antd', '@ant-design/icons'],
            'xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-search', '@xterm/addon-web-links'],
            'markdown': ['react-markdown', 'remark-gfm'],
            'icons': ['react-icons']
          }
        }
      }
    },
  };
});
