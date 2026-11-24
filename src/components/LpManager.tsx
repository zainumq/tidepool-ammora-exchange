import { useCallback, useEffect, useState } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { explorerAddress } from "../lib/chain";
import { getWalletClient } from "../lib/client";
import type { DiscoveredPool } from "../lib/discovery";
import {
  listCompoundingPositions,
  listConcentratedPositions,
  planAddLiquidity,
  planClaimFees,
  planFeeDelegate,
  planRemoveLiquidity,
  planSplitPosition,
  quoteRemove,
  type CompoundingPosition,
  type ConcentratedPosition,
  type LpPosition,
} from "../lib/lp";
import {
  formatAmount,
  formatPct,
  parseAmount,
  shortAddress,
  type TokenInfo,
} from "../lib/tokens";
import { executePlan } from "../lib/tx";
import {
  classifyWalletError,
  describeWalletError,
} from "../lib/walletError";
import { PhaseView, type Phase } from "./PoolList";
import { TokenIcon } from "./TokenIcon";

interface LpManagerProps {
  account: Address | null;
  pools: readonly DiscoveredPool[];
  tokenInfos: Map<string, TokenInfo>;
  poolsLoaded: boolean;
}

export function LpManager({
  account,
  pools,
  tokenInfos,
  poolsLoaded,
}: LpManagerProps) {
  const [positions, setPositions] = useState<LpPosition[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);

  const scan = useCallback(async () => {
    if (!account) return;
    setScanning(true);
    setScanned(false);
    setScanStatus("Scanning the position manager for your NFTs…");
    try {
      const concentrated = await listConcentratedPositions(account);
      setPositions([...concentrated]);
      setScanStatus(
        `Found ${concentrated.length} concentrated position(s). Scanning compounding pools…`,
      );
      const compounding = await listCompoundingPositions(
        account,
        pools,
        (p) => setScanStatus(`${p.stage} (${p.done}/${p.total})`),
      );
      setPositions([...concentrated, ...compounding]);
      setScanned(true);
      setScanStatus(null);
    } catch (e) {
      setScanStatus(
        `Scan failed: ${e instanceof Error ? e.message : "unknown error"}`,
      );
    } finally {
      setScanning(false);
    }
  }, [account, pools]);

  useEffect(() => {
    if (account && poolsLoaded) {
      scan();
    } else {
      setPositions([]);
      setScanned(false);
    }
  }, [account, poolsLoaded, scan]);

  const totalFees = positions.reduce(
    (acc, p) => {
      if (p.kind === "concentrated") {
        return {
          base: acc.base + p.feeBaseOwed,
          quote: acc.quote + p.feeQuoteOwed,
        };
      }
      return { base: acc.base, quote: acc.quote + p.feeQuoteOwed };
    },
    { base: 0n, quote: 0n },
  );

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>My LP positions</h2>
        <button
          className="btn btn-ghost"
          onClick={scan}
          disabled={!account || scanning}
        >
          {scanning ? "Scanning…" : "Rescan"}
        </button>
      </div>
      <p className="muted">
        Concentrated positions live on the position manager as NFTs;
        compounding positions live on their pool. Both are discovered by
        scanning ERC-721 transfers to your wallet and re-verifying ownership —
        the two id namespaces are never mixed.
      </p>

      {!account && (
        <p className="muted">
          Connect your wallet to see the LP positions it holds.
        </p>
      )}
      {account && scanStatus && <p className="status-line">⏳ {scanStatus}</p>}
      {account && scanned && positions.length === 0 && (
        <p className="muted">
          No LP positions found for this wallet. Open one from the Pools tab —
          or zap in with a single token.
        </p>
      )}

      {positions.length > 0 && (
        <div className="lp-summary">
          <span>
            {positions.length} position(s) ·{" "}
            {positions.filter((p) => p.kind === "concentrated").length}{" "}
            concentrated ·{" "}
            {positions.filter((p) => p.kind === "compounding").length}{" "}
            compounding
          </span>
          <span className="muted">
            Unclaimed fees across positions are shown per card (assets differ
            per pool).
          </span>
          <span>
            Total owed (raw): base {totalFees.base.toString()} · quote{" "}
            {totalFees.quote.toString()}
          </span>
        </div>
      )}

      <div className="position-grid">
        {positions.map((p) => (
          <PositionCard
            key={`${p.kind}:${p.pool}:${p.tokenId}`}
            position={p}
            account={account}
            tokenInfos={tokenInfos}
            onDone={scan}
          />
        ))}
      </div>
    </div>
  );
}

function PositionCard({
  position,
  account,
  tokenInfos,
  onDone,
}: {
  position: LpPosition;
  account: Address | null;
  tokenInfos: Map<string, TokenInfo>;
  onDone: () => void;
}) {
  const [action, setAction] = useState<
    "add" | "remove" | "claim" | "delegate" | "split" | null
  >(null);
  const base = tokenInfos.get(position.poolState.baseToken.toLowerCase());
  const quote = tokenInfos.get(position.poolState.quoteToken.toLowerCase());

  const totalLiquidity =
    position.kind === "concentrated"
      ? position.unlockedLiquidity +
        position.vestedLiquidity +
        position.permanentLockedLiquidity
      : position.liquidity;

  return (
    <div className="position-card">
      <div className="position-head">
        <span className="pair-cell">
          <span className="token-pair">
            <TokenIcon address={position.poolState.baseToken} size={24} />
            <TokenIcon address={position.poolState.quoteToken} size={24} />
          </span>
          <strong>
            {base?.symbol ?? shortAddress(position.poolState.baseToken)} /{" "}
            {quote?.symbol ?? shortAddress(position.poolState.quoteToken)}
          </strong>
        </span>
        <span className="badge badge-live">{position.kind}</span>
      </div>
      <div className="muted small">
        NFT #{position.tokenId.toString()} · pool{" "}
        <a
          href={explorerAddress(position.pool)}
          target="_blank"
          rel="noreferrer"
        >
          {shortAddress(position.pool)} ↗
        </a>
      </div>

      <div className="quote-details">
        <div className="kv">
          <span>Liquidity</span>
          <span className="mono">{totalLiquidity.toString()}</span>
        </div>
        {position.kind === "concentrated" && (
          <>
            <div className="kv">
              <span>Unlocked / vesting / locked</span>
              <span className="mono small">
                {position.unlockedLiquidity.toString()} /{" "}
                {position.vestedLiquidity.toString()} /{" "}
                {position.permanentLockedLiquidity.toString()}
              </span>
            </div>
            <div className="kv">
              <span>Fees owed</span>
              <strong>
                {formatAmount(
                  position.feeBaseOwed,
                  base?.decimals ?? 18,
                  base?.symbol,
                )}{" "}
                ·{" "}
                {formatAmount(
                  position.feeQuoteOwed,
                  quote?.decimals ?? 18,
                  quote?.symbol,
                )}
              </strong>
            </div>
            <div className="kv">
              <span>Fee delegate</span>
              <span>
                {position.delegate ===
                "0x0000000000000000000000000000000000000000" ? (
                  "None"
                ) : (
                  <>
                    {shortAddress(position.delegate)} ·{" "}
                    {describePermission(position.delegatePermission)}
                  </>
                )}
              </span>
            </div>
          </>
        )}
        {position.kind === "compounding" && (
          <>
            <div className="kv">
              <span>Fees owed (quote)</span>
              <strong>
                {formatAmount(
                  position.feeQuoteOwed,
                  quote?.decimals ?? 18,
                  quote?.symbol,
                )}
              </strong>
            </div>
            <div className="kv">
              <span>Lock</span>
              <span>
                {position.permanentlyLocked
                  ? "Permanently locked"
                  : position.lockReleasePoint > 0n
                    ? `Until block ${position.lockReleasePoint.toString()}`
                    : "Unlocked"}
              </span>
            </div>
          </>
        )}
        <div className="kv">
          <span>Pool fee</span>
          <span>{formatPct(position.poolState.currentFeeBps)}</span>
        </div>
      </div>

      <div className="action-row">
        <button
          className="btn btn-ghost"
          onClick={() => setAction(action === "add" ? null : "add")}
        >
          Add
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => setAction(action === "remove" ? null : "remove")}
        >
          Remove
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => setAction(action === "claim" ? null : "claim")}
        >
          Claim fees
        </button>
        {position.kind === "concentrated" && (
          <>
            <button
              className="btn btn-ghost"
              onClick={() =>
                setAction(action === "delegate" ? null : "delegate")
              }
            >
              Delegate
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => setAction(action === "split" ? null : "split")}
            >
              Split
            </button>
          </>
        )}
      </div>

      {action === "add" && account && base && quote && (
        <AddForm
          position={position}
          account={account}
          base={base}
          quote={quote}
          onDone={onDone}
        />
      )}
      {action === "remove" && account && base && quote && (
        <RemoveForm
          position={position}
          account={account}
          base={base}
          quote={quote}
          onDone={onDone}
        />
      )}
      {action === "claim" && account && (
        <ClaimForm
          position={position}
          account={account}
          onDone={onDone}
        />
      )}
      {action === "delegate" &&
        account &&
        position.kind === "concentrated" && (
          <DelegateForm
            position={position}
            account={account}
            onDone={onDone}
          />
        )}
      {action === "split" &&
        account &&
        position.kind === "concentrated" && (
          <SplitForm
            position={position}
            account={account}
            onDone={onDone}
          />
        )}
    </div>
  );
}

function describePermission(permission: number): string {
  if (permission === 0) return "none";
  const names: string[] = [];
  if (permission & 8) names.push("claim-fee");
  if (permission & 16) names.push("claim-fee-to-owner");
  if (permission & 32) names.push("claim-reward");
  if (permission & 64) names.push("claim-reward-to-owner");
  if (permission & 1) names.push("add-liquidity");
  if (permission & 2) names.push("remove-liquidity");
  return names.length > 0 ? names.join(", ") : `code ${permission}`;
}

function AddForm({
  position,
  account,
  base,
  quote,
  onDone,
}: {
  position: LpPosition;
  account: Address;
  base: TokenInfo;
  quote: TokenInfo;
  onDone: () => void;
}) {
  const [maxBase, setMaxBase] = useState("");
  const [maxQuote, setMaxQuote] = useState("");
  const [phase, setPhase] = useState<Phase>({ stage: "idle" });
  const baseRaw = parseAmount(maxBase, base.decimals);
  const quoteRaw = parseAmount(maxQuote, quote.decimals);

  const submit = async () => {
    if (!baseRaw || !quoteRaw || baseRaw === 0n || quoteRaw === 0n) return;
    setPhase({ stage: "working", message: "Planning add-liquidity…" });
    try {
      const plan = await planAddLiquidity(
        position,
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
        note: "Liquidity added.",
      });
      onDone();
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
      <button
        className="btn btn-primary btn-wide"
        onClick={submit}
        disabled={
          !baseRaw || !quoteRaw || baseRaw === 0n || quoteRaw === 0n ||
          phase.stage === "working"
        }
      >
        Add liquidity
      </button>
      <PhaseView
        phase={phase}
        onRetry={phase.stage === "error" && phase.kind ? submit : undefined}
      />
    </div>
  );
}

function RemoveForm({
  position,
  account,
  base,
  quote,
  onDone,
}: {
  position: LpPosition;
  account: Address;
  base: TokenInfo;
  quote: TokenInfo;
  onDone: () => void;
}) {
  const [pct, setPct] = useState(50);
  const [preview, setPreview] = useState<{
    baseAmount: bigint;
    quoteAmount: bigint;
  } | null>(null);
  const [phase, setPhase] = useState<Phase>({ stage: "idle" });

  const removable =
    position.kind === "concentrated"
      ? position.unlockedLiquidity
      : position.liquidity;
  const liquidity = (removable * BigInt(pct)) / 100n;

  const getPreview = async () => {
    if (liquidity === 0n) return;
    try {
      const q = await quoteRemove(position.pool, position.kind, liquidity, 50);
      setPreview({ baseAmount: q.baseAmount, quoteAmount: q.quoteAmount });
    } catch (e) {
      // A quote failure is a read failure, not a wallet failure: no hint
      // and no Retry (the Preview button re-runs it).
      setPhase({ stage: "error", message: describeWalletError(e) });
    }
  };

  const submit = async () => {
    if (liquidity === 0n) return;
    setPhase({ stage: "working", message: "Planning removal…" });
    try {
      const plan = await planRemoveLiquidity(
        position,
        account,
        liquidity,
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
        note: `Removed ${pct}% of unlocked liquidity.`,
      });
      onDone();
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
      <label className="field-label">
        Remove {pct}% of unlocked liquidity ({removable.toString()} total)
      </label>
      <input
        type="range"
        min={1}
        max={100}
        value={pct}
        onChange={(e) => {
          setPct(Number(e.target.value));
          setPreview(null);
        }}
      />
      <button className="btn btn-ghost" onClick={getPreview}>
        Preview
      </button>
      {preview && (
        <div className="quote-details">
          <div className="kv">
            <span>You receive</span>
            <strong>
              {formatAmount(preview.baseAmount, base.decimals, base.symbol)} ·{" "}
              {formatAmount(preview.quoteAmount, quote.decimals, quote.symbol)}
            </strong>
          </div>
        </div>
      )}
      <button
        className="btn btn-sell btn-wide"
        onClick={submit}
        disabled={liquidity === 0n || phase.stage === "working"}
      >
        Remove liquidity
      </button>
      <PhaseView
        phase={phase}
        onRetry={phase.stage === "error" && phase.kind ? submit : undefined}
      />
    </div>
  );
}

function ClaimForm({
  position,
  account,
  onDone,
}: {
  position: LpPosition;
  account: Address;
  onDone: () => void;
}) {
  const [payout, setPayout] = useState("");
  const [phase, setPhase] = useState<Phase>({ stage: "idle" });

  const submit = async () => {
    const recipient =
      payout.trim() === ""
        ? account
        : isAddress(payout.trim())
          ? getAddress(payout.trim())
          : null;
    if (!recipient) {
      setPhase({ stage: "error", message: "Payout address is not valid." });
      return;
    }
    setPhase({ stage: "working", message: "Planning fee claim…" });
    try {
      const plan = await planClaimFees(position, account, recipient);
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
        note: `Fees claimed to ${shortAddress(recipient)}.`,
      });
      onDone();
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
      <label className="field-label">
        Payout address (optional — defaults to you)
      </label>
      <input
        className="input mono"
        placeholder="0x… (leave empty to pay yourself)"
        value={payout}
        onChange={(e) => setPayout(e.target.value)}
      />
      <p className="muted small">
        The payout wallet only receives the fees — NFT ownership, locked
        principal, and future fee rights stay with you.
      </p>
      <button
        className="btn btn-primary btn-wide"
        onClick={submit}
        disabled={phase.stage === "working"}
      >
        Claim fees
      </button>
      <PhaseView
        phase={phase}
        onRetry={phase.stage === "error" && phase.kind ? submit : undefined}
      />
    </div>
  );
}

function DelegateForm({
  position,
  account,
  onDone,
}: {
  position: ConcentratedPosition;
  account: Address;
  onDone: () => void;
}) {
  const [delegate, setDelegate] = useState("");
  const [mode, setMode] = useState<"claim-fee" | "claim-fee-to-owner">(
    "claim-fee",
  );
  const [phase, setPhase] = useState<Phase>({ stage: "idle" });
  // Whether the last submit was a revoke, so Retry re-runs the same side.
  const [lastRevoke, setLastRevoke] = useState(false);

  const submit = async (revoke: boolean) => {
    setLastRevoke(revoke);
    const target = revoke
      ? "0x0000000000000000000000000000000000000000"
      : isAddress(delegate.trim())
        ? getAddress(delegate.trim())
        : null;
    if (!target) {
      setPhase({ stage: "error", message: "Delegate address is not valid." });
      return;
    }
    if (!revoke && target.toLowerCase() === account.toLowerCase()) {
      setPhase({
        stage: "error",
        message: "The fee delegate must be a different address from the owner.",
      });
      return;
    }
    setPhase({
      stage: "working",
      message: revoke ? "Revoking delegate…" : "Granting delegate…",
    });
    try {
      const plan = await planFeeDelegate(
        position,
        account,
        target as Address,
        revoke ? "revoke" : mode,
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
        note: revoke ? "Fee delegate revoked." : "Fee delegate granted.",
      });
      onDone();
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
      <p className="muted small">
        Fee-only delegation: the delegate can claim this position&apos;s fees
        (optionally to a payout of their choice) but can never touch the
        principal or the NFT. Only the NFT owner can grant or revoke it.
      </p>
      <label className="field-label">Delegate address</label>
      <input
        className="input mono"
        placeholder="0x…"
        value={delegate}
        onChange={(e) => setDelegate(e.target.value)}
      />
      <div className="side-toggle">
        <button
          className={`btn ${mode === "claim-fee" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setMode("claim-fee")}
        >
          claim-fee (delegate picks payout)
        </button>
        <button
          className={`btn ${mode === "claim-fee-to-owner" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setMode("claim-fee-to-owner")}
        >
          claim-fee-to-owner
        </button>
      </div>
      <div className="action-row">
        <button
          className="btn btn-primary"
          onClick={() => submit(false)}
          disabled={phase.stage === "working"}
        >
          Grant
        </button>
        <button
          className="btn btn-sell"
          onClick={() => submit(true)}
          disabled={phase.stage === "working"}
        >
          Revoke current
        </button>
      </div>
      <PhaseView
        phase={phase}
        onRetry={
          phase.stage === "error" && phase.kind
            ? () => submit(lastRevoke)
            : undefined
        }
      />
    </div>
  );
}

function SplitForm({
  position,
  account,
  onDone,
}: {
  position: ConcentratedPosition;
  account: Address;
  onDone: () => void;
}) {
  const [recipient, setRecipient] = useState("");
  const [pct, setPct] = useState(50);
  const [phase, setPhase] = useState<Phase>({ stage: "idle" });

  const submit = async () => {
    if (!isAddress(recipient.trim())) {
      setPhase({ stage: "error", message: "Recipient address is not valid." });
      return;
    }
    if (pct <= 0 || pct >= 100) {
      setPhase({
        stage: "error",
        message: "Percent must be between 1 and 99 — a full transfer is just a transfer.",
      });
      return;
    }
    setPhase({ stage: "working", message: "Planning split…" });
    try {
      const plan = await planSplitPosition(
        position,
        account,
        getAddress(recipient.trim()),
        pct,
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
        note: `Split ${pct}% of position #${position.tokenId}.`,
      });
      onDone();
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
      <p className="muted small">
        Splits {pct}% of every part of the position — unlocked, locked, fees,
        rewards, vesting — into a new NFT for the recipient.
      </p>
      <label className="field-label">Recipient</label>
      <input
        className="input mono"
        placeholder="0x…"
        value={recipient}
        onChange={(e) => setRecipient(e.target.value)}
      />
      <label className="field-label">Share: {pct}%</label>
      <input
        type="range"
        min={1}
        max={99}
        value={pct}
        onChange={(e) => setPct(Number(e.target.value))}
      />
      <button
        className="btn btn-primary btn-wide"
        onClick={submit}
        disabled={phase.stage === "working"}
      >
        Split position
      </button>
      <PhaseView
        phase={phase}
        onRetry={phase.stage === "error" && phase.kind ? submit : undefined}
      />
    </div>
  );
}

export type { CompoundingPosition };
