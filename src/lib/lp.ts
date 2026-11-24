/**
 * LP Manager: discover and operate the connected wallet's ARL positions.
 *
 * Two namespaces that must never be confused (the docs warn about this
 * explicitly):
 * - Concentrated positions are ERC-721s on the POSITION MANAGER. A manager
 *   token id means something else on the pool itself.
 * - Compounding positions are ERC-721s on the POOL contract itself.
 *
 * Listing works by scanning ERC-721 `Transfer` events to the owner and then
 * re-reading `ownerOf` for every candidate, because a transfer-in does not
 * mean the wallet still holds the token.
 */
import {
  AmmConcentratedV3PositionDelegatePermission,
  DammV2Client,
  ammCompoundingPoolV3Abi,
  ammConcentratedPoolV3Abi,
  ammConcentratedPositionManagerV3Abi,
} from "@ammora-protocol/sdk";
import type { Address } from "viem";
import {
  ADDRESSES,
  LOG_CHUNK,
  LOG_CONCURRENCY,
  START_BLOCK,
} from "./chain";
import { clientOptions, deadline, publicClient } from "./client";
import type { DiscoveredPool } from "./discovery";

const erc721TransferAbi = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: true, name: "tokenId", type: "uint256" },
    ],
  },
] as const;

export interface PoolState {
  baseToken: Address;
  quoteToken: Address;
  sqrtPrice: bigint;
  reserveBase: bigint;
  reserveQuote: bigint;
  totalLiquidity: bigint;
  currentFeeBps: number;
}

export interface ConcentratedPosition {
  kind: "concentrated";
  tokenId: bigint;
  pool: Address;
  poolPositionId: bigint;
  unlockedLiquidity: bigint;
  vestedLiquidity: bigint;
  permanentLockedLiquidity: bigint;
  /** Fees owed right now (simulated claim — stored counters lag). */
  feeBaseOwed: bigint;
  feeQuoteOwed: bigint;
  rewardsOwed: readonly [bigint, bigint];
  delegate: Address;
  delegatePermission: number;
  poolState: PoolState;
}

export interface CompoundingPosition {
  kind: "compounding";
  tokenId: bigint;
  pool: Address;
  liquidity: bigint;
  lockReleasePoint: bigint;
  permanentlyLocked: boolean;
  /** Quote-denominated fees owed right now (simulated claim). */
  feeQuoteOwed: bigint;
  poolState: PoolState;
}

export type LpPosition = ConcentratedPosition | CompoundingPosition;

export function dammClient(
  pool: Address,
  kind: "concentrated" | "compounding",
): DammV2Client {
  return new DammV2Client(
    publicClient,
    pool,
    kind,
    kind === "concentrated"
      ? ADDRESSES.concentratedFactory
      : ADDRESSES.compoundingFactory,
    kind === "concentrated" ? ADDRESSES.concentratedPositionManager : undefined,
    clientOptions(),
  );
}

export async function getPoolState(
  pool: Address,
  kind: "concentrated" | "compounding",
): Promise<PoolState> {
  return dammClient(pool, kind).getPoolState();
}

/** Scan ERC-721 transfers TO an owner on one contract, in 9k-block chunks. */
async function scanReceivedTokenIds(
  contract: Address,
  owner: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Set<bigint>> {
  const received = new Set<bigint>();
  const ranges: Array<[bigint, bigint]> = [];
  for (let from = fromBlock; from <= toBlock; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > toBlock ? toBlock : from + LOG_CHUNK - 1n;
    ranges.push([from, to]);
  }
  for (let i = 0; i < ranges.length; i += LOG_CONCURRENCY) {
    const batch = ranges.slice(i, i + LOG_CONCURRENCY);
    const results = await Promise.all(
      batch.map(([from, to]) =>
        publicClient
          .getContractEvents({
            abi: erc721TransferAbi,
            address: contract,
            eventName: "Transfer",
            args: { to: owner },
            fromBlock: from,
            toBlock: to,
          })
          .catch(() => []),
      ),
    );
    for (const logs of results) {
      for (const log of logs) {
        const tokenId = (log.args as { tokenId?: bigint }).tokenId;
        if (tokenId !== undefined) received.add(tokenId);
      }
    }
  }
  return received;
}

async function isStillOwner(
  contract: Address,
  abi: typeof ammConcentratedPositionManagerV3Abi,
  tokenId: bigint,
  owner: Address,
  head: bigint,
): Promise<boolean> {
  try {
    const current = await publicClient.readContract({
      abi,
      address: contract,
      functionName: "ownerOf",
      args: [tokenId],
      blockNumber: head,
    });
    return (current as string).toLowerCase() === owner.toLowerCase();
  } catch {
    // A revert means the token does not exist (burned) — not owned.
    return false;
  }
}

async function simulateManagedFees(
  tokenId: bigint,
  owner: Address,
  head: bigint,
): Promise<readonly [bigint, bigint]> {
  try {
    const { result } = await publicClient.simulateContract({
      abi: ammConcentratedPositionManagerV3Abi,
      account: owner,
      address: ADDRESSES.concentratedPositionManager,
      functionName: "claimPositionFees",
      args: [tokenId, owner],
      blockNumber: head,
    });
    return result as readonly [bigint, bigint];
  } catch {
    return [0n, 0n];
  }
}

async function simulateCompoundingFees(
  pool: Address,
  tokenId: bigint,
  owner: Address,
  head: bigint,
): Promise<bigint> {
  try {
    const { result } = await publicClient.simulateContract({
      abi: ammCompoundingPoolV3Abi,
      account: owner,
      address: pool,
      functionName: "claimPositionFees",
      args: [tokenId, owner],
      blockNumber: head,
    });
    return result as bigint;
  } catch {
    return 0n;
  }
}

export interface PositionScanProgress {
  stage: string;
  done: number;
  total: number;
}

/** List concentrated (manager NFT) positions held by `owner`. */
export async function listConcentratedPositions(
  owner: Address,
): Promise<ConcentratedPosition[]> {
  const head = await publicClient.getBlockNumber();
  const received = await scanReceivedTokenIds(
    ADDRESSES.concentratedPositionManager,
    owner,
    START_BLOCK,
    head,
  );
  const out: ConcentratedPosition[] = [];
  for (const tokenId of [...received].sort((a, b) => (a < b ? -1 : 1))) {
    const held = await isStillOwner(
      ADDRESSES.concentratedPositionManager,
      ammConcentratedPositionManagerV3Abi,
      tokenId,
      owner,
      head,
    );
    if (!held) continue;
    try {
      const position = (await publicClient.readContract({
        abi: ammConcentratedPositionManagerV3Abi,
        address: ADDRESSES.concentratedPositionManager,
        functionName: "getPosition",
        args: [tokenId],
        blockNumber: head,
      })) as {
        pool: Address;
        poolPositionId: bigint;
        unlockedLiquidity: bigint;
        vestedLiquidity: bigint;
        permanentLockedLiquidity: bigint;
        feeBaseOwed: bigint;
        feeQuoteOwed: bigint;
        rewardsOwed: readonly [bigint, bigint];
      };
      const [fees, delegate, permission, poolState] = await Promise.all([
        simulateManagedFees(tokenId, owner, head),
        publicClient.readContract({
          abi: ammConcentratedPositionManagerV3Abi,
          address: ADDRESSES.concentratedPositionManager,
          functionName: "positionDelegate",
          args: [tokenId],
          blockNumber: head,
        }),
        publicClient.readContract({
          abi: ammConcentratedPositionManagerV3Abi,
          address: ADDRESSES.concentratedPositionManager,
          functionName: "delegatePermission",
          args: [tokenId],
          blockNumber: head,
        }),
        getPoolState(position.pool, "concentrated"),
      ]);
      out.push({
        kind: "concentrated",
        tokenId,
        pool: position.pool,
        poolPositionId: position.poolPositionId,
        unlockedLiquidity: position.unlockedLiquidity,
        vestedLiquidity: position.vestedLiquidity,
        permanentLockedLiquidity: position.permanentLockedLiquidity,
        feeBaseOwed: fees[0],
        feeQuoteOwed: fees[1],
        rewardsOwed: position.rewardsOwed,
        delegate: delegate as Address,
        delegatePermission: Number(permission),
        poolState,
      });
    } catch {
      // One unreadable position must not hide the rest.
      continue;
    }
  }
  return out;
}

/** List compounding (pool NFT) positions across discovered compounding pools. */
export async function listCompoundingPositions(
  owner: Address,
  pools: readonly DiscoveredPool[],
  onProgress?: (progress: PositionScanProgress) => void,
): Promise<CompoundingPosition[]> {
  const compounding = pools.filter((p) => p.model === "compounding");
  const head = await publicClient.getBlockNumber();
  const out: CompoundingPosition[] = [];
  let done = 0;
  for (const pool of compounding) {
    onProgress?.({
      stage: `Scanning ${pool.pool.slice(0, 10)}…`,
      done,
      total: compounding.length,
    });
    const received = await scanReceivedTokenIds(
      pool.pool,
      owner,
      pool.creationBlock,
      head,
    );
    for (const tokenId of [...received].sort((a, b) => (a < b ? -1 : 1))) {
      const held = await isStillOwner(
        pool.pool,
        ammCompoundingPoolV3Abi as never,
        tokenId,
        owner,
        head,
      );
      if (!held) continue;
      try {
        const position = (await publicClient.readContract({
          abi: ammCompoundingPoolV3Abi,
          address: pool.pool,
          functionName: "getPosition",
          args: [tokenId],
          blockNumber: head,
        })) as unknown as {
          liquidity: bigint;
          // uint40 decodes as number in the SDK's ABI typing.
          lockReleasePoint: bigint | number;
          permanentlyLocked: boolean;
        };
        const [fees, poolState] = await Promise.all([
          simulateCompoundingFees(pool.pool, tokenId, owner, head),
          getPoolState(pool.pool, "compounding"),
        ]);
        out.push({
          kind: "compounding",
          tokenId,
          pool: pool.pool,
          liquidity: position.liquidity,
          lockReleasePoint: BigInt(position.lockReleasePoint),
          permanentlyLocked: position.permanentlyLocked,
          feeQuoteOwed: fees,
          poolState,
        });
      } catch {
        continue;
      }
    }
    done += 1;
  }
  onProgress?.({ stage: "Done", done, total: compounding.length });
  return out;
}

/* ------------------------------------------------------------------ */
/* Action planners — each returns planned transactions + approvals for */
/* the shared executePlan() helper. Nothing here sends anything.       */
/* ------------------------------------------------------------------ */

export interface LpPlan {
  transactions: Array<{ to: Address; data: `0x${string}`; value?: bigint }>;
  approvalRequirements: Array<{
    token: Address;
    spender: Address;
    amount: bigint;
  }>;
  summary: string;
}

function toPlan(
  tx: { to: `0x${string}`; data: `0x${string}`; value?: bigint },
  approvals: readonly {
    token: `0x${string}`;
    spender: `0x${string}`;
    amount: bigint;
  }[] = [],
  summary: string,
): LpPlan {
  return {
    transactions: [
      {
        to: tx.to as Address,
        data: tx.data,
        value: tx.value ?? 0n,
      },
    ],
    approvalRequirements: approvals.map((a) => ({
      token: a.token as Address,
      spender: a.spender as Address,
      amount: a.amount,
    })),
    summary,
  };
}

export async function planAddLiquidity(
  position: LpPosition,
  caller: Address,
  maxBase: bigint,
  maxQuote: bigint,
  slippageBps: number,
): Promise<LpPlan> {
  const sdk = dammClient(position.pool, position.kind);
  if (position.kind === "concentrated") {
    const plan = await sdk.planAddLiquidityToManagedConcentratedPosition({
      tokenId: position.tokenId,
      caller,
      maximumBaseAmount: maxBase,
      maximumQuoteAmount: maxQuote,
      slippageBps,
      deadline: deadline(),
    });
    return toPlan(
      plan.transaction,
      plan.approvalRequirements,
      `Add liquidity to managed position #${position.tokenId}`,
    );
  }
  const plan = await sdk.planAddLiquidityToPosition({
    tokenId: position.tokenId,
    caller,
    maximumBaseAmount: maxBase,
    maximumQuoteAmount: maxQuote,
    slippageBps,
    deadline: deadline(),
  });
  return toPlan(
    plan.transaction,
    plan.approvalRequirements,
    `Add liquidity to compounding position #${position.tokenId}`,
  );
}

export async function planRemoveLiquidity(
  position: LpPosition,
  caller: Address,
  liquidity: bigint,
  slippageBps: number,
): Promise<LpPlan> {
  const sdk = dammClient(position.pool, position.kind);
  if (position.kind === "concentrated") {
    const plan = await sdk.planRemoveManagedConcentratedLiquidity({
      tokenId: position.tokenId,
      caller,
      liquidity,
      slippageBps,
      recipient: caller,
      deadline: deadline(),
    });
    return toPlan(plan.transaction, [], `Remove liquidity from #${position.tokenId}`);
  }
  const plan = await sdk.planRemoveLiquidity({
    tokenId: position.tokenId,
    liquidity,
    slippageBps,
    caller,
    recipient: caller,
    deadline: deadline(),
  });
  return toPlan(plan.transaction, [], `Remove liquidity from #${position.tokenId}`);
}

export async function planClaimFees(
  position: LpPosition,
  caller: Address,
  recipient: Address,
): Promise<LpPlan> {
  const sdk = dammClient(position.pool, position.kind);
  if (position.kind === "concentrated") {
    const tx = await sdk.planClaimManagedConcentratedFees(
      position.tokenId,
      recipient,
      caller,
    );
    return toPlan(tx, [], `Claim fees from #${position.tokenId}`);
  }
  const tx = await sdk.planClaimCompoundingFees(
    position.tokenId,
    recipient,
    caller,
  );
  return toPlan(tx, [], `Claim fees from #${position.tokenId}`);
}

/** Grant or revoke fee-only delegation on a concentrated position. */
export async function planFeeDelegate(
  position: ConcentratedPosition,
  caller: Address,
  delegate: Address,
  mode: "claim-fee" | "claim-fee-to-owner" | "revoke",
): Promise<LpPlan> {
  const sdk = dammClient(position.pool, "concentrated");
  const permission =
    mode === "revoke"
      ? 0
      : mode === "claim-fee"
        ? AmmConcentratedV3PositionDelegatePermission.ClaimFee
        : AmmConcentratedV3PositionDelegatePermission.ClaimFeeToOwner;
  const tx = await sdk.planUpdateDelegatePermission(
    position.tokenId,
    delegate,
    permission,
    caller,
  );
  return toPlan(
    tx,
    [],
    mode === "revoke"
      ? `Revoke fee delegate on #${position.tokenId}`
      : `Grant ${mode} to ${delegate.slice(0, 10)}… on #${position.tokenId}`,
  );
}

/**
 * Split a concentrated position, moving `percent`% of every part (unlocked,
 * locked, fees, rewards, vesting) to `recipient`.
 */
export async function planSplitPosition(
  position: ConcentratedPosition,
  caller: Address,
  recipient: Address,
  percent: number,
): Promise<LpPlan> {
  const DENOMINATOR = 1_000_000_000;
  const numerator = Math.round((percent / 100) * DENOMINATOR);
  const sdk = dammClient(position.pool, "concentrated");
  const tx = await sdk.planSplitManagedConcentratedPosition({
    tokenId: position.tokenId,
    caller,
    split: {
      unlockedLiquidityNumerator: numerator,
      permanentLockedLiquidityNumerator: numerator,
      feeBaseNumerator: numerator,
      feeQuoteNumerator: numerator,
      reward0Numerator: numerator,
      reward1Numerator: numerator,
      innerVestingLiquidityNumerator: numerator,
    },
    recipient,
    deadline: deadline(),
  });
  return toPlan(
    tx,
    [],
    `Split ${percent}% of #${position.tokenId} to ${recipient.slice(0, 10)}…`,
  );
}

/** Open a brand-new position in a pool (concentrated = managed NFT). */
export async function planCreatePosition(
  pool: Address,
  kind: "concentrated" | "compounding",
  caller: Address,
  maxBase: bigint,
  maxQuote: bigint,
  slippageBps: number,
): Promise<LpPlan> {
  const sdk = dammClient(pool, kind);
  if (kind === "concentrated") {
    const plan = await sdk.planCreateAndAddManagedConcentratedPosition({
      maximumBaseAmount: maxBase,
      maximumQuoteAmount: maxQuote,
      slippageBps,
      recipient: caller,
      deadline: deadline(),
    });
    return toPlan(
      plan.transaction,
      plan.approvalRequirements,
      "Create a new managed concentrated position",
    );
  }
  const plan = await sdk.planAddLiquidity({
    maximumBaseAmount: maxBase,
    maximumQuoteAmount: maxQuote,
    slippageBps,
    recipient: caller,
    deadline: deadline(),
  });
  return toPlan(
    plan.transaction,
    plan.approvalRequirements,
    "Create a new compounding position",
  );
}

/**
 * Zap-in: swap part of a single input token, then open a new LP position
 * with the pair. The router is verified against the reviewed deployment.
 */
export async function planZapIn(
  pool: Address,
  kind: "concentrated" | "compounding",
  tokenIn: Address,
  amountIn: bigint,
  swapAmount: bigint,
  slippageBps: number,
  recipient: Address,
): Promise<LpPlan & { quote: { amountOut: bigint; minimumLiquidity: bigint } }> {
  const sdk = dammClient(pool, kind);
  const plan = await sdk.planZapIn({
    tokenIn,
    amountIn,
    swapAmount,
    slippageBps,
    recipient,
    deadline: deadline(),
    lockDuration: 0,
    permanentLock: false,
  });
  if (plan.router.toLowerCase() !== ADDRESSES.zapRouter.toLowerCase()) {
    throw new Error("Zap router differs from the reviewed deployment");
  }
  return {
    ...toPlan(plan.transaction, plan.approvalRequirements, "Zap into a new LP position"),
    quote: {
      amountOut: plan.quote.amountOut,
      minimumLiquidity: plan.quote.minimumLiquidity,
    },
  };
}

/** Quote helpers for the add/remove forms. */
export async function quoteAdd(
  pool: Address,
  kind: "concentrated" | "compounding",
  maxBase: bigint,
  maxQuote: bigint,
  slippageBps: number,
) {
  return dammClient(pool, kind).quoteAddLiquidity(maxBase, maxQuote, slippageBps);
}

export async function quoteRemove(
  pool: Address,
  kind: "concentrated" | "compounding",
  liquidity: bigint,
  slippageBps: number,
) {
  return dammClient(pool, kind).quoteRemoveLiquidity(liquidity, slippageBps);
}

/** Read the pool-level position count helper (unused by UI, kept for tests). */
export function poolAbiFor(kind: "concentrated" | "compounding") {
  return kind === "concentrated"
    ? ammConcentratedPoolV3Abi
    : ammCompoundingPoolV3Abi;
}
