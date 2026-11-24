import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { CHAIN_ID } from "../lib/chain";
import {
  connectWallet,
  ensureGiwaSepolia,
  hasInjectedWallet,
  publicClient,
} from "../lib/client";
import { shortAddress } from "../lib/tokens";

interface WalletBarProps {
  account: Address | null;
  onAccount: (account: Address | null) => void;
}

export function WalletBar({ account, onAccount }: WalletBarProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wrongChain, setWrongChain] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);

  const refreshChain = useCallback(async () => {
    if (!hasInjectedWallet()) return;
    try {
      const ethereum = (
        window as unknown as {
          ethereum: { request: (a: { method: string }) => Promise<string> };
        }
      ).ethereum;
      const chainIdHex = await ethereum.request({ method: "eth_chainId" });
      setWrongChain(parseInt(chainIdHex, 16) !== CHAIN_ID);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshChain();
    if (!hasInjectedWallet()) return;
    const ethereum = (
      window as unknown as {
        ethereum: {
          on: (e: string, f: (...a: unknown[]) => void) => void;
          removeListener: (e: string, f: (...a: unknown[]) => void) => void;
        };
      }
    ).ethereum;
    const onAccounts = (accounts: unknown) => {
      const list = accounts as string[];
      onAccount(list.length > 0 ? (list[0] as Address) : null);
    };
    const onChain = () => refreshChain();
    ethereum.on("accountsChanged", onAccounts);
    ethereum.on("chainChanged", onChain);
    return () => {
      ethereum.removeListener("accountsChanged", onAccounts);
      ethereum.removeListener("chainChanged", onChain);
    };
  }, [onAccount, refreshChain]);

  useEffect(() => {
    if (!account) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    publicClient
      .getBalance({ address: account })
      .then((b) => {
        if (!cancelled) setBalance(b);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [account]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!hasInjectedWallet()) {
        setError("No wallet found — install MetaMask or Rabby first.");
        return;
      }
      await ensureGiwaSepolia();
      const acc = await connectWallet();
      onAccount(acc);
      setWrongChain(false);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not connect the wallet.",
      );
    } finally {
      setBusy(false);
    }
  };

  const switchChain = async () => {
    setBusy(true);
    setError(null);
    try {
      await ensureGiwaSepolia();
      setWrongChain(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not switch network.");
    } finally {
      setBusy(false);
    }
  };

  if (!account) {
    return (
      <div className="wallet-bar">
        <button
          className="btn btn-primary"
          onClick={connect}
          disabled={busy}
        >
          {busy ? "Connecting…" : "Connect wallet"}
        </button>
        {error && <span className="wallet-error">{error}</span>}
      </div>
    );
  }

  return (
    <div className="wallet-bar">
      <span className="wallet-pill" title={account}>
        <span className="dot dot-live" />
        {shortAddress(account)}
        {balance !== null && (
          <span className="wallet-balance">
            {(Number(balance) / 1e18).toFixed(4)} ETH
          </span>
        )}
      </span>
      {wrongChain && (
        <button className="btn btn-warn" onClick={switchChain} disabled={busy}>
          Switch to GIWA Sepolia
        </button>
      )}
      <button
        className="btn btn-ghost"
        onClick={() => onAccount(null)}
        title="Disconnect (local only — the wallet stays connected in your browser)"
      >
        Disconnect
      </button>
      {error && <span className="wallet-error">{error}</span>}
    </div>
  );
}
