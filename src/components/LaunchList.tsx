import { useMemo, useState } from "react";
import type { Address } from "viem";
import { explorerAddress, explorerToken, explorerTx } from "../lib/chain";
import {
  priceFromSqrt,
  type EnrichedLaunch,
} from "../lib/discovery";
import { executeCurveTrade, quoteCurve, wrapEth } from "../lib/swap";
import {
  ETH_INFO,
  formatAmount,
  formatPct,
  isNative,
  parseAmount,
  shortAddress,
  type TokenInfo,
} from "../lib/tokens";
import { TokenIcon } from "./TokenIcon";
import { Pagination } from "./Pagination";
import { usePagination } from "../lib/pagination";


interface LaunchListProps {
  account: Address | null;
  launches: readonly EnrichedLaunch[];
  tokenInfos: Map<string, TokenInfo>;
  loading: boolean;
  scanProgress: string | null;
  onRefresh: () => void;
}

type TradePhase =
  | { stage: "idle" }
  | { stage: "working"; message: string }
  | { stage: "done"; hashes: string[] }
  | { stage: "error"; message: string };

export function LaunchList({
  account,
  launches,
  tokenInfos,
  loading,
  scanProgress,
  onRefresh,
}: LaunchListProps) {
  const [query, setQuery] = useState("");
  const [onlyActive, setOnlyActive] = useState(true);
  const [selected, setSelected] = useState<EnrichedLaunch | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return launches.filter((l) => {
      if (onlyActive && l.progress?.migrated) return false;
      if (!q) return true;
      const info = tokenInfos.get(l.token.toLowerCase());
      return (
        info?.symbol.toLowerCase().includes(q) ||
        info?.name.toLowerCase().includes(q) ||
        l.token.toLowerCase().includes(q) ||
        l.curve.toLowerCase().includes(q) ||
        l.configId.includes(q)
      );
    });
  }, [launches, query, onlyActive, tokenInfos]);

  const pager = usePagination(filtered.length, `${query}|${onlyActive}`);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Live launch curves</h2>
        <button
          className="btn btn-ghost"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? "Scanning…" : "Refresh"}
        </button>
      </div>
      <p className="muted">
        Tokens launched through the Ammora V4 factory, discovered on-chain from
        `LaunchCreated` events. Click a row to trade on its bonding curve.
        {scanProgress && <span className="scan-progress"> {scanProgress}</span>}
      </p>

      <div className="filter-row">
        <input
          className="input"
          placeholder="Search symbol, name, address, or config id"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={onlyActive}
            onChange={(e) => setOnlyActive(e.target.checked)}
          />
          Active curves only
        </label>
      </div>

      {launches.length === 0 && !loading && (
        <p className="muted">No launches discovered yet.</p>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Token</th>
              <th>Config</th>
              <th>Status</th>
              <th>Price (WETH)</th>
              <th>Reserves</th>
              <th>Graduation</th>
              <th>Fee</th>
            </tr>
          </thead>
          <tbody>
            {pager.slice(filtered).map((l) => {
              const info = tokenInfos.get(l.token.toLowerCase());
              const state = l.state;
              const price =
                state && info
                  ? priceFromSqrt(state.sqrtPrice, info.decimals, 18)
                  : null;
              return (
                <tr
                  key={l.curve}
                  className={`clickable ${selected?.curve === l.curve ? "selected" : ""}`}
                  onClick={() =>
                    setSelected(selected?.curve === l.curve ? null : l)
                  }
                >
                  <td>
                    <span className="token-cell">
                      <TokenIcon address={l.token} size={26} />
                      <span>
                        <strong>{info?.symbol ?? shortAddress(l.token)}</strong>
                        <div className="muted small">
                          <a
                            href={explorerToken(l.token)}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {shortAddress(l.token)} ↗
                          </a>
                        </div>
                      </span>
                    </span>
                  </td>
                  <td className="mono">#{l.configId}</td>
                  <td>
                    {l.unreadable ? (
                      <span className="badge badge-dim">Unreadable</span>
                    ) : l.progress?.migrated ? (
                      <span className="badge badge-done">Graduated</span>
                    ) : l.progress?.ready ? (
                      <span className="badge badge-warn">Ready to migrate</span>
                    ) : (
                      <span className="badge badge-live">Active</span>
                    )}
                  </td>
                  <td>
                    {price !== null
                      ? price < 0.000001
                        ? "<0.000001"
                        : price.toPrecision(4)
                      : "—"}
                  </td>
                  <td>
                    {state && info ? (
                      <>
                        <div>
                          {formatAmount(state.baseReserve, info.decimals)}{" "}
                          {info.symbol}
                        </div>
                        <div className="muted small">
                          {formatAmount(state.quoteReserve, 18)} WETH
                        </div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {l.progress ? (
                      <div className="progress-cell">
                        <div className="progress-bar">
                          <div
                            className="progress-fill"
                            style={{
                              width: `${Math.min(100, l.progress.progressBps / 100)}%`,
                            }}
                          />
                        </div>
                        <span className="small">
                          {formatPct(l.progress.progressBps)}
                        </span>
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {state ? formatPct(state.currentFeeBps) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pagination
        page={pager.page}
        pageCount={pager.pageCount}
        total={filtered.length}
        pageSize={pager.pageSize}
        onPage={pager.setPage}
      />

      {selected && (
        <CurveTradePanel
          launch={selected}
          account={account}
          tokenInfo={tokenInfos.get(selected.token.toLowerCase())}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function CurveTradePanel({
  launch,
  account,
  tokenInfo,
  onClose,
}: {
  launch: EnrichedLaunch;
  account: Address | null;
  tokenInfo: TokenInfo | undefined;
  onClose: () => void;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [payWith, setPayWith] = useState<"ETH" | "WETH">("ETH");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);
  const [quote, setQuote] = useState<{
    out: bigint;
    fee: bigint;
    minOut: bigint;
    amountLeft: bigint;
  } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [phase, setPhase] = useState<TradePhase>({ stage: "idle" });

  const base = tokenInfo ?? {
    address: launch.token,
    symbol: shortAddress(launch.token),
    decimals: 18,
    name: "Unknown token",
  };
  const payToken = side === "buy" ? (payWith === "ETH" ? ETH_INFO : {
    address: launch.state?.quoteToken ?? ("0x4200000000000000000000000000000000000006" as Address),
    symbol: "WETH",
    decimals: 18,
    name: "Wrapped Ether",
  }) : base;
  const amountRaw = parseAmount(amount, payToken.decimals);

  const getQuote = async () => {
    if (!amountRaw || amountRaw === 0n) return;
    setQuoting(true);
    setQuoteError(null);
    try {
      const q = await quoteCurve(
        launch,
        amountRaw,
        side === "sell",
        slippageBps,
      );
      setQuote({
        out: q.amountOut,
        fee: q.fee,
        minOut: q.minimumAmountOut,
        amountLeft: q.amountLeft,
      });
    } catch (e) {
      setQuote(null);
      setQuoteError(e instanceof Error ? e.message : "Quote failed.");
    } finally {
      setQuoting(false);
    }
  };

  const trade = async () => {
    if (!account || !amountRaw || amountRaw === 0n) return;
    setPhase({ stage: "working", message: "Starting trade…" });
    const hashes: string[] = [];
    try {
      // Fresh quote BEFORE wrapping: if the curve cannot fill the full
      // amount, refuse here so the user is not left holding WETH.
      const q = await quoteCurve(launch, amountRaw, side === "sell", slippageBps);
      if (q.amountLeft > 0n) {
        throw new Error(
          "The curve cannot fill this full amount — only part of it is available. Reduce the amount and try again.",
        );
      }
      if (side === "buy" && isNative(payToken.address)) {
        setPhase({ stage: "working", message: "Wrapping ETH → WETH…" });
        hashes.push(await wrapEth(account, amountRaw));
      }
      const hs = await executeCurveTrade(q, account, slippageBps, (m) =>
        setPhase({ stage: "working", message: m }),
      );
      hashes.push(...hs);
      setPhase({ stage: "done", hashes });
      setAmount("");
      setQuote(null);
    } catch (e) {
      setPhase({
        stage: "error",
        message: e instanceof Error ? e.message : "Trade failed.",
      });
    }
  };

  const migrated = launch.progress?.migrated ?? false;

  return (
    <div className="trade-drawer">
      <div className="modal-head">
        <div className="pair-cell">
          <TokenIcon address={base.address} size={28} />
          <h3>
            Trade {base.symbol}
            <span className="muted small">
              {" "}
              · curve{" "}
              <a
                href={explorerAddress(launch.curve)}
                target="_blank"
                rel="noreferrer"
              >
                {shortAddress(launch.curve)} ↗
              </a>
            </span>
          </h3>
        </div>
        <button className="btn btn-ghost" onClick={onClose}>
          ✕
        </button>
      </div>

      {migrated ? (
        <p>
          This token has graduated — its curve is closed. Trade it on the
          canonical ARL pool instead:{" "}
          {launch.state?.canonicalPool && (
            <a
              href={explorerAddress(launch.state.canonicalPool)}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddress(launch.state.canonicalPool)} ↗
            </a>
          )}{" "}
          (use the Swap tab — the route engine finds the pool automatically).
        </p>
      ) : (
        <>
          <div className="side-toggle">
            <button
              className={`btn ${side === "buy" ? "btn-buy" : "btn-ghost"}`}
              onClick={() => {
                setSide("buy");
                setQuote(null);
              }}
            >
              Buy {base.symbol}
            </button>
            <button
              className={`btn ${side === "sell" ? "btn-sell" : "btn-ghost"}`}
              onClick={() => {
                setSide("sell");
                setQuote(null);
              }}
            >
              Sell {base.symbol}
            </button>
            {side === "buy" && (
              <span className="pay-with">
                Pay with{" "}
                <button
                  className={`chip ${payWith === "ETH" ? "chip-active" : ""}`}
                  onClick={() => setPayWith("ETH")}
                >
                  ETH
                </button>
                <button
                  className={`chip ${payWith === "WETH" ? "chip-active" : ""}`}
                  onClick={() => setPayWith("WETH")}
                >
                  WETH
                </button>
              </span>
            )}
          </div>

          <div className="swap-row">
            <input
              className="amount-input"
              inputMode="decimal"
              placeholder="0.0"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setQuote(null);
              }}
            />
            <span className="token-btn static">
              <TokenIcon address={payToken.address} size={20} />
              {payToken.symbol}
            </span>
            <button
              className="btn btn-ghost"
              onClick={getQuote}
              disabled={!amountRaw || amountRaw === 0n || quoting}
            >
              {quoting ? "…" : "Quote"}
            </button>
          </div>

          <div className="slippage-row">
            <span>Slippage</span>
            <div className="slippage-presets">
              {[10, 50, 100].map((bps) => (
                <button
                  key={bps}
                  className={`chip ${slippageBps === bps ? "chip-active" : ""}`}
                  onClick={() => setSlippageBps(bps)}
                >
                  {bps / 100}%
                </button>
              ))}
            </div>
          </div>

          {quoteError && <p className="error-text">{quoteError}</p>}
          {quote && (
            <div className="quote-details">
              <div className="kv">
                <span>You receive (est.)</span>
                <strong>
                  {formatAmount(
                    quote.out,
                    side === "buy" ? base.decimals : 18,
                    side === "buy" ? base.symbol : "WETH",
                  )}
                </strong>
              </div>
              <div className="kv">
                <span>Minimum received</span>
                <span>
                  {formatAmount(
                    quote.minOut,
                    side === "buy" ? base.decimals : 18,
                  )}
                </span>
              </div>
              <div className="kv">
                <span>Curve fee</span>
                <span>{formatAmount(quote.fee, payToken.decimals)}</span>
              </div>
              {quote.amountLeft > 0n && (
                <p className="error-text">
                  ⚠️ The curve can only fill part of this amount (
                  {formatAmount(quote.amountLeft, payToken.decimals)}{" "}
                  unfilled). Reduce the amount to trade.
                </p>
              )}
            </div>
          )}

          <button
            className={`btn btn-wide ${side === "buy" ? "btn-buy" : "btn-sell"}`}
            onClick={trade}
            disabled={
              !account ||
              !amountRaw ||
              amountRaw === 0n ||
              (quote !== null && quote.amountLeft > 0n) ||
              phase.stage === "working"
            }
          >
            {!account
              ? "Connect wallet to trade"
              : phase.stage === "working"
                ? "Trading…"
                : `${side === "buy" ? "Buy" : "Sell"} ${base.symbol}`}
          </button>

          {phase.stage === "working" && (
            <p className="status-line">⏳ {phase.message}</p>
          )}
          {phase.stage === "done" && (
            <div className="success-box">
              <p>✅ Trade confirmed.</p>
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
          )}
          {phase.stage === "error" && (
            <p className="error-text">❌ {phase.message}</p>
          )}
        </>
      )}
    </div>
  );
}
