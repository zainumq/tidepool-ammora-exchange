/**
 * Dismissible banner shown while the GIWA Sepolia RPC is unreachable.
 * Appears only after consecutive failed health probes (a single dropped
 * connection is noise on this network), hides itself as soon as any
 * endpoint answers again, and points the visitor at the RPC settings
 * panel where they can add their own endpoint. Dismissing lasts until
 * the RPC recovers and fails again — a new outage re-shows the banner.
 */
import { useEffect, useRef, useState } from "react";
import {
  FAILURES_TO_ALERT,
  PROBE_INTERVAL_MS,
  openRpcSettings,
  probeRpcHealth,
} from "../lib/rpcHealth";

export function RpcStatusBanner() {
  const [down, setDown] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const failures = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const ok = await probeRpcHealth();
      if (cancelled) return;
      if (ok) {
        failures.current = 0;
        setDown(false);
        setDismissed(false);
      } else {
        failures.current += 1;
        if (failures.current >= FAILURES_TO_ALERT) setDown(true);
      }
    };
    void check();
    const timer = setInterval(() => void check(), PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!down || dismissed) return null;
  return (
    <div className="rpc-banner" role="alert">
      <span>
        <strong>The GIWA Sepolia RPC is unreachable.</strong> The app can&apos;t read the chain right now, so prices,
        balances and scans may fail or show stale data. If this keeps happening, add your own RPC endpoint in the RPC
        settings below.
      </span>
      <span className="rpc-banner-actions">
        <button type="button" className="btn btn-small btn-primary" onClick={openRpcSettings}>
          Open RPC settings
        </button>
        <button type="button" className="btn btn-small btn-ghost" onClick={() => setDismissed(true)}>
          Dismiss
        </button>
      </span>
    </div>
  );
}
