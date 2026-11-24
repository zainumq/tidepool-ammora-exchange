import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Deploy constraint: every emitted file must stay under 80 KB, because the
 * deploy path uploads files one by one through a CLI argument capped at
 * ~128 KB (base64 of an 80 KB file is ~107 KB, still safe).
 *
 * The heavy dependencies cannot be code-split small enough by Rollup:
 * - react-dom is a single CJS module (~214 KB minified in its own chunk).
 * - @ammora-protocol/sdk ships pre-bundled dist files; its tree-shaken
 *   index.js alone is ~337 KB minified, chunk-OK4GEQU2 ~164 KB.
 * A single module cannot be split across chunks, so these are externalized
 * and loaded at runtime from CDNs via the import map in index.html,
 * pinned to the exact installed versions:
 * - react / react-dom 19.3.1, viem 2.58.4 via esm.sh.
 * - @ammora-protocol/sdk 0.3.9 as the raw npm artifact from jsDelivr:
 *   esm.sh's build of this SDK is broken (its sdk.mjs contains an
 *   `export *` inside an arrow function — a syntax error, verified
 *   24 Nov 2026). The SDK's bare imports (viem, math) resolve through the
 *   same import map, so app and SDK share one viem instance.
 *
 * manualChunks below is a safety net for any other node_modules code that
 * might get bundled in the future; today every dependency is external.
 */
function manualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined
  const pkg = id.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/)
  if (pkg) return `pkg-${pkg[1].replace('@', '').replace('/', '-')}`
  return 'vendor'
}

const EXTERNAL_DEPS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'viem',
  '@ammora-protocol/sdk',
]

// https://vite.dev/config/
export default defineConfig({
  // Relative base so the same build works at a domain root (Vercel) and
  // under a subpath (GitHub Pages project site, e.g. /tidepool-ammora-exchange/).
  base: './',
  plugins: [react()],
  build: {
    rollupOptions: {
      external: EXTERNAL_DEPS,
      output: {
        manualChunks,
      },
    },
  },
})
