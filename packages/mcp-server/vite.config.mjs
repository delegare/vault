import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { skybridge } from 'skybridge/web';

export default defineConfig({
  plugins: [react(), skybridge()],
  build: {
    outDir: 'dist/web',
    // Use STABLE filenames (no content hash) for widget bundles. ChatGPT /
    // OpenAI caches the widget HTML template server-side (via
    // `template_pointer=sid:file_...`) the first time a connector is
    // registered. If our hashed filenames change on every deploy, that cached
    // HTML points at JS bundles that no longer exist on our server, causing
    // "Failed to fetch dynamically imported module" 404s in ChatGPT until the
    // user manually reconnects the connector. Stable names keep the URLs
    // valid across deploys.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
