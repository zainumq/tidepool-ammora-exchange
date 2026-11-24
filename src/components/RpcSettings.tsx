/**
 * RPC settings: GIWA Sepolia has a single public RPC, so if it is unreachable
 * from the visitor's network the app would have no way to read the chain.
 * This panel lets the visitor enter their own GIWA Sepolia RPC URL — it is
 * validated (must answer as chain 91342) before it is saved, and the official
 * endpoint always stays as fallback. Saved locally, never sent anywhere.
 */
import { useState } from "react";
import {
  DEFAULT_RPC_URL,
  clearCustomRpcUrl,
  getCustomRpcUrl,
  getRpcUrls,
  setCustomRpcUrl,
  validateRpcUrl,
} from "../lib/chain";

export function RpcSettings() {
  const [custom, setCustom] = useState<string | null>(() => getCustomRpcUrl());
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const url = input.trim();
    if (!url) return;
    setBusy(true);
    setStatus("Checking endpoint…");
    const result = await validateRpcUrl(url);
    if (!result.ok) {
      setStatus(`Not saved: ${result.error}`);
      setBusy(false);
      return;
    }
    setCustomRpcUrl(url);
    setCustom(url);
    setStatus("Saved — reloading…");
    window.location.reload();
  };

  const reset = () => {
    clearCustomRpcUrl();
    setCustom(null);
    setInput("");
    setStatus("Back to the official RPC — reloading…");
    window.location.reload();
  };

  return (
    <details className="rpc-settings">
      <summary className="muted small">
        RPC: <span className="mono">{custom ?? DEFAULT_RPC_URL}</span>
        {custom ? " (custom)" : " (official)"} · change
      </summary>
      <div className="rpc-body">
        <p className="muted small">
          GIWA Sepolia has one public RPC. If it is unreachable from your network, paste a compatible
          GIWA Sepolia RPC URL here — it is checked (must answer as chain 91342) before it is used, and
          the official endpoint stays as fallback.
        </p>
        <div className="rpc-row">
          <input
            className="input"
            placeholder="https://your-giwa-sepolia-rpc.example"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={busy || !input.trim()}
            onClick={() => void save()}
          >
            {busy ? "Checking…" : "Use this RPC"}
          </button>
          {custom ? (
            <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={reset}>
              Reset to default
            </button>
          ) : null}
        </div>
        {status ? <p className="muted small">{status}</p> : null}
        <p className="muted small">
          Active endpoints: <span className="mono">{getRpcUrls().join(" · ")}</span>
        </p>
      </div>
    </details>
  );
}
