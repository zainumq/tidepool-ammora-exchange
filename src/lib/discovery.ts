/**
 * On-chain discovery, with no Data API dependency:
 *
 * - Launch curves: `LaunchCreated` events on the V4 launch factory, scanned in
 *   9,000-block chunks (the GIWA RPC caps eth_getLogs at 10,000 blocks) with
 *   bounded concurrency. Results are cached in localStorage and later scans
 *   only cover new blocks.
 * - ARL pools: the SDK's own `AmmoraRouteClient.discoverPools()`, which reads
 *   and authenticates every supported pool from finalized RPC logs. If that
 *   fails or takes too long (observed 2026-11-24: the SDK's verification
 *   reads can throw on a launch-curve candidate, and a second attempt ran
 *   30+ minutes without returning), the fallback scans `PoolCreated` events
 *   on the concentrated + compounding factories directly — the event args
 *   carry pool/base/quote, so no per-pool verification call is needed.
 */
import {
  AmmoraV4LaunchCurveClient,
  ammCompoundingFactoryV3Abi,
  ammConcentratedFactoryV3Abi,
  ammoraLaunchFactoryV4Abi,
  type AmmoraDiscoveredPool,
} from "@ammora-protocol/sdk";
import type { Address } from "viem";
import {
  ADDRESSES,
  LOG_CHUNK,
  LOG_CONCURRENCY,
  START_BLOCK,
} from "./chain";
import { getRouteClient, publicClient } from "./client";

export interface LaunchRecord {
  token: Address;
  curve: Address;
  creator: Address;
  configId: string;
  blockNumber: string;
}

export interface CurveState {
  baseToken: Address;
  quoteToken: Address;
  creator: Address;
  status: number;
  currentFeeBps: number;
  baseReserve: bigint;
  quoteReserve: bigint;
  migrationQuoteThreshold: bigint;
  migrationBaseThreshold: bigint;
  canonicalPool: Address;
  sqrtPrice: bigint;
  asOfBlock: bigint;
}

export interface MigrationProgress {
  ready: boolean;
  migrated: boolean;
  current: bigint;
  target: bigint;
  progressBps: number;
  canonicalPool: Address;
}

export interface EnrichedLaunch extends LaunchRecord {
  state: CurveState | null;
  progress: MigrationProgress | null;
  /** True when the curve state could not be read at all. */
  unreadable: boolean;
}

const LAUNCH_CACHE_KEY = "tidepool.launches.v1";
const POOL_CACHE_KEY = "tidepool.pools.v1";
const POOL_CHECKPOINT_KEY = "tidepool.pools.checkpoint.v1";

interface LaunchCache {
  lastBlock: string;
  launches: LaunchRecord[];
}

function readLaunchCache(): LaunchCache {
  try {
    const raw = localStorage.getItem(LAUNCH_CACHE_KEY);
    if (!raw) return { lastBlock: (START_BLOCK - 1n).toString(), launches: [] };
    const parsed = JSON.parse(raw) as LaunchCache;
    if (!Array.isArray(parsed.launches) || typeof parsed.lastBlock !== "string") {
      return { lastBlock: (START_BLOCK - 1n).toString(), launches: [] };
    }
    return parsed;
  } catch {
    return { lastBlock: (START_BLOCK - 1n).toString(), launches: [] };
  }
}

function writeLaunchCache(cache: LaunchCache): void {
  try {
    localStorage.setItem(LAUNCH_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* storage full — the in-memory result still works */
  }
}

export interface ScanProgress {
  done: number;
  total: number;
  found: number;
}

/**
 * Scan (or re-scan) launch history. On the first run this walks the whole
 * deployment history; later runs only cover blocks after the cached head.
 * `onProgress` fires after every batch so the UI can show a progress bar.
 */
export async function scanLaunches(
  onProgress?: (progress: ScanProgress) => void,
): Promise<LaunchRecord[]> {
  const cache = readLaunchCache();
  const head = await publicClient.getBlockNumber();
  const fromBlock = BigInt(cache.lastBlock) + 1n;
  const found = [...cache.launches];

  // Chunks the cache already covers, so the progress bar reflects the
  // resumed position instead of restarting at 0 on every refresh.
  const cachedSpan = BigInt(cache.lastBlock) - START_BLOCK + 1n;
  const baseChunks =
    cachedSpan > 0n ? Number((cachedSpan + LOG_CHUNK - 1n) / LOG_CHUNK) : 0;

  if (fromBlock > head) return found;

  const ranges: Array<[bigint, bigint]> = [];
  for (let from = fromBlock; from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
    ranges.push([from, to]);
  }

  let done = 0;
  for (let i = 0; i < ranges.length; i += LOG_CONCURRENCY) {
    const batch = ranges.slice(i, i + LOG_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ([from, to]) => {
        try {
          return await publicClient.getContractEvents({
            abi: ammoraLaunchFactoryV4Abi,
            address: ADDRESSES.launchFactory,
            eventName: "LaunchCreated",
            fromBlock: from,
            toBlock: to,
          });
        } catch {
          // One failed chunk must not poison the whole scan. It stays
          // unscanned (lastBlock is not advanced past it) and is retried on
          // the next refresh.
          return null;
        }
      }),
    );
    let batchOk = true;
    for (let j = 0; j < results.length; j++) {
      const logs = results[j];
      if (logs === null) {
        batchOk = false;
        continue;
      }
      for (const log of logs) {
        found.push({
          token: log.args.token as Address,
          curve: log.args.curve as Address,
          creator: log.args.creator as Address,
          configId: (log.args.configId as bigint).toString(),
          blockNumber: log.blockNumber.toString(),
        });
      }
    }
    done += batch.length;
    onProgress?.({ done: baseChunks + done, total: baseChunks + ranges.length, found: found.length });
    // Advance the cache only over fully successful batches, in order.
    if (batchOk) {
      const lastTo = batch[batch.length - 1][1];
      writeLaunchCache({ lastBlock: lastTo.toString(), launches: found });
    } else {
      break;
    }
  }
  return found;
}

/** Newest launches first. */
export function sortLaunches(launches: LaunchRecord[]): LaunchRecord[] {
  return [...launches].sort(
    (a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)),
  );
}

export function curveClient(curve: Address): AmmoraV4LaunchCurveClient {
  return new AmmoraV4LaunchCurveClient(publicClient, curve, {
    launchFactory: ADDRESSES.launchFactory,
    feePolicy: ADDRESSES.feePolicy,
  });
}

export async function enrichLaunch(
  launch: LaunchRecord,
): Promise<EnrichedLaunch> {
  try {
    const client = curveClient(launch.curve);
    const state = await client.getState();
    let progress: MigrationProgress | null = null;
    try {
      progress = await client.getMigrationProgressAtBlock(state.asOfBlock);
    } catch {
      progress = null;
    }
    return {
      ...launch,
      state: {
        baseToken: state.baseToken,
        quoteToken: state.quoteToken,
        creator: state.creator,
        status: state.status,
        currentFeeBps: state.currentFeeBps,
        baseReserve: state.baseReserve,
        quoteReserve: state.quoteReserve,
        migrationQuoteThreshold: state.migrationQuoteThreshold,
        migrationBaseThreshold: state.migrationBaseThreshold,
        canonicalPool: state.canonicalPool,
        sqrtPrice: state.sqrtPrice,
        asOfBlock: state.asOfBlock,
      },
      progress,
      unreadable: false,
    };
  } catch {
    return { ...launch, state: null, progress: null, unreadable: true };
  }
}

/** Enrich many launches with bounded concurrency. Failures stay as rows. */
export async function enrichLaunches(
  launches: LaunchRecord[],
  onProgress?: (done: number, total: number) => void,
): Promise<EnrichedLaunch[]> {
  const out: EnrichedLaunch[] = [];
  const CONCURRENCY = 6;
  for (let i = 0; i < launches.length; i += CONCURRENCY) {
    const batch = launches.slice(i, i + CONCURRENCY);
    const enriched = await Promise.all(batch.map(enrichLaunch));
    out.push(...enriched);
    onProgress?.(out.length, launches.length);
  }
  return out;
}

export type DiscoveredPool = AmmoraDiscoveredPool;

interface PoolCache {
  atBlock: string;
  pools: Array<{
    model: string;
    pool: string;
    baseToken: string;
    quoteToken: string;
    factory: string;
    creationBlock: string;
  }>;
}

function readPoolCache(): PoolCache | null {
  try {
    const raw = localStorage.getItem(POOL_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PoolCache;
  } catch {
    return null;
  }
}

type SerializedPool = PoolCache["pools"][number];

function serializePools(pools: readonly DiscoveredPool[]): SerializedPool[] {
  return pools.map((p) => ({
    model: p.model,
    pool: p.pool,
    baseToken: p.baseToken,
    quoteToken: p.quoteToken,
    factory: p.factory,
    creationBlock: p.creationBlock.toString(),
  }));
}

function writePoolCache(pools: readonly DiscoveredPool[], atBlock: bigint): void {
  try {
    const cache: PoolCache = {
      atBlock: atBlock.toString(),
      pools: serializePools(pools),
    };
    localStorage.setItem(POOL_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* ignore cache failures */
  }
}

function rehydratePoolCache(cached: PoolCache): DiscoveredPool[] {
  return cached.pools.map((p) => ({
    model: p.model as AmmoraDiscoveredPool["model"],
    pool: p.pool as Address,
    baseToken: p.baseToken as Address,
    quoteToken: p.quoteToken as Address,
    factory: p.factory as Address,
    factoryId: "",
    creationBlock: BigInt(p.creationBlock),
    creationTransaction:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    creationLogIndex: 0,
    runtimeCodeHash: "0x",
    verifiedAtBlock: BigInt(cached.atBlock),
    source: "rpc",
  })) as DiscoveredPool[];
}

/**
 * In-progress checkpoint for the factory-log pool scan: the last fully
 * scanned block, how many chunks that covers, and the pools found so far.
 * Written after each fully successful batch so a reload resumes instead of
 * restarting the whole ~660-chunk walk. Checkpointed pools are partial
 * results, never presented as a complete scan — only a scan that finishes
 * writes the pool cache (see discoverPools), and the checkpoint is cleared
 * when it does.
 */
interface PoolCheckpoint {
  lastBlock: string;
  chunksDone: number;
  pools: SerializedPool[];
}

function readPoolCheckpoint(): PoolCheckpoint | null {
  try {
    const raw = localStorage.getItem(POOL_CHECKPOINT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PoolCheckpoint;
    if (
      typeof parsed.lastBlock !== "string" ||
      !/^\d+$/.test(parsed.lastBlock) ||
      typeof parsed.chunksDone !== "number" ||
      !Number.isInteger(parsed.chunksDone) ||
      parsed.chunksDone < 0 ||
      !Array.isArray(parsed.pools) ||
      parsed.pools.some(
        (p) =>
          typeof p?.model !== "string" ||
          typeof p?.pool !== "string" ||
          typeof p?.baseToken !== "string" ||
          typeof p?.quoteToken !== "string" ||
          typeof p?.factory !== "string" ||
          typeof p?.creationBlock !== "string" ||
          !/^\d+$/.test(p.creationBlock),
      )
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writePoolCheckpoint(
  lastBlock: bigint,
  chunksDone: number,
  pools: readonly DiscoveredPool[],
): void {
  try {
    const checkpoint: PoolCheckpoint = {
      lastBlock: lastBlock.toString(),
      chunksDone,
      pools: serializePools(pools),
    };
    localStorage.setItem(POOL_CHECKPOINT_KEY, JSON.stringify(checkpoint));
  } catch {
    /* ignore cache failures */
  }
}

function clearPoolCheckpoint(): void {
  try {
    localStorage.removeItem(POOL_CHECKPOINT_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Fallback pool discovery: scan `PoolCreated` on both ARL factories. The
 * event args carry pool/base/quote, so this needs no per-pool verification
 * call — it succeeds even when the SDK's authenticated discovery throws on a
 * malformed candidate. `complete` is false when a chunk failed, in which case
 * the caller must not cache the (partial) result.
 *
 * The scan resumes from the last checkpoint (`tidepool.pools.checkpoint.v1`)
 * instead of restarting from the deployment block: progress is checkpointed
 * after each fully successful batch, and the reported done/total counts from
 * the checkpoint so the progress bar stays continuous across reloads.
 */
async function discoverPoolsFromFactoryLogs(
  onProgress?: (progress: ScanProgress) => void,
): Promise<{ pools: DiscoveredPool[]; complete: boolean }> {
  const head = await publicClient.getBlockNumber();
  const checkpoint = readPoolCheckpoint();
  let startBlock = START_BLOCK;
  let baseChunks = 0;
  const found: DiscoveredPool[] = [];
  const seen = new Set<string>();
  if (
    checkpoint &&
    BigInt(checkpoint.lastBlock) >= START_BLOCK - 1n &&
    BigInt(checkpoint.lastBlock) < head
  ) {
    startBlock = BigInt(checkpoint.lastBlock) + 1n;
    baseChunks = checkpoint.chunksDone;
    for (const p of rehydratePoolCache({
      atBlock: checkpoint.lastBlock,
      pools: checkpoint.pools,
    })) {
      found.push(p);
      seen.add(p.pool.toLowerCase());
    }
  }
  const ranges: Array<[bigint, bigint]> = [];
  for (let from = startBlock; from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
    ranges.push([from, to]);
  }
  let done = 0;
  let complete = true;
  const factories = [
    { model: "concentrated" as const, abi: ammConcentratedFactoryV3Abi, address: ADDRESSES.concentratedFactory },
    { model: "compounding" as const, abi: ammCompoundingFactoryV3Abi, address: ADDRESSES.compoundingFactory },
  ];
  for (let i = 0; i < ranges.length; i += LOG_CONCURRENCY) {
    const batch = ranges.slice(i, i + LOG_CONCURRENCY);
    const results = await Promise.all(
      batch.flatMap(([from, to]) =>
        factories.map(async (f) => {
          try {
            return await publicClient.getContractEvents({
              abi: f.abi,
              address: f.address,
              eventName: "PoolCreated",
              fromBlock: from,
              toBlock: to,
            });
          } catch {
            return null;
          }
        }),
      ),
    );
    let batchOk = true;
    for (let j = 0; j < results.length; j++) {
      const logs = results[j];
      if (logs === null) {
        batchOk = false;
        complete = false;
        continue;
      }
      const factory = factories[j % factories.length];
      for (const log of logs) {
        const pool = log.args.pool as Address;
        const key = pool.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({
          model: factory.model,
          pool,
          baseToken: log.args.baseToken as Address,
          quoteToken: log.args.quoteToken as Address,
          factory: factory.address,
          factoryId: "",
          creationBlock: log.blockNumber,
          creationTransaction: log.transactionHash,
          creationLogIndex: log.logIndex,
          runtimeCodeHash: "0x",
          verifiedAtBlock: head,
          source: "rpc",
        });
      }
    }
    done += batch.length;
    onProgress?.({ done: baseChunks + done, total: baseChunks + ranges.length, found: found.length });
    // Checkpoint only over fully successful batches, in order — the
    // checkpoint's lastBlock is always the end of a contiguous scanned prefix.
    if (batchOk) {
      writePoolCheckpoint(batch[batch.length - 1][1], baseChunks + done, found);
    } else {
      break;
    }
  }
  if (complete) clearPoolCheckpoint();
  return { pools: found, complete };
}

/** Reject `promise` if it does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() =>
    clearTimeout(timer),
  );
}

/** Give the SDK's authenticated discovery 2 minutes, then fall back. */
const SDK_DISCOVERY_TIMEOUT_MS = 120_000;

/**
 * Discover ARL pools via the SDK route client, with a direct factory-log
 * fallback when the SDK's authenticated discovery fails or times out. The
 * result is cached; a cached result is returned immediately unless
 * `forceRefresh`.
 */
export async function discoverPools(
  forceRefresh = false,
  onProgress?: (progress: ScanProgress) => void,
): Promise<DiscoveredPool[]> {
  const cached = readPoolCache();
  if (cached && !forceRefresh) {
    return rehydratePoolCache(cached);
  }
  // A forced refresh rebuilds from scratch — drop any in-progress checkpoint
  // so the rescan does not resume from stale partial state.
  if (forceRefresh) clearPoolCheckpoint();
  try {
    const routes = await getRouteClient();
    const pools = await withTimeout(
      routes.discoverPools(),
      SDK_DISCOVERY_TIMEOUT_MS,
      "SDK pool discovery",
    );
    const head = await publicClient.getBlockNumber();
    writePoolCache(pools, head);
    clearPoolCheckpoint();
    return [...pools];
  } catch (sdkError) {
    // SDK discovery threw or timed out (e.g. a verification read on a bad
    // candidate). Fall back to raw factory logs instead of failing the tab.
    console.warn("SDK pool discovery failed, using factory-log fallback:", sdkError);
    const { pools, complete } = await discoverPoolsFromFactoryLogs(onProgress);
    if (complete) {
      const head = await publicClient.getBlockNumber();
      writePoolCache(pools, head);
    }
    return pools;
  }
}

/**
 * Spot price (quote per 1 base) implied by a Q64.64 sqrt price, adjusted for
 * token decimals. Display only — never used for trade math.
 *
 * Ammora sqrtPrice is Q64.64 (verified live on the KPTEST curve 24 Nov 2026),
 * NOT Uniswap V3's Q64.96 — dividing by 2^96 understates the price by 2^64.
 */
export function priceFromSqrt(
  sqrtPrice: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): number {
  const sqrt = Number(sqrtPrice) / 2 ** 64;
  const price = sqrt * sqrt;
  return price * 10 ** (baseDecimals - quoteDecimals);
}

/**
 * Price impact of a launch-curve trade in basis points, mirroring the SDK's
 * own `cpAmmPriceImpactBps` formula: |execution price - spot price| / spot
 * price, with spot = sqrtPrice^2 (Q64.64, raw quote-per-base units) and the
 * execution price from the quoted amounts. `baseForQuote` is true when the
 * input is the base (launched) token (a sell). `amountIn` must be the
 * *consumed* amount from the quote (amountLeft excluded), not the requested
 * amount. Returns null when the impact cannot be computed (zero or negative
 * inputs) so the UI hides it instead of inventing a number. The fee is not
 * adjusted for — same as the SDK helper — so the figure is conservative (it
 * includes the fee drag); the fee is shown separately next to the quote.
 * (Route quotes already carry the SDK's own `priceImpactBps`; this helper is
 * only for the curve venue.)
 */
export function curvePriceImpactBps(
  amountIn: bigint,
  amountOut: bigint,
  sqrtPrice: bigint,
  baseForQuote: boolean,
): bigint | null {
  if (sqrtPrice <= 0n || amountIn <= 0n || amountOut <= 0n) return null;
  const Q128 = 1n << 128n;
  const spotPriceX128 = sqrtPrice * sqrtPrice;
  const executionNumerator = baseForQuote ? amountOut * Q128 : amountIn * Q128;
  const executionDenominator = baseForQuote ? amountIn : amountOut;
  const spotNumerator = spotPriceX128 * executionDenominator;
  const difference =
    executionNumerator > spotNumerator
      ? executionNumerator - spotNumerator
      : spotNumerator - executionNumerator;
  return (difference * 10000n) / spotNumerator;
}
