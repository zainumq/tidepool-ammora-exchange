/**
 * viem clients: one shared read-only public client, the SDK route client, and
 * wallet helpers built on the user's injected provider (MetaMask / Rabby).
 *
 * No private key is ever created, requested, or stored here. Every send goes
 * through the connected wallet's own signing prompt.
 */
import {
  AmmoraRouteClient,
  createAmmoraDeploymentSource,
  giwaSepoliaAutoRoutePoolProfiles,
  resolveAmmoraFinalizedHead,
  type AmmoraRouteClient as AmmoraRouteClientType,
} from "@ammora-protocol/sdk";
import {
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  CHAIN_ID,
  DEPLOYMENT,
  DEPLOYMENT_CATALOG,
  FACTORY_PROFILES,
  ROUTE_CATALOG,
  ROUTE_DEPLOYMENT,
  getRpcUrls,
  giwaSepolia,
} from "./chain";
import { withWalletTimeout } from "./walletError";
import { getWcProvider } from "./walletconnect";

export const publicClient: PublicClient = createPublicClient({
  chain: giwaSepolia,
  transport: fallback(
    getRpcUrls().map((url) => http(url, { retryCount: 3, retryDelay: 1000, timeout: 15_000 })),
    { rank: false },
  ),
});

/** Options every SDK planner client needs: pin the reviewed deployment. */
export function clientOptions() {
  return {
    deploymentSource: createAmmoraDeploymentSource([DEPLOYMENT]),
    factoryProfiles: giwaSepoliaAutoRoutePoolProfiles,
  };
}

/** 10-minute deadline used by every planned transaction. */
export function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 600);
}

let routeClientPromise: Promise<AmmoraRouteClientType> | null = null;

/**
 * Shared AmmoraRouteClient. Created once per page load against a finalized
 * verification block; quotes are re-fetched per trade so staleness is bounded
 * by the SDK's own 30-second quote TTL.
 */
export function getRouteClient(): Promise<AmmoraRouteClientType> {
  if (!routeClientPromise) {
    routeClientPromise = (async () => {
      const verificationBlock = await resolveAmmoraFinalizedHead(
        [publicClient],
        ROUTE_DEPLOYMENT.finality,
      );
      return AmmoraRouteClient.create({
        chainId: CHAIN_ID,
        rpcUrls: getRpcUrls(),
        routeCatalog: ROUTE_CATALOG,
        deploymentCatalog: DEPLOYMENT_CATALOG,
        factoryProfiles: FACTORY_PROFILES,
        verificationBlock,
      });
    })();
  }
  return routeClientPromise;
}

export function hasInjectedWallet(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as unknown as { ethereum?: unknown }).ethereum !== undefined
  );
}

export function getWalletClient(): WalletClient {
  const wc = getWcProvider();
  if (wc) {
    return createWalletClient({
      chain: giwaSepolia,
      transport: custom(wc as never),
    });
  }
  const ethereum = (window as unknown as { ethereum: unknown }).ethereum;
  return createWalletClient({
    chain: giwaSepolia,
    transport: custom(ethereum as never),
  });
}

/** Request accounts from the injected wallet. Returns the first account. */
export async function connectWallet(): Promise<Address> {
  const wallet = getWalletClient();
  // The account prompt can hang like any wallet request (popup never
  // appears) — fail visibly instead of hanging forever.
  const [account] = await withWalletTimeout(wallet.requestAddresses());
  return account;
}

/**
 * Switch the injected wallet to GIWA Sepolia, adding the chain first when the
 * wallet does not know it (error 4902).
 */
export async function ensureGiwaSepolia(): Promise<void> {
  const ethereum = (
    window as unknown as {
      ethereum: {
        request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      };
    }
  ).ethereum;
  try {
    await withWalletTimeout(
      ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${CHAIN_ID.toString(16)}` }],
      }),
    );
  } catch (error: unknown) {
    const code = (error as { code?: number }).code;
    if (code !== 4902) throw error;
    await withWalletTimeout(
      ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: `0x${CHAIN_ID.toString(16)}`,
            chainName: "GIWA Sepolia",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: getRpcUrls(),
            blockExplorerUrls: ["https://sepolia-explorer.giwa.io"],
          },
        ],
      }),
    );
  }
}
