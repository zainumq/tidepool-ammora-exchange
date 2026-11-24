import { useEffect, useMemo, useRef, useState } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { fetchTokenInfo, shortAddress, type TokenInfo } from "../lib/tokens";
import { TokenIcon } from "./TokenIcon";

interface TokenPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (token: TokenInfo) => void;
  /** Tokens discovered on-chain (launches + pool tokens). */
  knownTokens: TokenInfo[];
  exclude?: Address;
  title: string;
}

export function TokenPicker({
  open,
  onClose,
  onSelect,
  knownTokens,
  exclude,
  title,
}: TokenPickerProps) {
  const [query, setQuery] = useState("");
  const [pasted, setPasted] = useState<TokenInfo | null>(null);
  const [pastedError, setPastedError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setPasted(null);
      setPastedError(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open ]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!isAddress(trimmed)) {
      setPasted(null);
      setPastedError(null);
      return;
    }
    let cancelled = false;
    setResolving(true);
    setPastedError(null);
    fetchTokenInfo(getAddress(trimmed))
      .then((info) => {
        if (cancelled) return;
        setPasted(info);
      })
      .catch(() => {
        if (!cancelled) setPastedError("Could not read that token contract.");
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = knownTokens.filter(
      (t) => !exclude || t.address.toLowerCase() !== exclude.toLowerCase(),
    );
    if (!q || isAddress(query.trim())) return list;
    return list.filter(
      (t) =>
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.address.toLowerCase().includes(q),
    );
  }, [query, knownTokens, exclude]);

  if (!open) return null;

  const choose = (token: TokenInfo) => {
    onSelect(token);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <input
          ref={inputRef}
          className="input"
          placeholder="Search name, symbol, or paste a token address"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {resolving && <p className="muted">Reading token contract…</p>}
        {pastedError && <p className="error-text">{pastedError}</p>}
        {pasted && (
          <button
            className="token-row"
            onClick={() => choose(pasted)}
            disabled={
              !!exclude &&
              pasted.address.toLowerCase() === exclude.toLowerCase()
            }
          >
            <TokenIcon address={pasted.address} size={26} />
            <span className="token-symbol">{pasted.symbol}</span>
            <span className="token-name">
              {pasted.name} · {shortAddress(pasted.address)}
            </span>
            <span className="token-badge">Pasted address</span>
          </button>
        )}
        <div className="token-list">
          {filtered.length === 0 && !pasted && (
            <p className="muted">
              No matching token. Paste any ERC-20 address on GIWA Sepolia to
              trade it.
            </p>
          )}
          {filtered.map((t) => (
            <button
              key={t.address}
              className="token-row"
              onClick={() => choose(t)}
            >
              <TokenIcon address={t.address} size={26} />
              <span className="token-symbol">{t.symbol}</span>
              <span className="token-name">
                {t.name} · {shortAddress(t.address)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
