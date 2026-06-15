import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

/**
 * Build du module Calendar en bundle ESM autonome :
 *   npm run build  →  dist/{entry.js, entry.css, chunks/*}
 *
 * Tous les specifiers fournis par le host (react, zustand, i18next, @ui,
 * @kubuno/sdk…) sont `external` : au runtime, l'import map du host les résout
 * vers ses instances uniques. `entry.js` exporte `register()` + `sdkVersion`.
 * `lucide-react`, `date-fns`, `dompurify` sont bundlés (consomment le React
 * partagé via l'external `react`).
 */
const SHARED = new Set([
  'react', 'react-dom', 'react-dom/client',
  'react/jsx-runtime', 'react/jsx-dev-runtime',
  'react-router-dom', '@tanstack/react-query',
  'zustand', 'react-i18next', 'i18next',
  '@ui', '@kubuno/sdk', '@kubuno/drive',
  '@radix-ui/react-dropdown-menu',
])
const isExternal = (s: string) =>
  SHARED.has(s) || s.startsWith('@ui/') || s.startsWith('@kubuno/sdk/') || s.startsWith('@kubuno/drive/')

// LOCAL : alias vers les sources du dépôt kubuno/core voisin (résolution de types
// uniquement ; `external` empêche tout bundling). À LA PUBLICATION : ces specifiers
// seront fournis par les paquets npm @kubuno/sdk, @kubuno/ui, @kubuno/drive.
const CORE = '../../kubuno-core/frontend/src'

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@ui': fileURLToPath(new URL(`${CORE}/ui`, import.meta.url)),
      '@kubuno/sdk': fileURLToPath(new URL(`${CORE}/sdk/index.ts`, import.meta.url)),
      '@kubuno/drive': fileURLToPath(new URL(`${CORE}/drive/index.ts`, import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: fileURLToPath(new URL('./src/entry.ts', import.meta.url)),
      external: isExternal,
      preserveEntrySignatures: 'strict',
      output: {
        format: 'es',
        entryFileNames: 'entry.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (info: { name?: string }) =>
          info.name?.endsWith('.css') ? 'entry.css' : 'assets/[name][extname]',
      },
    },
  },
})
