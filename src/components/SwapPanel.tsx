import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { ADDRESSES, erc20Abi, explorerTx } from "../lib/chain";
import { publicClient } from "../lib/client";
import type { DiscoveredPool, EnrichedLaunch } from "../lib/discovery";
import {
  executeCurveTrade,
  executeRouteTrade,
  pickVenue,
  prepareRoute,
  quoteCurve,
  quoteRoute,
  unwrapWeth,
  wrapEth,
  type SwapQuote,
} from "../lib/swap";
import {
  ETH_INFO,
  formatAmount,
  formatPct,
  isNative,
  parseAmount,
  shortAddress,
  type TokenInfo,
} from "../lib/tokens";
import {
  classifyWalletError,
  type WalletErrorKind,
} from "../lib/walletError";
import { WalletErrorHint } from "./WalletErrorHint";
import { TokenPicker } from "./TokenPicker";
import { TokenIcon } from "./TokenIcon";

interface SwapPanelProps {
  account: Address | null;
  launches: readonly EnrichedLaunch[];
  pools: readonly DiscoveredPool[];
  knownTokens: TokenInfo[];
}

type TxPhase =
  | { stage: "idle" }
  | { stage: "working"; message: string }
  | { stage: "done"; hashes: string[]; note: string }
  | {
      stage: "error";
      message: string;
      kind: WalletErrorKind;
      /** Which step failed — Retry resumes from there instead of
       * re-running the whole flow (a swap that already succeeded must
       * never run twice). */
      failedStep?: "wrap" | "swap" | "unwrap";
    };

const SLIPPAGE_PRESETS = [10, 50, 100]; // bps

export function SwapPanel({
  account,
  launches,
  pools,
  knownTokens,
}: SwapPanelProps) {
  const [tokenIn, setTokenIn] = useState<TokenInfo>(ETH_INFO);
  const [tokenOut, setTokenOut] = useState<TokenInfo | null>(null);
  const [amountIn, setAmountIn] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);
  const [customSlippage, setCustomSlippage] = useState("");
  const [picker, setPicker] = useState<"in" | "out" | null>(null);
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [balanceIn, setBalanceIn] = useState<bigint | null>(null);
  const [balanceOut, setBalanceOut] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<TxPhase>({ stage: "idle" });
  const quoteSeq = useRef(0);
  // Context for resuming an unwrap that failed after the swap succeeded:
  // the WETH balance before the swap (the received amount is the delta)
  // plus the hashes already produced by this attempt.
  const unwrapRef = useRef<{ wethBefore: bigint; hashes: string[] } | null>(
    null,
  );

  const amountRaw = useMemo(
    () => parseAmount(amountIn, tokenIn.decimals),
    [amountIn, tokenIn],
  );

  const venue = useMemo(() => {
    if (!tokenOut) return null;
    return pickVenue(tokenIn.address, tokenOut.address, launches);
  }, [tokenIn, tokenOut, launches]);

  const fetchBalances = useCallback(async () => {
    if (!account) {
      setBalanceIn(null);
      setBalanceOut(null);
      return;
    }
    const readOne = async (token: TokenInfo) => {
      if (isNative(token.address)) {
        return publicClient.getBalance({ address: account });
      }
      return publicClient.readContract({
        abi: erc20Abi,
        address: token.address,
        functionName: "balanceOf",
        args: [account],
      });
    };
    try {
      setBalanceIn(await readOne(tokenIn));
      if (tokenOut) setBalanceOut(await readOne(tokenOut));
    } catch {
      /* balances are best-effort */
    }
  }, [account, tokenIn, tokenOut]);

  useEffect(() => {
    fetchBalances();
  }, [fetchBalances]);

  const refreshQuote = useCallback(async () => {
    if (!tokenOut || !amountRaw || amountRaw === 0n || !venue) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    const seq = ++quoteSeq.current;
    setQuoting(true);
    setQuoteError(null);
    try {
      let next: SwapQuote;
      if (venue.kind === "curve") {
        next = await quoteCurve(
          venue.launch,
          amountRaw,
          venue.baseForQuote,
          slippageBps,
        );
      } else {
        const inAddr = isNative(tokenIn.address)
          ? ADDRESSES.weth
          : tokenIn.address;
        const outAddr = isNative(tokenOut.address)
          ? ADDRESSES.weth
          : tokenOut.address;
        next = await quoteRoute(
          inAddr,
          outAddr,
          amountRaw,
          slippageBps,
          pools,
          account ?? undefined,
        );
      }
      if (quoteSeq.current !== seq) return;
      setQuote(next);
    } catch (e) {
      if (quoteSeq.current !== seq) return;
      setQuote(null);
      setQuoteError(
        e instanceof Error
          ? friendlyQuoteError(e.message)
          : "No route found for this pair.",
      );
    } finally {
      if (quoteSeq.current === seq) setQuoting(false);
    }
  }, [tokenOut, amountRaw, venue, slippageBps, pools, account, tokenIn]);

  // Debounced quote on input change.
  useEffect(() => {
    const timer = setTimeout(refreshQuote, 500);
    return () => clearTimeout(timer);
  }, [refreshQuote]);

  // Auto-refresh the quote every 15 seconds while the panel is open.
  useEffect(() => {
    if (!amountRaw || amountRaw === 0n) return;
    const timer = setInterval(refreshQuote, 15_000);
    return () => clearInterval(timer);
  }, [refreshQuote, amountRaw]);

  const flip = () => {
    if (!tokenOut) return;
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountIn("");
    setQuote(null);
  };

  const setMax = () => {
    if (balanceIn === null) return;
    // Keep a dust of ETH for gas when paying with native ETH.
    const usable =
      isNative(tokenIn.address) && balanceIn > 1000000000000000n
        ? balanceIn - 1000000000000000n
        : balanceIn;
    const whole = Number(usable) / 10 ** tokenIn.decimals;
    setAmountIn(whole.toString());
  };

  const applyCustomSlippage = () => {
    const pct = Number(customSlippage);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 50) return;
    setSlippageBps(Math.round(pct * 100));
  };

  const execute = async () => {
    if (!account || !tokenOut || !quote || !amountRaw) return;
    setPhase({ stage: "working", message: "Starting swap…" });
    unwrapRef.current = null;
    const hashes: string[] = [];
    let step: "wrap" | "swap" | "unwrap" = isNative(tokenIn.address)
      ? "wrap"
      : "swap";
    try {
      // Step 1: wrap native ETH into WETH when paying with ETH — only the
      // shortfall. Skipping the wrap when the wallet already holds enough
      // WETH saves a signature, and it makes Retry safe: a retry after a
      // failed swap does not wrap the same amount a second time.
      if (isNative(tokenIn.address)) {
        const wethBal = await publicClient.readContract({
          abi: erc20Abi,
          address: ADDRESSES.weth,
          functionName: "balanceOf",
          args: [account],
        });
        const shortfall = amountRaw > wethBal ? amountRaw - wethBal : 0n;
        if (shortfall > 0n) {
          setPhase({ stage: "working", message: "Wrapping ETH → WETH…" });
          hashes.push(await wrapEth(account, shortfall));
        }
      }

      let receivedWeth: bigint | null = null;
      let wethBefore: bigint | null = null;
      if (isNative(tokenOut.address)) {
        wethBefore = await publicClient.readContract({
          abi: erc20Abi,
          address: ADDRESSES.weth,
          functionName: "balanceOf",
          args: [account],
        });
      }

      // Step 2: the swap itself.
      step = "swap";
      if (quote.venue === "curve") {
        const hs = await executeCurveTrade(
          quote,
          account,
          slippageBps,
          (m) => setPhase({ stage: "working", message: m }),
        );
        hashes.push(...hs);
      } else {
        setPhase({ stage: "working", message: "Preparing best route…" });
        const prepared = await prepareRoute(quote, account);
        const result = await executeRouteTrade(prepared, (m) =>
          setPhase({ stage: "working", message: m }),
        );
        hashes.push(result.hash);
        receivedWeth = result.amountReceived;
      }

      // Step 3: unwrap WETH back to ETH when the user asked for ETH out.
      if (isNative(tokenOut.address)) {
        step = "unwrap";
        if (wethBefore !== null) {
          unwrapRef.current = { wethBefore, hashes: [...hashes] };
        }
        let toUnwrap = receivedWeth;
        if (toUnwrap === null && wethBefore !== null) {
          const wethAfter = await publicClient.readContract({
            abi: erc20Abi,
            address: ADDRESSES.weth,
            functionName: "balanceOf",
            args: [account],
          });
          toUnwrap = wethAfter > wethBefore ? wethAfter - wethBefore : 0n;
        }
        if (toUnwrap && toUnwrap > 0n) {
          setPhase({ stage: "working", message: "Unwrapping WETH → ETH…" });
          hashes.push(await unwrapWeth(account, toUnwrap));
        }
      }

      unwrapRef.current = null;
      setPhase({
        stage: "done",
        hashes,
        note: `Swapped ${formatAmount(amountRaw, tokenIn.decimals, tokenIn.symbol)} → ${tokenOut.symbol}.`,
      });
      setAmountIn("");
      setQuote(null);
      fetchBalances();
    } catch (e) {
      const classified = classifyWalletError(e);
      if (step === "unwrap" && unwrapRef.current) {
        unwrapRef.current.hashes = [...hashes];
      }
      setPhase({
        stage: "error",
        message: classified.message,
        kind: classified.kind,
        failedStep: step,
      });
    }
  };

  /** Resume only the unwrap step after the swap already succeeded. */
  const retryUnwrap = async () => {
    if (!account || !unwrapRef.current) return;
    setPhase({ stage: "working", message: "Unwrapping WETH → ETH…" });
    try {
      const { wethBefore, hashes } = unwrapRef.current;
      const wethAfter = await publicClient.readContract({
        abi: erc20Abi,
        address: ADDRESSES.weth,
        functionName: "balanceOf",
        args: [account],
      });
      const toUnwrap = wethAfter > wethBefore ? wethAfter - wethBefore : 0n;
      const all = [...hashes];
      if (toUnwrap > 0n) {
        all.push(await unwrapWeth(account, toUnwrap));
      }
      unwrapRef.current = null;
      setPhase({
        stage: "done",
        hashes: all,
        note:
          toUnwrap > 0n
            ? "Unwrapped the received WETH back to ETH."
            : "Nothing left to unwrap — the swap already settled.",
      });
      setAmountIn("");
      setQuote(null);
      fetchBalances();
    } catch (e) {
      const classified = classifyWalletError(e);
      setPhase({
        stage: "error",
        message: classified.message,
        kind: classified.kind,
        failedStep: "unwrap",
      });
    }
  };

  const expectedOut =
    quote?.venue === "curve"
      ? quote.amountOut
      : quote?.venue === "route"
        ? quote.quote.expectedAmountOut
        : null;
  const minimumOut =
    quote?.venue === "curve"
      ? quote.minimumAmountOut
      : quote?.venue === "route"
        ? quote.quote.minimumAmountOut
        : null;
  const priceImpact =
    quote?.venue === "route" ? quote.quote.priceImpactBps : null;

  const insufficient =
    amountRaw !== null &&
    balanceIn !== null &&
    amountRaw > 0n &&
    amountRaw > balanceIn;

  // A curve quote that cannot fill the full amount would revert (curve
  // trades are all-or-nothing). Block the swap and tell the user to size down.
  const partialFill =
    quote !== null && quote.venue === "curve" && quote.amountLeft > 0n;

  const canSwap =
    account !== null &&
    tokenOut !== null &&
    amountRaw !== null &&
    amountRaw > 0n &&
    quote !== null &&
    !insufficient &&
    !partialFill &&
    phase.stage !== "working";

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Swap</h2>
        <span className="muted">
          Best route across Ammora pools · launch curves included
        </span>
      </div>

      <div className="swap-box">
        <label className="field-label">
          You pay
          {balanceIn !== null && (
            <span className="balance">
              Balance: {formatAmount(balanceIn, tokenIn.decimals)}{" "}
              <button className="link-btn" onClick={setMax}>
                MAX
              </button>
            </span>
          )}
        </label>
        <div className="swap-row">
          <input
            className="amount-input"
            inputMode="decimal"
            placeholder="0.0"
            value={amountIn}
            onChange={(e) => setAmountIn(e.target.value)}
          />
          <button
            className="token-btn"
            onClick={() => setPicker("in")}
          >
            <TokenIcon address={tokenIn.address} size={22} />
            {tokenIn.symbol} ▾
          </button>
        </div>

        <div className="flip-row">
          <button className="flip-btn" onClick={flip} title="Flip direction">
            ↓
          </button>
        </div>

        <label className="field-label">
          You receive (estimated)
          {balanceOut !== null && tokenOut && (
            <span className="balance">
              Balance: {formatAmount(balanceOut, tokenOut.decimals)}
            </span>
          )}
        </label>
        <div className="swap-row">
          <input
            className="amount-input"
            readOnly
            placeholder="0.0"
            value={
              tokenOut && expectedOut !== null
                ? formatAmount(expectedOut, tokenOut.decimals)
                : ""
            }
          />
          <button
            className="token-btn"
            onClick={() => setPicker("out")}
          >
            {tokenOut ? (
              <>
                <TokenIcon address={tokenOut.address} size={22} />
                {tokenOut.symbol} ▾
              </>
            ) : (
              "Select token ▾"
            )}
          </button>
        </div>

        <div className="slippage-row">
          <span>Slippage</span>
          <div className="slippage-presets">
            {SLIPPAGE_PRESETS.map((bps) => (
              <button
                key={bps}
                className={`chip ${slippageBps === bps ? "chip-active" : ""}`}
                onClick={() => setSlippageBps(bps)}
              >
                {bps / 100}%
              </button>
            ))}
            <input
              className="slippage-custom"
              placeholder="Custom %"
              value={customSlippage}
              onChange={(e) => setCustomSlippage(e.target.value)}
              onBlur={applyCustomSlippage}
            />
          </div>
        </div>

        {venue && tokenOut && (
          <div className="venue-line">
            Venue:{" "}
            {venue.kind === "curve" ? (
              <>
                Launch curve{" "}
                <span className="mono">
                  {shortAddress(venue.launch.curve)}
                </span>{" "}
                · {venue.baseForQuote ? "Sell" : "Buy"}
              </>
            ) : (
              "Best route across discovered ARL pools"
            )}
          </div>
        )}

        {quoting && <p className="muted">Fetching quote…</p>}
        {quoteError && <p className="error-text">{quoteError}</p>}

        {quote && tokenOut && (
          <div className="quote-details">
            <div className="kv">
              <span>Expected</span>
              <strong>
                {formatAmount(
                  expectedOut ?? 0n,
                  tokenOut.decimals,
                  tokenOut.symbol,
                )}
              </strong>
            </div>
            <div className="kv">
              <span>Minimum received</span>
              <span>
                {formatAmount(
                  minimumOut ?? 0n,
                  tokenOut.decimals,
                  tokenOut.symbol,
                )}
              </span>
            </div>
            {quote.venue === "curve" && (
              <div className="kv">
                <span>Curve fee</span>
                <span>
                  {formatAmount(
                    quote.fee,
                    quote.baseForQuote
                      ? tokenOut.decimals
                      : tokenIn.decimals,
                  )}
                </span>
              </div>
            )}
            {partialFill && quote.venue === "curve" && (
              <p className="error-text">
                ⚠️ The curve can only fill part of this amount (
                {formatAmount(quote.amountLeft, tokenIn.decimals)} unfilled).
                Reduce the amount to trade.
              </p>
            )}
            {quote.venue === "route" && (
              <>
                <div className="kv">
                  <span>Price impact</span>
                  <span>
                    {priceImpact !== null
                      ? formatPct(priceImpact)
                      : "—"}
                  </span>
                </div>
                <div className="kv">
                  <span>Route</span>
                  <span>{quote.quote.hops.length} hop(s)</span>
                </div>
                <div className="route-map">
                  {quote.quote.hops.map((hop, i) => (
                    <div key={i} className="route-hop">
                      <span className="route-hop-model">{hop.model}</span>
                      <span className="mono">
                        {shortAddress(hop.tokenIn)} →{" "}
                        {shortAddress(hop.tokenOut)}
                      </span>
                      <span className="muted">
                        via {shortAddress(hop.pool)}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="kv">
                  <span>Quote block</span>
                  <span className="mono">
                    #{quote.quote.quoteBlockNumber.toString()}
                  </span>
                </div>
              </>
            )}
            {isNative(tokenIn.address) && (
              <p className="muted">
                ETH is wrapped to WETH automatically when your WETH balance
                is short — only the missing amount is wrapped.
              </p>
            )}
            {isNative(tokenOut.address) && (
              <p className="muted">
                WETH received is unwrapped back to ETH automatically.
              </p>
            )}
          </div>
        )}

        {insufficient && (
          <p className="error-text">Amount exceeds your balance.</p>
        )}

        <button
          className="btn btn-primary btn-wide"
          onClick={execute}
          disabled={!canSwap}
        >
          {!account
            ? "Connect wallet to swap"
            : !tokenOut
              ? "Select a token"
              : !amountRaw || amountRaw === 0n
                ? "Enter an amount"
                : insufficient
                  ? "Insufficient balance"
                  : quoting
                    ? "Fetching quote…"
                    : quote === null
                      ? "No route available"
                      : phase.stage === "working"
                        ? "Swapping…"
                        : "Swap"}
        </button>

        {phase.stage === "working" && (
          <p className="status-line">⏳ {phase.message}</p>
        )}
        {phase.stage === "done" && (
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
        )}
        {phase.stage === "error" && (
          <div className="wallet-error-box" role="alert">
            <p className="error-text">❌ {phase.message}</p>
            <WalletErrorHint kind={phase.kind} />
            <button
              type="button"
              className="btn btn-small"
              onClick={
                phase.failedStep === "unwrap" ? retryUnwrap : execute
              }
            >
              {phase.failedStep === "unwrap"
                ? "Retry unwrap"
                : "Retry swap"}
            </button>
          </div>
        )}
      </div>

      <TokenPicker
        open={picker !== null}
        onClose={() => setPicker(null)}
        title={picker === "in" ? "Pay with" : "Receive"}
        knownTokens={knownTokens}
        exclude={
          picker === "in"
            ? tokenOut?.address
            : picker === "out"
              ? tokenIn.address
              : undefined
        }
        onSelect={(t) => {
          if (picker === "in") {
            setTokenIn(t);
            if (tokenOut?.address.toLowerCase() === t.address.toLowerCase()) {
              setTokenOut(null);
            }
          } else {
            setTokenOut(t);
          }
          setQuote(null);
        }}
      />
    </div>
  );
}

function friendlyQuoteError(message: string): string {
  if (/no route/i.test(message)) {
    return "No route found for this pair — no discovered pool connects these two tokens yet.";
  }
  if (/insufficient/i.test(message)) {
    return "Not enough liquidity for this size on the available route.";
  }
  return message.length > 220 ? `${message.slice(0, 220)}…` : message;
}
