import { useMemo, useState } from "react";
import { getIdenticon } from "../lib/identicon";

/**
 * Deterministic blockies-style token identicon (inline SVG). The
 * derivation lives in ../lib/identicon and is byte-identical in KongPad
 * and Tidepool, so one address renders the same icon in both apps.
 */

const GRID = 5;

interface TokenIconProps {
  address: string;
  size?: number;
  /** Optional logo URL — the identicon is the fallback when it fails to load. */
  logoUrl?: string;
  className?: string;
}

export function TokenIcon({ address, size = 28, logoUrl, className }: TokenIconProps) {
  // The URL that failed to load, if any. Keyed by URL (not a boolean), so
  // a new logoUrl automatically retries — no effect needed to reset it.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const data = useMemo(() => getIdenticon(address), [address]);

  const cls = className ? `token-icon ${className}` : "token-icon";

  if (logoUrl && failedUrl !== logoUrl) {
    return (
      <img
        className={cls}
        src={logoUrl}
        alt={`Token icon for ${address}`}
        width={size}
        height={size}
        onError={() => setFailedUrl(logoUrl)}
      />
    );
  }

  return (
    <svg
      className={cls}
      width={size}
      height={size}
      viewBox={`0 0 ${GRID} ${GRID}`}
      role="img"
      aria-label={`Token icon for ${address}`}
    >
      <rect width={GRID} height={GRID} fill={data.background} />
      {data.cells.map((filled, i) =>
        filled ? (
          <rect
            key={i}
            x={i % GRID}
            y={Math.floor(i / GRID)}
            width={1}
            height={1}
            fill={data.foreground}
          />
        ) : null,
      )}
    </svg>
  );
}
