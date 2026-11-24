import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { explorerAddress, explorerTx } from "../lib/chain";
import type { DiscoveredPool } from "../lib/discovery";
import { priceFromSqrt } from "../lib/discovery";
import {
  getPoolState,
  planCreatePosition,
  planZapIn,
  quoteAdd,
  type PoolState,
} from "../lib/lp";
import {
  formatAmount,
  formatPct,
  parseAmount,
  shortAddress,
  type TokenInfo,
} from "../lib/tokens";
import { executePlan } from "../lib/tx";
import { getWalletClient } from "../lib/client";
import {
  classifyWalletError,
  describeWalletError,
  type WalletErrorKind,
} from "../lib/walletError";
import { WalletErrorHint } from "./WalletErrorHint";

interface PoolListProps {
  account: Address | null;
  pools: readonly DiscoveredPool[];
  tokenInfos: Map<string, TokenInfo>;
  loading: boolean;
  onRefresh: () => void;
}

export type Phase =
  | { stage: "idle" }
  | { stage: "working"; message: string }
  | { stage: "done"; hashes: string[]; note: string }
  | { stage: "error"; message: string; kind?: WalletErrorKind };

export function PoolList({
  account,
  pools,
  tokenInfos,
  loading,
  onRefresh,
}: PoolListProps) {
  const [states, setStates] = useState<Map<string, PoolState>>(new Map());
  const [loadingStates, setLoadingStates] = useState(false);
  const [selected, setSelected] = useState<DiscoveredPool | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (pools.length === 0) return;
    let cancelled = false;
    setLoadingStates(true);
    (async () => {
      const next = new Map<string, PoolState>();
      const CONCURRENCY = 6;
      const tradeable = pools.filter(
        (p) => p.model === "concentrated" || p.model === "compounding",
      );
      for (let i = 0; i < tradeable.length; i += CONCURRENCY) {
        const batch = tradeable.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (p) => {
            try {
              const state = await getPoolState(
                p.pool,
                p.model as "concentrated" | "compounding",
              );
              return [p.pool.toLowerCase(), state] as const;
            } catch {
              return null;
            }
          }),
        );
        for (const r of results) {
          if (r) next.set(r[0], r[1]);
        }
        if (cancelled) return;
        setStates(new Map(next));
      }
      if (!cancelled) setLoadingStates(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [pools]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pools;
    return pools.filter((p) => {
      const base = tokenInfos.get(p.baseToken.toLowerCase());
      const quote = tokenInfos.get(p.quoteToken.toLowerCase());
      return (
        base?.symbol.toLowerCase().includes(q) ||
        quote?.symbol.toLowerCase().includes(q) ||
        p.pool.toLowerCase().includes(q)
      );
    });
  }, [pools, query, tokenInfos]);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Pools</h2>
        <button
          className="btn btn-ghost"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? "Discovering…" : "Refresh"}
        </button>
      </div>
      <p className="muted">
        ARL pools discovered and authenticated on-chain by the SDK route
        client — no indexer, no Data API. Click a pool to inspect it, open a
        position, or zap in with a single token.
        {loadingStates && <span className="scan-progress"> Loading states…</span>}
      </p>

      <div className="filter-row">
        <input
          className="input"
          placeholder="Search pair or pool address"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {pools.length === 0 && !loading && (
        <p className="muted">No pools discovered yet.</p>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Pair</th>
              <th>Model</th>
              <th>Price</th>
              <th>Reserves</th>
              <th>Fee</th>
              <th>Liquidity</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => {
              const base = tokenInfos.get(p.baseToken.toLowerCase());
              const quote = tokenInfos.get(p.quoteToken.toLowerCase());
              const state = states.get(p.pool.toLowerCase());
              const price =
                state && base && quote
                  ? priceFromSqrt(
                      state.sqrtPrice,
                      base.decimals,
                      quote.decimals,
                    )
                  : null;
              return (
                <tr
                  key={p.pool}
                  className={`clickable ${selected?.pool === p.pool ? "selected" : ""}`}
                  onClick={() =>
                    setSelected(selected?.pool === p.pool ? null : p)
                  }
                >
                  <td>
                    <strong>
                      {base?.symbol ?? shortAddress(p.baseToken)} /{" "}
                      {quote?.symbol ?? shortAddress(p.quoteToken)}
                    </strong>
                    <div className="muted small mono">
                      {shortAddress(p.pool)}
                    </div>
                  </td>
                  <td>
                    <span className="badge badge-live">{p.model}</span>
                  </td>
                  <td>
                    {price !== null
                      ? price < 0.000001
                        ? "<0.000001"
                        : price.toPrecision(4)
                      : "—"}
                  </td>
                  <td>
                    {state && base && quote ? (
                      <>
                        <div>
                          {formatAmount(state.reserveBase, base.decimals)}{" "}
                          {base.symbol}
                        </div>
                        <div className="muted small">
                          {formatAmount(state.reserveQuote, quote.decimals)}{" "}
                          {quote.symbol}
                        </div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{state ? formatPct(state.currentFeeBps) : "—"}</td>
                  <td>
                    {state ? state.totalLiquidity.toString() : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selected && (
        <PoolDetail
          pool={selected}
          account={account}
          state={states.get(selected.pool.toLowerCase()) ?? null}
          base={tokenInfos.get(selected.baseToken.toLowerCase())}
          quote={tokenInfos.get(selected.quoteToken.toLowerCase())}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function PoolDetail({
  pool,
  account,
  state,
  base,
  quote,
  onClose,
}: {
  pool: DiscoveredPool;
  account: Address | null;
  state: PoolState | null;
  base: TokenInfo | undefined;
  quote: TokenInfo | undefined;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"info" | "open" | "zap">("info");
  const isLpPool = pool.model === "concentrated" || pool.model === "compounding";

  return (
    <div className="trade-drawer">
      <div className="modal-head">
        <h3>
          {base?.symbol ?? shortAddress(pool.baseToken)} /{" "}
          {quote?.symbol ?? shortAddress(pool.quoteToken)}
          <span className="muted small">
            {" "}
            · {pool.model} ·{" "}
            <a
              href={explorerAddress(pool.pool)}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddress(pool.pool)} ↗
            </a>
          </span>
        </h3>
        <button className="btn btn-ghost" onClick={onClose}>
          ✕
        </button>
      </div>

      {state && base && quote ? (
        <div className="quote-details">
          <div className="kv">
            <span>Price</span>
            <strong>
              1 {base.symbol} ={" "}
              {priceFromSqrt(
                state.sqrtPrice,
                base.decimals,
                quote.decimals,
              ).toPrecision(6)}{" "}
              {quote.symbol}
            </strong>
          </div>
          <div className="kv">
            <span>Reserves</span>
            <span>
              {formatAmount(state.reserveBase, base.decimals, base.symbol)} ·{" "}
              {formatAmount(state.reserveQuote, quote.decimals, quote.symbol)}
            </span>
          </div>
          <div className="kv">
            <span>Fee tier</span>
            <span>{formatPct(state.currentFeeBps)}</span>
          </div>
          <div className="kv">
            <span>Total liquidity</span>
            <span className="mono">{state.totalLiquidity.toString()}</span>
          </div>
          <div className="kv">
            <span>Created</span>
            <span>block #{pool.creationBlock.toString()}</span>
          </div>
        </div>
      ) : (
        <p className="muted">Pool state is still loading…</p>
      )}

      {isLpPool && (
        <>
          <div className="side-toggle">
            <button
              className={`btn ${tab === "open" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setTab("open")}
            >
              Open position
            </button>
            <button
              className={`btn ${tab === "zap" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setTab("zap")}
            >
              Zap in (one token)
            </button>
          </div>
          {tab === "open" && state && base && quote && (
            <OpenPositionForm
              pool={pool}
              account={account}
              base={base}
              quote={quote}
            />
          )}
          {tab === "zap" && state && base && quote && (
            <ZapForm
              pool={pool}
              account={account}
              base={base}
              quote={quote}
            />
          )}
        </>
      )}
      {!isLpPool && (
        <p className="muted">
          LP positions are managed on concentrated and compounding pools. This{" "}
          {pool.model} pool is tradeable from the Swap tab.
        </p>
      )}
    </div>
  );
}

function OpenPositionForm({
  pool,
  account,
  base,
  quote,
}: {
  pool: DiscoveredPool;
  account: Address | null;
  base: TokenInfo;
  quote: TokenInfo;
}) {
  const [maxBase, setMaxBase] = useState("");
  const [maxQuote, setMaxQuote] = useState("");
  const [preview, setPreview] = useState<{
    liquidity: bigint;
    baseAmount: bigint;
    quoteAmount: bigint;
  } | null>(null);
  const [phase, setPhase] = useState<Phase>({ stage: "idle" });

  const kind = pool.model as "concentrated" | "compounding";
  const baseRaw = parseAmount(maxBase, base.decimals);
  const quoteRaw = parseAmount(maxQuote, quote.decimals);

  const getPreview = async () => {
    if (!baseRaw || !quoteRaw || baseRaw === 0n || quoteRaw === 0n) return;
    try {
      const q = await quoteAdd(pool.pool, kind, baseRaw, quoteRaw, 50);
      setPreview({
        liquidity: q.liquidity,
        baseAmount: q.baseAmount,
        quoteAmount: q.quoteAmount,
      });
    } catch (e) {
      // A quote failure is a read failure, not a wallet failure: no hint
      // and no Retry (the Preview button re-runs it).
      setPhase({ stage: "error", message: describeWalletError(e) });
    }
  };

  const create = async () => {
    if (!account || !baseRaw || !quoteRaw) return;
    setPhase({ stage: "working", message: "Planning position…" });
    try {
      const plan = await planCreatePosition(
        pool.pool,
        kind,
        account,
        baseRaw,
        quoteRaw,
        50,
      );
      const wallet = getWalletClient();
      const hashes = await executePlan(
        wallet,
        account,
        plan.transactions,
        plan.approvalRequirements,
        (m) => setPhase({ stage: "working", message: m }),
      );
      setPhase({
        stage: "done",
        hashes: hashes.map(String),
        note: "Position created — find it under My LP.",
      });
    } catch (e) {
      const classified = classifyWalletError(e);
      setPhase({
        stage: "error",
        message: classified.message,
        kind: classified.kind,
      });
    }
  };

  return (
    <div className="form-block">
      <label className="field-label">Max {base.symbol}</label>
      <input
        className="input"
        inputMode="decimal"
        placeholder="0.0"
        value={maxBase}
        onChange={(e) => setMaxBase(e.target.value)}
      />
      <label className="field-label">Max {quote.symbol}</label>
      <input
        className="input"
        inputMode="decimal"
        placeholder="0.0"
        value={maxQuote}
        onChange={(e) => setMaxQuote(e.target.value)}
      />
      <button className="btn btn-ghost" onClick={getPreview}>
        Preview
      </button>
      {preview && (
        <div className="quote-details">
          <div className="kv">
            <span>Liquidity minted</span>
            <strong className="mono">{preview.liquidity.toString()}</strong>
          </div>
          <div className="kv">
            <span>Used</span>
            <span>
              {formatAmount(preview.baseAmount, base.decimals, base.symbol)} ·{" "}
              {formatAmount(preview.quoteAmount, quote.decimals, quote.symbol)}
            </span>
          </div>
        </div>
      )}
      <button
        className="btn btn-primary btn-wide"
        onClick={create}
        disabled={
          !account ||
          !baseRaw ||
          !quoteRaw ||
          baseRaw === 0n ||
          quoteRaw === 0n ||
          phase.stage === "working"
        }
      >
        {!account ? "Connect wallet" : "Create position"}
      </button>
      <PhaseView
        phase={phase}
        onRetry={phase.stage === "error" && phase.kind ? create : undefined}
      />
    </div>
  );
}

function ZapForm({
  pool,
  account,
  base,
  quote,
}: {
  pool: DiscoveredPool;
  account: Address | null;
  base: TokenInfo;
  quote: TokenInfo;
}) {
  const [tokenIn, setTokenIn] = useState<"base" | "quote">("quote");
  const [amount, setAmount] = useState("");
  const [swapPct, setSwapPct] = useState(50);
  const [preview, setPreview] = useState<{
    amountOut: bigint;
    minimumLiquidity: bigint;
  } | null>(null);
  const [phase, setPhase] = useState<Phase>({ stage: "idle" });

  const kind = pool.model as "concentrated" | "compounding";
  const inToken = tokenIn === "base" ? base : quote;
  const amountRaw = parseAmount(amount, inToken.decimals);

  const getPreview = async () => {
    if (!account || !amountRaw || amountRaw === 0n) return;
    try {
      const swapAmount = (amountRaw * BigInt(swapPct)) / 100n;
      const plan = await planZapIn(
        pool.pool,
        kind,
        inToken.address,
        amountRaw,
        swapAmount,
        50,
        account,
      );
      setPreview({
        amountOut: plan.quote.amountOut,
        minimumLiquidity: plan.quote.minimumLiquidity,
      });
    } catch (e) {
      // A preview failure is a read failure, not a wallet failure: no hint
      // and no Retry (the Preview button re-runs it).
      setPhase({ stage: "error", message: describeWalletError(e) });
    }
  };

  const zap = async () => {
    if (!account || !amountRaw || amountRaw === 0n) return;
    setPhase({ stage: "working", message: "Planning zap…" });
    try {
      const swapAmount = (amountRaw * BigInt(swapPct)) / 100n;
      const plan = await planZapIn(
        pool.pool,
        kind,
        inToken.address,
        amountRaw,
        swapAmount,
        50,
        account,
      );
      const wallet = getWalletClient();
      const hashes = await executePlan(
        wallet,
        account,
        plan.transactions,
        plan.approvalRequirements,
        (m) => setPhase({ stage: "working", message: m }),
      );
      setPhase({
        stage: "done",
        hashes: hashes.map(String),
        note: "Zap complete — new position is under My LP.",
      });
    } catch (e) {
      const classified = classifyWalletError(e);
      setPhase({
        stage: "error",
        message: classified.message,
        kind: classified.kind,
      });
    }
  };

  return (
    <div className="form-block">
      <p className="muted">
        One token in, one LP position out: the zap swaps {swapPct}% of your
        input into the other side of the pair, then adds both as liquidity.
      </p>
      <label className="field-label">Input token</label>
      <div className="side-toggle">
        <button
          className={`btn ${tokenIn === "quote" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setTokenIn("quote")}
        >
          {quote.symbol}
        </button>
        <button
          className={`btn ${tokenIn === "base" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setTokenIn("base")}
        >
          {base.symbol}
        </button>
      </div>
      <label className="field-label">Amount {inToken.symbol}</label>
      <input
        className="input"
        inputMode="decimal"
        placeholder="0.0"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <label className="field-label">
        Swap share: {swapPct}% (rest stays as the input side)
      </label>
      <input
        type="range"
        min={5}
        max={95}
        value={swapPct}
        onChange={(e) => setSwapPct(Number(e.target.value))}
      />
      <button className="btn btn-ghost" onClick={getPreview}>
        Preview
      </button>
      {preview && (
        <div className="quote-details">
          <div className="kv">
            <span>Swap output</span>
            <strong>
              {formatAmount(
                preview.amountOut,
                tokenIn === "base" ? quote.decimals : base.decimals,
                tokenIn === "base" ? quote.symbol : base.symbol,
              )}
            </strong>
          </div>
          <div className="kv">
            <span>Min. liquidity</span>
            <span className="mono">
              {preview.minimumLiquidity.toString()}
            </span>
          </div>
        </div>
      )}
      <button
        className="btn btn-primary btn-wide"
        onClick={zap}
        disabled={
          !account ||
          !amountRaw ||
          amountRaw === 0n ||
          phase.stage === "working"
        }
      >
        {!account ? "Connect wallet" : "Zap in"}
      </button>
      <PhaseView
        phase={phase}
        onRetry={phase.stage === "error" && phase.kind ? zap : undefined}
      />
    </div>
  );
}

export function PhaseView({
  phase,
  onRetry,
}: {
  phase: Phase;
  onRetry?: () => void;
}) {
  if (phase.stage === "idle") return null;
  if (phase.stage === "working") {
    return <p className="status-line">⏳ {phase.message}</p>;
  }
  if (phase.stage === "done") {
    return (
      <div className="success-box">
        <p>✅ {phase.note}</p>
        {phase.hashes.map((h) => (
          <a
            key={h}
            href={explorerTx(h)}
            target="_blank"
            rel="noreferrer"
            className="mono tx-link"
          >
            {shortAddress(h)} ↗
          </a>
        ))}
      </div>
    );
  }
  return (
    <div className="wallet-error-box" role="alert">
      <p className="error-text">❌ {phase.message}</p>
      {phase.kind ? <WalletErrorHint kind={phase.kind} /> : null}
      {onRetry ? (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
