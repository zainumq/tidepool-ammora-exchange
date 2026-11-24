/**
 * Token metadata (symbol / decimals / name) with a localStorage-backed cache,
 * plus amount formatting helpers.
 */
import { formatUnits, parseUnits, type Address } from "viem";
import { ADDRESSES, erc20Abi } from "./chain";
import { publicClient } from "./client";

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  name: string;
}

/** Native ETH is represented by the zero address throughout the UI. */
export const NATIVE_ETH: Address =
  "0x0000000000000000000000000000000000000000";

export const ETH_INFO: TokenInfo = {
  address: NATIVE_ETH,
  symbol: "ETH",
  decimals: 18,
  name: "Ether (GIWA Sepolia testnet)",
};

const CACHE_KEY = "tidepool.token-info.v1";
const memoryCache = new Map<string, TokenInfo>();

function loadDiskCache(): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, TokenInfo>;
    for (const [key, value] of Object.entries(parsed)) {
      memoryCache.set(key.toLowerCase(), value);
    }
  } catch {
    /* corrupted cache — ignore and rebuild */
  }
}

function saveDiskCache(): void {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify(Object.fromEntries(memoryCache)),
    );
  } catch {
    /* storage full or unavailable — memory cache still works */
  }
}

loadDiskCache();

function isUsableSymbol(symbol: string): boolean {
  return symbol.length > 0 && symbol.length <= 12 && !symbol.includes("\0");
}

export async function fetchTokenInfo(address: Address): Promise<TokenInfo> {
  const key = address.toLowerCase();
  if (key === NATIVE_ETH.toLowerCase()) return ETH_INFO;
  const cached = memoryCache.get(key);
  if (cached) return cached;
  const info: TokenInfo = {
    address,
    symbol: `${address.slice(0, 6)}…${address.slice(-4)}`,
    decimals: 18,
    name: "Unknown token",
  };
  try {
    const [symbol, decimals, name] = await Promise.all([
      publicClient
        .readContract({
          abi: erc20Abi,
          address,
          functionName: "symbol",
        })
        .catch(() => ""),
      publicClient
        .readContract({
          abi: erc20Abi,
          address,
          functionName: "decimals",
        })
        .catch(() => 18),
      publicClient
        .readContract({ abi: erc20Abi, address, functionName: "name" })
        .catch(() => ""),
    ]);
    if (typeof symbol === "string" && isUsableSymbol(symbol)) {
      info.symbol = symbol;
    }
    if (typeof decimals === "number") info.decimals = decimals;
    if (typeof name === "string" && name.length > 0) info.name = name;
  } catch {
    /* keep the fallback — the token may not be a standard ERC-20 */
  }
  memoryCache.set(key, info);
  saveDiskCache();
  return info;
}

/** Fetch many token infos with bounded concurrency. */
export async function fetchTokenInfos(
  addresses: readonly Address[],
): Promise<Map<string, TokenInfo>> {
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const out = new Map<string, TokenInfo>();
  const CONCURRENCY = 8;
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    const infos = await Promise.all(
      batch.map((a) => fetchTokenInfo(a as Address)),
    );
    for (const info of infos) out.set(info.address.toLowerCase(), info);
  }
  return out;
}

export function isWeth(address: Address): boolean {
  return address.toLowerCase() === ADDRESSES.weth.toLowerCase();
}

export function isNative(address: Address): boolean {
  return address.toLowerCase() === NATIVE_ETH.toLowerCase();
}

/** "0.0001 WETH" style rendering with adaptive precision. */
export function formatAmount(
  raw: bigint,
  decimals: number,
  symbol?: string,
): string {
  const value = formatUnits(raw, decimals);
  const num = Number(value);
  let shown: string;
  if (num === 0) shown = "0";
  else if (num < 0.000001) shown = "<0.000001";
  else if (num < 1) shown = trimZeros(value.slice(0, 10));
  else if (num < 1_000) shown = trimZeros(num.toFixed(4));
  else if (num < 1_000_000) shown = trimZeros(num.toFixed(2));
  else shown = num.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return symbol ? `${shown} ${symbol}` : shown;
}

function trimZeros(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

export function formatUsdish(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** Parse a human amount into raw units, or null when invalid. */
export function parseAmount(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (!trimmed || !/^\d*\.?\d*$/.test(trimmed)) return null;
  try {
    const parsed = parseUnits(trimmed === "" ? "0" : trimmed, decimals);
    return parsed;
  } catch {
    return null;
  }
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatPct(bps: number | bigint): string {
  return `${(Number(bps) / 100).toFixed(2)}%`;
}
