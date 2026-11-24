/**
 * GIWA Sepolia (chain 91342) + the reviewed Ammora auto-route V4 deployment.
 *
 * All contract addresses come from the published SDK catalog
 * (`giwaSepoliaAutoRouteDeployment`) — nothing here is hand-typed, so the app
 * cannot drift from the reviewed generation.
 *
 * RPC: GIWA Sepolia has a single public RPC (chainlist confirms no second
 * public endpoint), so the app cannot fail over to another public node.
 * Instead it (1) retries each read, (2) always keeps the official endpoint
 * as fallback, and (3) lets the visitor enter their own GIWA Sepolia RPC
 * (validated as chain 91342 before use) — so a blocked or down official
 * RPC never leaves the app with no way to read the chain.
 */
import {
  giwaSepoliaAutoRoute,
  giwaSepoliaAutoRouteCatalog,
  giwaSepoliaAutoRouteDeployment,
  giwaSepoliaAutoRouteDeploymentCatalog,
  giwaSepoliaAutoRoutePoolProfiles,
} from "@ammora-protocol/sdk";
import { createPublicClient, defineChain, http, type Address } from "viem";

export const CHAIN_ID = 91342;
/** The single public GIWA Sepolia RPC — always kept as the last fallback. */
export const DEFAULT_RPC_URL = "https://sepolia-rpc.giwa.io";
/** Kept for existing imports; the effective list lives in getRpcUrls(). */
export const RPC_URL = DEFAULT_RPC_URL;
export const EXPLORER_URL = "https://sepolia-explorer.giwa.io";

/** Reviewed deployment slot, e.g. "v4-auto-route-20260917". */
export const DEPLOYMENT = giwaSepoliaAutoRouteDeployment;
export const ROUTE_DEPLOYMENT = giwaSepoliaAutoRoute;
export const ROUTE_CATALOG = giwaSepoliaAutoRouteCatalog;
export const DEPLOYMENT_CATALOG = giwaSepoliaAutoRouteDeploymentCatalog;
export const FACTORY_PROFILES = giwaSepoliaAutoRoutePoolProfiles;

/** First block of the reviewed deployment — log scans start here. */
export const START_BLOCK = BigInt(DEPLOYMENT.startBlock);

/** GIWA Sepolia RPC caps eth_getLogs at a 10,000-block range. Stay under it. */
export const LOG_CHUNK = 9_000n;
/** Parallel log requests per batch. */
export const LOG_CONCURRENCY = 6;

const launch = DEPLOYMENT.contracts.launch;
if (launch.protocolVersion !== 4) {
  throw new Error("Tidepool requires the Ammora V4 launch deployment");
}

export const ADDRESSES = {
  launchFactory: launch.factory as Address,
  configRegistry: launch.configRegistry as Address,
  feePolicy: launch.feePolicy as Address,
  graduationAdapter: launch.graduationAdapter as Address,
  concentratedFactory: launch.concentratedFactory as Address,
  concentratedPositionManager: launch.concentratedPositionManager as Address,
  compoundingFactory: launch.compoundingFactory as Address,
  weth: DEPLOYMENT.contracts.tokens.wrappedNative as Address,
  zapRouter: DEPLOYMENT.contracts.routers.zap as Address,
  nativeRouter: DEPLOYMENT.contracts.routers.native as Address,
} as const;

export const giwaSepolia = defineChain({
  id: CHAIN_ID,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "GIWA Explorer", url: EXPLORER_URL } },
  testnet: true,
});

// ---------------------------------------------------------------------------
// RPC configuration (custom endpoint support)
// ---------------------------------------------------------------------------

const CUSTOM_RPC_KEY = "tidepool:custom-rpc-url";

/** Visitor-supplied RPC endpoint, if one was saved and still looks valid. */
export function getCustomRpcUrl(): string | null {
  try {
    const raw = localStorage.getItem(CUSTOM_RPC_KEY);
    if (!raw) return null;
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    return raw;
  } catch {
    return null;
  }
}

/** Effective RPC list: a validated custom endpoint first, official endpoint always last. */
export function getRpcUrls(): string[] {
  const custom = getCustomRpcUrl();
  return custom && custom !== DEFAULT_RPC_URL ? [custom, DEFAULT_RPC_URL] : [DEFAULT_RPC_URL];
}

export function setCustomRpcUrl(url: string): void {
  try {
    localStorage.setItem(CUSTOM_RPC_KEY, url);
  } catch {
    // Storage unavailable — the setting is lost on reload.
  }
}

export function clearCustomRpcUrl(): void {
  try {
    localStorage.removeItem(CUSTOM_RPC_KEY);
  } catch {
    // ignore
  }
}

/** Check a candidate RPC answers as GIWA Sepolia (chain 91342) before trusting it. */
export async function validateRpcUrl(
  url: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Not a valid URL." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Only https:// RPC URLs are accepted." };
  }
  try {
    const probe = createPublicClient({
      chain: giwaSepolia,
      transport: http(url, { timeout: 15_000, retryCount: 0 }),
    });
    const chainId = await probe.getChainId();
    if (chainId !== CHAIN_ID) {
      return { ok: false, error: `This endpoint reports chain ${chainId}, not GIWA Sepolia (${CHAIN_ID}).` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.split("\n")[0] : "RPC did not respond." };
  }
}

/** Minimal ERC-20 read ABI (symbol / decimals / name / balance / allowance). */
export const erc20Abi = [
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** WETH wrap / unwrap. */
export const wethAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

export const explorerTx = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const explorerAddress = (address: string) =>
  `${EXPLORER_URL}/address/${address}`;
export const explorerToken = (address: string) =>
  `${EXPLORER_URL}/token/${address}`;
