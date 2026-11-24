/**
 * Wallet-request error classification + timeouts.
 *
 * Live-test lesson (24 Nov 2026): a MetaMask popup that never appears used
 * to surface as "Rejected in wallet." — because the request hung until
 * something else (a reload, a dismissed popup) turned it into a 4001, and
 * the old message matcher could not tell the cases apart. So:
 *
 * - A real user rejection is EIP-1193 code 4001 (viem surfaces it as
 *   UserRejectedRequestError). Only that counts as a rejection.
 * - A request that gets no response at all fails visibly on a timeout
 *   instead of hanging forever, with an actionable message.
 * - Anything else keeps its actual error detail instead of being
 *   relabelled as a rejection.
 *
 * Note: timing out only rejects the app's promise — it cannot cancel a
 * request already queued in MetaMask. The retry hint therefore tells the
 * user to check MetaMask's queue before retrying, so the same transaction
 * is not sent twice.
 */

export type WalletErrorKind = "rejected" | "no-response" | "send" | "other";

export interface ClassifiedWalletError {
  kind: WalletErrorKind;
  message: string;
}

/**
 * How long one wallet signature request may take before the app fails
 * visibly. MetaMask popups that appear do so within seconds; two minutes
 * leaves ample time to find a popup that did not surface on its own.
 */
export const WALLET_REQUEST_TIMEOUT_MS = 120_000;

/**
 * How long a whole multi-step wallet flow (SDK execute: approvals, swap,
 * receipt waits) may take. Each step needs its own user confirmation, so
 * the budget is larger than a single request.
 */
export const WALLET_FLOW_TIMEOUT_MS = 300_000;

export class WalletTimeoutError extends Error {
  constructor() {
    super("Wallet request timed out");
    this.name = "WalletTimeoutError";
  }
}

/** Race a promise against the wallet timeout. The timeout rejects; the
 * underlying request keeps running in the wallet (it cannot be cancelled
 * from here), so callers must warn before retrying. */
export function withWalletTimeout<T>(
  promise: Promise<T>,
  ms: number = WALLET_REQUEST_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WalletTimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Walk an error's `.cause` chain (viem wraps provider errors several
 * levels deep: TransactionExecutionError -> UserRejectedRequestError ->
 * the raw JSON-RPC error). */
function errorChain(error: unknown): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current) && out.length < 10) {
    seen.add(current);
    out.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}

function chainHasCode(error: unknown, code: number): boolean {
  return errorChain(error).some((e) => (e as { code?: unknown }).code === code);
}

function chainHasName(error: unknown, name: string): boolean {
  return errorChain(error).some((e) => (e as { name?: unknown }).name === name);
}

function firstLine(message: string, max = 300): string {
  const line = message.split("\n")[0] ?? message;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function classifyWalletError(error: unknown): ClassifiedWalletError {
  if (error instanceof WalletTimeoutError) {
    return {
      kind: "no-response",
      message:
        "MetaMask did not respond — the popup may not have appeared. Check the MetaMask icon for a pending request, reload the page, and try again.",
    };
  }
  // EIP-1193 user rejection (code 4001). viem throws
  // UserRejectedRequestError for it (and for WalletConnect CAIP-25 5000).
  // A message match alone is NOT enough: a 4001 can also surface when a
  // pending request is superseded or its popup is closed without input.
  if (chainHasCode(error, 4001) || chainHasName(error, "UserRejectedRequestError")) {
    return { kind: "rejected", message: "Rejected in MetaMask." };
  }
  if (error instanceof Error) {
    const msg = firstLine(error.message);
    if (/over rate limit|429|too many requests/i.test(msg)) {
      return {
        kind: "send",
        message:
          "The public RPC is rate-limiting requests. Wait a moment and retry — do not resend a submitted transaction.",
      };
    }
    return { kind: "send", message: msg };
  }
  return { kind: "other", message: firstLine(String(error)) };
}

/** Plain-message form, for read paths and components without a retry UI. */
export function describeWalletError(error: unknown): string {
  return classifyWalletError(error).message;
}
