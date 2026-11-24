# Tidepool — Ammora Exchange & LP Manager

An independent builder submission for the **Ammora Season 2 Builder mission**:
ship an exchange or launchpad with the Ammora SDK. Tidepool is an exchange with
a full LP manager — the part no other builder has shipped.

**Testnet only (GIWA Sepolia, chain 91342).** Test ETH has $0 value. No mainnet,
no real funds. Never share a private key or seed phrase with any app.

## Features

- **Swap** — best-route swaps across all Ammora pools discovered on-chain
  (`AmmoraRouteClient.discoverPools()` with a direct `PoolCreated` factory-log
  fallback after a 120 s timeout, + `quoteExactIn`; no indexer, no Data API),
  with a route map, price impact, slippage control, and auto-refreshing
  quotes. Launch-curve tokens trade on their bonding curve
  (`AmmoraV4LaunchCurveClient`); native ETH is wrapped to WETH automatically
  as part of the swap and unwrapped back on the way out. Any ERC-20 can be
  pasted by address. Curve trades are all-or-nothing: a quote that cannot
  fill the full amount is blocked in the UI before any signing.
- **Live launch curves** — tokens discovered on-chain from the V4 factory
  `LaunchCreated` logs (chunked 9,000-block scans — the GIWA RPC caps
  `eth_getLogs` at 10,000 blocks — cached locally, incrementally refreshable),
  with curve status, reserves, graduation progress, and click-to-trade
  buy/sell on the curve.
- **Pools** — discovered ARL pools with reserves, fee tier, and price. Open a
  new position in any concentrated or compounding pool, or zap in with a
  single token (swap + add liquidity in one plan, router verified against the
  reviewed deployment).
- **My LP (the differentiator)** — concentrated positions (position-manager
  NFTs) and compounding positions (pool NFTs) discovered by scanning ERC-721
  transfers and re-verifying ownership; the two id namespaces are never
  mixed. Add/remove liquidity with quotes, claim position fees (with an
  optional separate payout address), fee-only delegation grant/revoke
  (permissions 8 / 16), and position splitting.

## Stack

- React 19 + TypeScript + Vite
- `@ammora-protocol/sdk@0.3.9` (exact) + `viem`
- GIWA Sepolia: RPC `https://sepolia-rpc.giwa.io`, explorer
  `https://sepolia-explorer.giwa.io`
- Reviewed deployment slot `v4-auto-route-20260917`; all contract addresses
  come from the SDK catalog, never hand-typed.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck
npm run lint
npm run build      # production build in dist/
```

## Deploy

Pushing to `main` deploys via GitHub Actions to GitHub Pages (see
`.github/workflows/pages.yml`). One-time setup: in the repo settings, enable
Pages with **Source: GitHub Actions**. The build uses a relative base (`./`),
so the same output also works at a domain root (e.g. Vercel).

## Verification notes

Read-only on-chain verification against the live GIWA Sepolia RPC
(24 Nov 2026, head ≈ block 42,135,000; no key, no sends):

- **Launch scan** — 172 `LaunchCreated` events from block 36,220,000 to head,
  0 failed chunks, 64 s. Newest launch: config 67 at block 42,121,596.
- **Curve quotes** — on the newest active curve (status 1, fee 100 bps):
  buy 0.001 WETH → 0.0345276 base tokens; sell quotes return partial fills
  (`amountLeft`) when the input exceeds reserves, confirming the
  `baseForQuote` direction empirically. Migrated curves (status 3, canonical
  pool set) reject buy quotes — the app disables curve trading for them and
  links the canonical ARL pool instead.
- **Pool discovery** — the SDK's `discoverPools()` proved unreliable on this
  RPC (one run crashed on a `quoteToken` verification read; a second ran
  30+ minutes without returning), so the app falls back to a direct
  `PoolCreated` scan of both ARL factories after a 120 s timeout. The
  fallback found **46 pools** across the full history (41 concentrated,
  5 compounding; 44 with WETH as quote token), 0 failed chunks in 573 s,
  including the canonical pools of the migrated curves above.
- **Route quote + prepare** — 0.001 WETH → 2,363,627,664,409 base units in
  1 hop through concentrated pool `0xdAD69AE6…`, price impact 576 bps,
  fee 0.00001 WETH; `prepareExactIn` returned an executable plan with an
  exact WETH approval to the pool. One pool
  (`0xe78786D6…`) returns "no reviewed exact-input route" — the app surfaces
  such quote errors rather than failing silently.
- **LP position scan** — a real launch creator
  (`0xaeE3c7b1…`) holds 4 concentrated positions (#81, #82, #84, #85), all
  confirmed by `ownerOf` re-verification after the `Transfer` scan.
- **Build** — `npm run build` (tsc + Vite) passes; `npm run lint` (oxlint)
  0 errors, 7 advisory warnings.

Live send-transaction testing (swaps, LP actions) requires a funded testnet
wallet in the browser and was not run from this environment.
