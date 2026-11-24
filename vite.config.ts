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
 *
 * Deploy note 3 (24 Nov 2026): the note-2 re-trigger ALSO failed at the
 * deploy step ("No artifacts named 'github-pages'", 22 detik) — same
 * transient artifact-metadata flakiness, not a code problem. Retried
 * after a few minutes' pause.
 *
 * Deploy note 4 (24 Nov 2026): same race again during the priority-fixes
 * batch-4 push — the live site served an intermediate build (new
 * index.html with OG tags, old JS/CSS). This comment re-triggered a
 * clean deploy run for the full tree.
 *
 * Deploy note 5 (24 Nov 2026): the priceFromSqrt fix commit (a836fbab)
 * and the real tidepool-og.png commit (81fda9d) both failed to reach the
 * live site — 12 minutes after the fix commit the live bundle was still
 * the batch-4 build with the old 2^96 divisor. This comment re-triggered
 * a clean deploy run for the full tree.
 *
 * Deploy note 6 (24 Nov 2026): same race again — the two formatLiquidity
 * commits (tokens.ts + PoolList.tsx) did not reach the live site; the
 * live bundle stayed on the priceFromSqrt build. This comment re-triggered
 * a clean deploy run for the full tree.
 *
 * Deploy note 7 (24 Nov 2026): the note-6 re-trigger ALSO failed to deploy
 * (live bundle still the priceFromSqrt build 7 minutes later) — same
 * transient artifact flakiness as the identicon batch, where the second
 * re-trigger after a pause succeeded. Retried after a pause.
 */

// https://vite.dev/config/
export default defineConfig({
  // Relative base so the same build works at a domain root (Vercel) and
  // under a subpath (GitHub Pages project site, e.g. /tidepool-ammora-exchange/).
  base: './',
  plugins: [react()],
})
