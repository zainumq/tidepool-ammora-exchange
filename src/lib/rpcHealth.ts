/**
 * RPC health probe for the status banner. The GIWA Sepolia public RPCs drop
 * connections intermittently, and when every endpoint is unreachable the
 * app's reads silently fail or hang. This probe answers one question —
 * "can the app read the chain right now?" — with a cheap eth_blockNumber
 * call against each effective RPC in order. It deliberately bypasses the
 * viem fallback transport: a single fast-failing probe per endpoint keeps
 * the check snappy (8s timeout, no retries), while real reads keep their
 * own retry policy.
 */
import { getRpcUrls } from "./chain";

/** How often the banner re-checks RPC health. */
export const PROBE_INTERVAL_MS = 30_000;
/** A single probe call fails fast so one dead endpoint never stalls the check. */
const PROBE_TIMEOUT_MS = 8_000;
/** Consecutive failed probes before the banner appears — one dropped connection is noise. */
export const FAILURES_TO_ALERT = 2;

async function probeUrl(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { result?: unknown };
    return typeof data.result === "string" && data.result.startsWith("0x");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** True when at least one effective RPC endpoint answers. */
export async function probeRpcHealth(): Promise<boolean> {
  for (const url of getRpcUrls()) {
    if (await probeUrl(url)) return true;
  }
  return false;
}

/** Opens the RPC settings panel (a <details id="rpc-settings">) and scrolls to it. */
export function openRpcSettings(): void {
  const el = document.getElementById("rpc-settings");
  if (el instanceof HTMLDetailsElement) {
    el.open = true;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}
