import { defineConfig } from 'vite';

export default defineConfig({
  // Relative Pfade, damit die Seite auch unter https://<name>.github.io/<repo>/ läuft
  base: './',
  server: { host: true },
  build: { target: 'es2020', chunkSizeWarningLimit: 1500 },
});
