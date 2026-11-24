/**
 * WalletConnect settings: a Reown project ID is required before the
 * WalletConnect button appears. The ID is a public identifier (it ships
 * in client-side code by design), not a secret — it is stored only in
 * this browser's localStorage. Get a free one at cloud.reown.com.
 */
import { useState } from "react";
import {
  clearWcProjectId,
  getWcProjectId,
  setWcProjectId,
} from "../lib/walletconnect";

export function WalletConnectSettings() {
  const [configured, setConfigured] = useState<string | null>(() => getWcProjectId());
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const save = () => {
    const id = input.trim();
    if (!id) return;
    setWcProjectId(id);
    setConfigured(id);
    setStatus("Saved — reloading…");
    window.location.reload();
  };

  const clear = () => {
    clearWcProjectId();
    setConfigured(null);
    setInput("");
    setStatus("Cleared — reloading…");
    window.location.reload();
  };

  return (
    <details className="rpc-settings">
      <summary className="muted small">
        WalletConnect: {configured ? "configured" : "not configured"} · change
      </summary>
      <div className="rpc-body">
        <p className="muted small">
          No browser wallet? Connect with a mobile wallet over WalletConnect. Get a free project
          ID at{" "}
          <a href="https://cloud.reown.com" target="_blank" rel="noreferrer" className="link">
            cloud.reown.com
          </a>{" "}
          and paste it here — the ID is public by design and stays in this browser only.
        </p>
        <div className="rpc-row">
          <input
            className="input"
            placeholder="Reown project ID"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={!input.trim()}
            onClick={save}
          >
            Save
          </button>
          {configured ? (
            <button type="button" className="btn btn-small btn-ghost" onClick={clear}>
              Clear
            </button>
          ) : null}
        </div>
        {status ? <p className="muted small">{status}</p> : null}
      </div>
    </details>
  );
}
