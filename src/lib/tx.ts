/**
 * Transaction execution through the connected wallet: exact ERC-20 approvals
 * (only when the current allowance is insufficient) followed by the planned
 * transactions, each confirmed before the next one is sent.
 */
import type { ERC20ApprovalRequirement } from "@ammora-protocol/sdk";
import {
  encodeFunctionData,
  type Address,
  type Hash,
  type WalletClient,
} from "viem";
import { erc20Abi } from "./chain";
import { publicClient } from "./client";

export interface PlannedTransaction {
  to: Address;
  data: `0x${string}`;
  value?: bigint;
}

export type TxStatusCallback = (message: string) => void;

export async function waitReceipt(hash: Hash) {
  return publicClient.waitForTransactionReceipt({ hash });
}

/**
 * Send one planned transaction from the connected wallet and wait for its
 * receipt. Throws when the receipt status is reverted.
 */
export async function sendPlanned(
  wallet: WalletClient,
  account: Address,
  tx: PlannedTransaction,
): Promise<Hash> {
  const hash = await wallet.sendTransaction({
    account,
    chain: wallet.chain ?? undefined,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
  });
  const receipt = await waitReceipt(hash);
  if (receipt.status === "reverted") {
    throw new Error(`Transaction reverted: ${hash}`);
  }
  return hash;
}

/**
 * Ensure each approval requirement is met with an exact allowance. When the
 * current allowance is non-zero but too small, reset it to zero first (some
 * tokens reject a direct allowance increase).
 */
export async function ensureApprovals(
  wallet: WalletClient,
  account: Address,
  requirements: readonly ERC20ApprovalRequirement[],
  onStatus?: TxStatusCallback,
): Promise<Hash[]> {
  const hashes: Hash[] = [];
  for (const req of requirements) {
    const token = req.token as Address;
    const spender = req.spender as Address;
    const needed = req.amount;
    if (needed === 0n) continue;
    const current = await publicClient.readContract({
      abi: erc20Abi,
      address: token,
      functionName: "allowance",
      args: [account, spender],
    });
    if (current >= needed) continue;
    if (current > 0n) {
      onStatus?.(`Resetting allowance for ${token.slice(0, 10)}…`);
      hashes.push(
        await sendPlanned(wallet, account, {
          to: token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [spender, 0n],
          }),
        }),
      );
    }
    onStatus?.(`Approving ${token.slice(0, 10)}…`);
    hashes.push(
      await sendPlanned(wallet, account, {
        to: token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [spender, needed],
        }),
      }),
    );
  }
  return hashes;
}

/** Approvals first, then each transaction in order. Returns all hashes. */
export async function executePlan(
  wallet: WalletClient,
  account: Address,
  transactions: readonly PlannedTransaction[],
  approvalRequirements: readonly ERC20ApprovalRequirement[] = [],
  onStatus?: TxStatusCallback,
): Promise<Hash[]> {
  const hashes: Hash[] = [];
  const approvalHashes = await ensureApprovals(
    wallet,
    account,
    approvalRequirements,
    onStatus,
  );
  hashes.push(...approvalHashes);
  for (const tx of transactions) {
    onStatus?.("Sending transaction — confirm in your wallet");
    hashes.push(await sendPlanned(wallet, account, tx));
  }
  return hashes;
}
