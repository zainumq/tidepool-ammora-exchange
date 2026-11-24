import type { WalletErrorKind } from "../lib/walletError";

/**
 * Concrete recovery steps for a failed wallet request, by failure kind.
 * The no-response steps matter most — a popup that never appeared leaves
 * a request queued in MetaMask, so the user must settle it before
 * retrying, or the same transaction can be sent twice.
 */
export function WalletErrorHint({ kind }: { kind: WalletErrorKind }) {
  if (kind === "no-response") {
    return (
      <ol className="wallet-hint">
        <li>
          Click the MetaMask icon in your browser toolbar — a pending
          request may be waiting there.
        </li>
        <li>
          If a request is pending, confirm or reject it first, so retrying
          does not send the same transaction twice.
        </li>
        <li>If no popup appears at all, reload the page and try again.</li>
      </ol>
    );
  }
  if (kind === "rejected") {
    return (
      <p className="wallet-hint">Nothing was sent. Retry whenever you are ready.</p>
    );
  }
  return (
    <p className="wallet-hint">
      If a transaction was submitted, check the explorer before retrying.
    </p>
  );
}
