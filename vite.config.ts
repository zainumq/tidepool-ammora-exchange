import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Normal bundled build: every dependency (React, viem, Ammora SDK) is
 * bundled from node_modules into dist. The app has no runtime CDN
 * dependency.
 *
 * History: an earlier revision externalized the heavy deps and loaded
 * them from esm.sh / jsDelivr via an import map, because the deploy path
 * at the time uploaded files one by one through a CLI argument capped at
 * ~128 KB. That constraint does not apply to GitHub Pages, where Actions
 * builds from source with no such limit — so the externalization was
 * reverted on 24 Nov 2026.
 *
 * Deploy note (24 Nov 2026): rapid successive pushes raced each other at
 * the GitHub Pages deploy step and the final run failed there (build
 * itself passed). This comment re-triggered a clean deploy run.
 *
 * Deploy note 2 (24 Nov 2026): same race again during the identicon push —
 * the final run (index.css) failed at the deploy step while the previous
 * run succeeded, leaving the live build without the new icon styles.
 * This comment re-triggered a clean deploy run for the full tree.
 */

// https://vite.dev/config/
export default defineConfig({
  // Relative base so the same build works at a domain root (Vercel) and
  // under a subpath (GitHub Pages project site, e.g. /tidepool-ammora-exchange/).
  base: './',
  plugins: [react()],
})
