import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// The conversion engine is built (NodeNext ESM) to ../dist. We import it
// directly so the browser app and the CLI/tests share one source of truth.
// On GitHub Pages a project site is served from /<repo>/; locally from /.
// The repo name is derived from GITHUB_REPOSITORY ("owner/repo") in CI.
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
const base = process.env.GITHUB_PAGES === 'true' && repo ? `/${repo}/` : '/';

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: {
      '@engine': resolve(here, '../dist'),
    },
  },
  server: {
    // Allow the dev server to read the sibling ../dist engine output.
    fs: { allow: [resolve(here, '..')] },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
