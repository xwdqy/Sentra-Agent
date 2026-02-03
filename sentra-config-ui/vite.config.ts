import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const clientPort = parseInt(env.CLIENT_PORT || '7244');
  const serverPort = parseInt(env.SERVER_PORT || '7245');

  const precompressDistAssetsPlugin = () => {
    return {
      name: 'sentra-precompress-dist-assets',
      apply: 'build' as const,
      async closeBundle() {
        const distDir = path.resolve(process.cwd(), 'dist');
        const assetsDir = path.join(distDir, 'assets');
        if (!fs.existsSync(assetsDir)) return;

        const entries = fs.readdirSync(assetsDir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isFile()) continue;
          const file = e.name;

          if (file.endsWith('.br') || file.endsWith('.gz')) continue;

          const ext = path.extname(file).toLowerCase();
          const compressible = ext === '.js' || ext === '.css' || ext === '.html' || ext === '.svg' || ext === '.json' || ext === '.map';
          if (!compressible) continue;

          const abs = path.join(assetsDir, file);
          const gzPath = abs + '.gz';
          if (!fs.existsSync(gzPath)) {
            try {
              await pipeline(
                fs.createReadStream(abs),
                zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION }),
                fs.createWriteStream(gzPath)
              );
            } catch { }
          }

          const brPath = abs + '.br';
          if (!fs.existsSync(brPath)) {
            try {
              await pipeline(
                fs.createReadStream(abs),
                zlib.createBrotliCompress({
                  params: {
                    [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
                  },
                }),
                fs.createWriteStream(brPath)
              );
            } catch { }
          }
        }
      },
    };
  };

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
    plugins: [react(), sentraFontsPlugin(), precompressDistAssetsPlugin()],
    server: {
      host: true,
      port: clientPort,
      proxy: {
        '/api': {
          target: `http://localhost:${serverPort}`,
          changeOrigin: true,
          ws: true,
          configure: (proxy) => {
            proxy.on('error', (err: any) => {
              const code = String((err as any)?.code || '');
              // Page refresh often aborts the websocket; ignore noisy proxy errors.
              if (code === 'ECONNABORTED' || code === 'ECONNRESET') return;
              console.warn('[vite][proxy] /api error', err);
            });
          },
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
