/**
 * WalletConnect (Reown) connection via @walletconnect/ethereum-provider.
 *
 * The provider bundle is heavy (QR-modal code), so it is loaded with a
 * dynamic import only when the visitor actually chooses WalletConnect —
 * the main bundle stays untouched.
 *
 * A Reown project ID is required. It is a public identifier (it ships in
 * client-side code by design), not a secret: the visitor pastes theirs in
 * the WalletConnect settings panel, or a build can bake one in via
 * VITE_WC_PROJECT_ID. Saved in localStorage, never sent anywhere except
 * to WalletConnect's relay as part of the session handshake.
 */
import type EthereumProvider from "@walletconnect/ethereum-provider";
import type { Address } from "viem";
import { CHAIN_ID } from "./chain";

type WcProvider = Awaited<ReturnType<typeof EthereumProvider.init>>;

const WC_PROJECT_ID_KEY = "tidepool:wc-project-id";

export function getWcProjectId(): string | null {
  const stored =
    typeof window !== "undefined" ? localStorage.getItem(WC_PROJECT_ID_KEY) : null;
  const baked = import.meta.env.VITE_WC_PROJECT_ID as string | undefined;
  if (stored) return stored;
  return baked && baked.length > 0 ? baked : null;
}

export function setWcProjectId(id: string): void {
  localStorage.setItem(WC_PROJECT_ID_KEY, id.trim());
}

export function clearWcProjectId(): void {
  localStorage.removeItem(WC_PROJECT_ID_KEY);
}

let wcProvider: WcProvider | null = null;

/** The active WalletConnect provider, if a session was established. */
export function getWcProvider(): WcProvider | null {
  return wcProvider;
}

/**
 * Open the WalletConnect QR modal and return the first connected account.
 * The session is scoped to GIWA Sepolia, so no chain switch is needed.
 */
export async function connectWalletConnect(): Promise<Address> {
  const projectId = getWcProjectId();
  if (!projectId) {
    throw new Error(
      "No WalletConnect project ID configured. Get a free one at cloud.reown.com and paste it in the WalletConnect settings below.",
    );
  }
  if (!wcProvider) {
    const { default: Provider } = await import("@walletconnect/ethereum-provider");
    wcProvider = await Provider.init({
      projectId,
      chains: [CHAIN_ID],
      showQrModal: true,
      metadata: {
        name: "Tidepool",
        description: "Exchange & LP manager for Ammora on GIWA Sepolia testnet",
        url: "https://zainumq.github.io/tidepool-ammora-exchange/",
        icons: ["https://zainumq.github.io/tidepool-ammora-exchange/tidepool-og.png"],
      },
    });
  }
  const accounts = await wcProvider.enable();
  if (accounts.length === 0) throw new Error("WalletConnect returned no account.");
  return accounts[0] as Address;
}

export async function disconnectWalletConnect(): Promise<void> {
  const provider = wcProvider;
  wcProvider = null;
  if (!provider) return;
  try {
    await provider.disconnect();
  } catch {
    // Session already gone; treat as disconnected.
  }
}
