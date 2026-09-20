import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Renderer build. base './' keeps asset URLs relative so the production
// bundle loads correctly from file:// inside Electron.
export default defineConfig({
  plugins: [
    react(),
    {
      // Development only: the production Content-Security-Policy in index.html
      // is strict ('self' scripts). Vite's React fast-refresh preamble is an
      // inline module script, so the dev server needs a relaxed policy.
      // Production keeps the strict policy from index.html.
      name: 'netx-dev-csp',
      apply: 'serve',
      transformIndexHtml(html) {
        return html.replace(
          /script-src 'self'/,
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
        );
      },
    },
  ],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
