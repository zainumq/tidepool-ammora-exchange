import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { LaunchList } from "./components/LaunchList";
import { LpManager } from "./components/LpManager";
import { PoolList } from "./components/PoolList";
import { RpcSettings } from "./components/RpcSettings";
import { RpcStatusBanner } from "./components/RpcStatusBanner";
import { SwapPanel } from "./components/SwapPanel";
import { WalletBar } from "./components/WalletBar";
import { ADDRESSES, DEPLOYMENT } from "./lib/chain";
import {
  discoverPools,
  enrichLaunches,
  scanLaunches,
  sortLaunches,
  type DiscoveredPool,
  type EnrichedLaunch,
} from "./lib/discovery";
import {
  ETH_INFO,
  fetchTokenInfos,
  type TokenInfo,
} from "./lib/tokens";

type Tab = "swap" | "launches" | "pools" | "lp";

export default function App() {
  const [tab, setTab] = useState<Tab>("swap");
  const [account, setAccount] = useState<Address | null>(null);

  const [launches, setLaunches] = useState<EnrichedLaunch[]>([]);
  const [pools, setPools] = useState<DiscoveredPool[]>([]);
  const [tokenInfos, setTokenInfos] = useState<Map<string, TokenInfo>>(
    new Map(),
  );
  const [launchesLoading, setLaunchesLoading] = useState(true);
  const [poolsLoading, setPoolsLoading] = useState(true);
  const [poolsLoaded, setPoolsLoaded] = useState(false);
  const [scanProgress, setScanProgress] = useState<string | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const started = useRef(false);

  const loadLaunches = useCallback(async () => {
    setLaunchesLoading(true);
    setDiscoveryError(null);
    try {
      const records = await scanLaunches((p) =>
        setScanProgress(
          `Scanning launch history: ${p.done}/${p.total} chunks · ${p.found} launches found`,
        ),
      );
      const sorted = sortLaunches(records);
      setScanProgress(`Reading curve state for ${sorted.length} launches…`);
      const enriched = await enrichLaunches(sorted, (done, total) =>
        setScanProgress(`Reading curve state: ${done}/${total}`),
      );
      setLaunches(enriched);
      setScanProgress(null);
    } catch (e) {
      setDiscoveryError(
        `Launch scan failed: ${e instanceof Error ? e.message : "unknown error"}. Check the GIWA RPC and retry.`,
      );
    } finally {
      setLaunchesLoading(false);
    }
  }, []);

  const loadPools = useCallback(async (force = false) => {
    setPoolsLoading(true);
    try {
      const found = await discoverPools(force, (p) =>
        setScanProgress(
          `Scanning pool history (fallback): ${p.done}/${p.total} chunks · ${p.found} pools found`,
        ),
      );
      setPools(found);
      setPoolsLoaded(true);
      setScanProgress(null);
    } catch (e) {
      setDiscoveryError(
        `Pool discovery failed: ${e instanceof Error ? e.message : "unknown error"}. Check the GIWA RPC and retry.`,
      );
    } finally {
      setPoolsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void loadLaunches();
    void loadPools();
  }, [loadLaunches, loadPools]);

  // Token metadata for everything discovered on-chain.
  useEffect(() => {
    const addresses: Address[] = [ADDRESSES.weth];
    for (const l of launches) addresses.push(l.token);
    for (const p of pools) {
      addresses.push(p.baseToken, p.quoteToken);
    }
    if (addresses.length <= 1) return;
    let cancelled = false;
    fetchTokenInfos(addresses).then((infos) => {
      if (!cancelled) setTokenInfos(infos);
    });
    return () => {
      cancelled = true;
    };
  }, [launches, pools]);

  const knownTokens = useMemo(() => {
    const list: TokenInfo[] = [ETH_INFO];
    const seen = new Set<string>([ETH_INFO.address.toLowerCase()]);
    for (const info of tokenInfos.values()) {
      const key = info.address.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        list.push(info);
      }
    }
    // WETH first, then the rest alphabetically.
    return list.sort((a, b) => {
      if (a.address.toLowerCase() === ADDRESSES.weth.toLowerCase()) return -1;
      if (b.address.toLowerCase() === ADDRESSES.weth.toLowerCase()) return 1;
      return a.symbol.localeCompare(b.symbol);
    });
  }, [tokenInfos]);

  return (
    <div className="app">
      <div className="testnet-banner">
        ⚠️ GIWA Sepolia TESTNET only — every asset here has $0 value. Never
        send mainnet funds to this app.
      </div>

      <header className="header">
        <div className="brand">
          <span className="brand-mark">🌊</span>
          <div>
            <h1>Tidepool</h1>
            <p className="brand-sub">
              Ammora exchange &amp; LP manager · GIWA Sepolia
            </p>
          </div>
        </div>
        <WalletBar account={account} onAccount={setAccount} />
      </header>

      <RpcStatusBanner />

      <RpcSettings />

      <nav className="tabs">
        {(
          [
            ["swap", "Swap"],
            ["launches", `Launches (${launches.length})`],
            ["pools", `Pools (${pools.length})`],
            ["lp", "My LP"],
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            className={`tab ${tab === id ? "tab-active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {discoveryError && (
        <div className="error-banner">{discoveryError}</div>
      )}

      <main className="main">
        {tab === "swap" && (
          <SwapPanel
            account={account}
            launches={launches}
            pools={pools}
            knownTokens={knownTokens}
          />
        )}
        {tab === "launches" && (
          <LaunchList
            account={account}
            launches={launches}
            tokenInfos={tokenInfos}
            loading={launchesLoading}
            scanProgress={scanProgress}
            onRefresh={loadLaunches}
          />
        )}
        {tab === "pools" && (
          <PoolList
            account={account}
            pools={pools}
            tokenInfos={tokenInfos}
            loading={poolsLoading}
            onRefresh={() => loadPools(true)}
          />
        )}
        {tab === "lp" && (
          <LpManager
            account={account}
            pools={pools}
            tokenInfos={tokenInfos}
            poolsLoaded={poolsLoaded}
          />
        )}
      </main>

      <footer className="footer">
        <p>
          Tidepool is built with{" "}
          <code>@ammora-protocol/sdk@0.3.9</code> on the reviewed deployment{" "}
          <code>{DEPLOYMENT.slot}</code> (GIWA Sepolia, chain 91342).
        </p>
        <p>
          <a
            href="https://ammora-docs.vercel.app"
            target="_blank"
            rel="noreferrer"
          >
            Ammora docs
          </a>{" "}
          ·{" "}
          <a
            href="https://sepolia-explorer.giwa.io"
            target="_blank"
            rel="noreferrer"
          >
            GIWA Sepolia explorer
          </a>{" "}
          ·{" "}
          <a href="https://ammora.org" target="_blank" rel="noreferrer">
            ammora.org
          </a>
        </p>
        <p className="muted small">
          Testnet only. Quotes are live on-chain reads; execution is simulated
          before sending, and every transaction needs your wallet&apos;s
          confirmation. Nothing here is financial advice.
        </p>
      </footer>
    </div>
  );
}
