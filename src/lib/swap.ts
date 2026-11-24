/**
 * Swap quoting and execution across two venues:
 *
 * - Launch curves (pre-graduation): `AmmoraV4LaunchCurveClient` — buy with
 *   WETH (`baseForQuote: false`) or sell the base token (`baseForQuote:
 *   true`). `baseForQuote` means "the input amount is denominated in the base
 *   (launched) token".
 * - Graduated ARL pools: `AmmoraRouteClient` finds the best route across all
 *   discovered pools; the prepared route executes with exact approvals.
 *
 * Native ETH is wrapped to WETH before the swap and unwrapped after it, so
 * every venue sees the ERC-20 quote asset it expects.
 */
import {
  AmmoraRouteClient,
  resolveAmmoraFinalizedHead,
  type AmmoraPreparedRoute,
  type AmmoraRouteQuote,
} from "@ammora-protocol/sdk";
import { encodeFunctionData, type Address, type Hash } from "viem";
import {
  ADDRESSES,
  CHAIN_ID,
  DEPLOYMENT_CATALOG,
  FACTORY_PROFILES,
  ROUTE_CATALOG,
  ROUTE_DEPLOYMENT,
  getRpcUrls,
  wethAbi,
} from "./chain";
import { deadline, getWalletClient, publicClient } from "./client";
import {
  curveClient,
  type DiscoveredPool,
  type EnrichedLaunch,
} from "./discovery";
import { isNative, isWeth, NATIVE_ETH } from "./tokens";
import { ensureApprovals, sendPlanned } from "./tx";
import { WALLET_FLOW_TIMEOUT_MS, withWalletTimeout } from "./walletError";

export interface CurveQuote {
  venue: "curve";
  curve: Address;
  token: Address;
  baseForQuote: boolean;
  amountIn: bigint;
  amountOut: bigint;
  fee: bigint;
  minimumAmountOut: bigint;
  /** Amount the curve could not consume (graduation boundary). */
  amountLeft: bigint;
}

export interface RouteQuoteView {
  venue: "route";
  quote: AmmoraRouteQuote;
}

export type SwapQuote = CurveQuote | RouteQuoteView;

export function curveForToken(
  token: Address,
  launches: readonly EnrichedLaunch[],
): EnrichedLaunch | undefined {
  return launches.find(
    (l) =>
      l.token.toLowerCase() === token.toLowerCase() &&
      l.state !== null &&
      l.progress !== null &&
      !l.progress.migrated,
  );
}

function isQuoteSide(address: Address): boolean {
  return isWeth(address) || isNative(address);
}

/**
 * Pick the venue for a pair. A launch token against WETH/ETH trades on its
 * bonding curve; everything else routes across ARL pools.
 */
export function pickVenue(
  tokenIn: Address,
  tokenOut: Address,
  launches: readonly EnrichedLaunch[],
):
  | { kind: "curve"; launch: EnrichedLaunch; baseForQuote: boolean }
  | { kind: "route" } {
  const inLaunch = curveForToken(tokenIn, launches);
  const outLaunch = curveForToken(tokenOut, launches);
  if (inLaunch && isQuoteSide(tokenOut)) {
    return { kind: "curve", launch: inLaunch, baseForQuote: true };
  }
  if (outLaunch && isQuoteSide(tokenIn)) {
    return { kind: "curve", launch: outLaunch, baseForQuote: false };
  }
  return { kind: "route" };
}

export async function quoteCurve(
  launch: EnrichedLaunch,
  amountIn: bigint,
  baseForQuote: boolean,
  slippageBps: number,
): Promise<CurveQuote> {
  const client = curveClient(launch.curve);
  const q = await client.quoteExactInput(amountIn, baseForQuote);
  const minimumAmountOut =
    (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  return {
    venue: "curve",
    curve: launch.curve,
    token: launch.token,
    baseForQuote,
    amountIn: q.amountIn,
    amountOut: q.amountOut,
    fee: q.fee,
    minimumAmountOut,
    amountLeft: q.amountLeft,
  };
}

let quotingClient:
  | { key: string; client: AmmoraRouteClient }
  | null = null;

/** Route client bound to the discovered pool inventory (rebuilt when it changes). */
async function getQuotingClient(pools: readonly DiscoveredPool[]) {
  const key = pools
    .map((p) => `${p.model}:${p.pool.toLowerCase()}`)
    .sort()
    .join("|");
  if (quotingClient && quotingClient.key === key) return quotingClient.client;
  const verificationBlock = await resolveAmmoraFinalizedHead(
    [publicClient],
    ROUTE_DEPLOYMENT.finality,
  );
  const client = await AmmoraRouteClient.create({
    chainId: CHAIN_ID,
    rpcUrls: getRpcUrls(),
    routeCatalog: ROUTE_CATALOG,
    deploymentCatalog: DEPLOYMENT_CATALOG,
    factoryProfiles: FACTORY_PROFILES,
    pools: pools.map((p) => ({
      model: p.model,
      pool: p.pool,
      baseToken: p.baseToken,
      quoteToken: p.quoteToken,
    })),
    verificationBlock,
  });
  quotingClient = { key, client };
  return client;
}

export async function quoteRoute(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps: number,
  pools: readonly DiscoveredPool[],
  recipient?: Address,
): Promise<RouteQuoteView> {
  const client = await getQuotingClient(pools);
  const quote = await client.quoteExactIn({
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps,
    recipient,
  });
  return { venue: "route", quote };
}

export async function prepareRoute(
  view: RouteQuoteView,
  payer: Address,
): Promise<AmmoraPreparedRoute> {
  // prepareExactIn must run on the client that produced the quote.
  const quoting = quotingClient?.client;
  if (!quoting) throw new Error("Quoting client is not ready");
  return quoting.prepareExactIn(view.quote, {
    payer,
    recipient: payer,
    executionMode: "direct-wallet",
  });
}

export interface WrapStep {
  kind: "wrap" | "unwrap";
  amount: bigint;
}

/** Wrap exact ETH into WETH. Returns the tx hash. */
export async function wrapEth(
  account: Address,
  amount: bigint,
): Promise<Hash> {
  const wallet = getWalletClient();
  return sendPlanned(wallet, account, {
    to: ADDRESSES.weth,
    data: encodeFunctionData({ abi: wethAbi, functionName: "deposit" }),
    value: amount,
  });
}

/** Unwrap WETH back to native ETH. Returns the tx hash. */
export async function unwrapWeth(
  account: Address,
  amount: bigint,
): Promise<Hash> {
  const wallet = getWalletClient();
  return sendPlanned(wallet, account, {
    to: ADDRESSES.weth,
    data: encodeFunctionData({
      abi: wethAbi,
      functionName: "withdraw",
      args: [amount],
    }),
  });
}

/** Execute a curve trade: exact approval, then the planned swap. */
export async function executeCurveTrade(
  quote: CurveQuote,
  account: Address,
  slippageBps: number,
  onStatus: (message: string) => void,
): Promise<Hash[]> {
  // Defense in depth: the plan below is all-or-nothing (allowPartialFill is
  // false), so a quote that cannot fill the full amount would revert after
  // the user signs. Refuse before any signing happens.
  if (quote.amountLeft > 0n) {
    throw new Error(
      "The curve cannot fill this full amount — only part of it is available. Reduce the amount and try again.",
    );
  }
  const wallet = getWalletClient();
  const client = curveClient(quote.curve);
  onStatus("Planning curve trade…");
  const plan = await client.planSwapExactInput({
    includedAmountIn: quote.amountIn,
    baseForQuote: quote.baseForQuote,
    // Partial fills only make sense at the graduation boundary; ordinary
    // orders stay all-or-nothing so the user never silently under-fills.
    allowPartialFill: false,
    slippageBps,
    recipient: account,
    deadline: deadline(),
  });
  const hashes: Hash[] = [];
  const approvalHashes = await ensureApprovals(
    wallet,
    account,
    plan.approvalRequirements,
    onStatus,
  );
  hashes.push(...approvalHashes);
  onStatus("Sending swap — confirm in your wallet");
  hashes.push(
    await sendPlanned(wallet, account, {
      to: plan.transaction.to as Address,
      data: plan.transaction.data as `0x${string}`,
    }),
  );
  return hashes;
}

/** Execute a prepared route (approvals handled by the SDK). */
export async function executeRouteTrade(
  prepared: AmmoraPreparedRoute,
  onStatus: (message: string) => void,
): Promise<{ hash: Hash; amountReceived: bigint | null }> {
  const wallet = getWalletClient();
  // The SDK's execute runs approvals + swap + receipt waits as one flow;
  // give the whole flow a generous budget so a hung wallet request still
  // fails visibly instead of hanging forever.
  const result = await withWalletTimeout(
    prepared.execute(wallet, {
      sendApprovals: true,
      exactApproval: true,
      simulate: true,
      autoRefresh: true,
      onStatus: (status) => onStatus(describeRouteStatus(status)),
    }),
    WALLET_FLOW_TIMEOUT_MS,
  );
  return { hash: result.hash, amountReceived: result.amountReceived };
}

function describeRouteStatus(status: unknown): string {
  if (typeof status === "object" && status !== null && "kind" in status) {
    const kind = (status as { kind?: unknown }).kind;
    if (typeof kind === "string") return `Swap: ${kind}`;
  }
  return "Swap in progress…";
}

/** The ERC-20 actually traded when the user picks native ETH. */
export function erc20For(address: Address): Address {
  return isNative(address) ? ADDRESSES.weth : address;
}

export { NATIVE_ETH };
