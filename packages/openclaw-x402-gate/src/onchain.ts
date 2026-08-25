/**
 * Optional on-chain confirmation for revenue-grade gating.
 *
 * Structural verification (gate.ts) only proves the caller submitted a
 * well-formed proof bound to the resource and amount. Before serving anything
 * valuable, confirm the payment actually SETTLED: the signature resolves to a
 * confirmed, successful transaction whose memo carries the unique receipt hash
 * (which is bound to payer + recipient + amount + resource + nonce, so it can't
 * be replayed against a different charge).
 *
 * Isolated here so gate.ts stays network-free. Uses @solana/web3.js only.
 */

import { Connection, PublicKey } from "@solana/web3.js";

export interface OnChainResult {
  confirmed: boolean;
  reason?: string;
  slot?: number;
}

/**
 * Confirm a settled payment transaction.
 *
 * `expect.recipient` (the requirement's `payTo`) is optional but STRONGLY
 * recommended: when provided, the confirmed transaction's account keys are
 * checked to include the recipient, so the tx cannot merely carry the receipt
 * hash in its memo while paying someone else.
 */
export async function confirmOnChain(
  connection: Connection,
  signature: string,
  expect: { receiptHash: string; recipient?: string },
): Promise<OnChainResult> {
  if (!signature) return { confirmed: false, reason: "no signature provided" };

  let tx;
  try {
    tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
  } catch (e) {
    return { confirmed: false, reason: `RPC error: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!tx) return { confirmed: false, reason: "transaction not found or not yet confirmed" };
  if (tx.meta?.err) {
    return { confirmed: false, reason: `transaction failed on-chain: ${JSON.stringify(tx.meta.err)}` };
  }

  // Verify the transfer recipient when derivable from context: the recipient
  // public key must appear among the transaction's account keys (it is loaded
  // as a non-signer account by the transfer / idempotent-ATA instructions).
  if (expect.recipient) {
    try {
      const accountKeysFromLookups = tx.meta
        ? {
            writable: tx.meta.loadedAddresses?.writable ?? [],
            readonly: tx.meta.loadedAddresses?.readonly ?? [],
          }
        : undefined;
      const keys = tx.transaction.message
        .getAccountKeys({ accountKeysFromLookups })
        .keySegments()
        .flat();
      const recipientPk = new PublicKey(expect.recipient);
      if (!keys.some((key) => key.equals(recipientPk))) {
        return {
          confirmed: false,
          reason: "confirmed transaction does not involve the expected payee address",
        };
      }
    } catch (e) {
      return {
        confirmed: false,
        reason: `could not verify payment recipient: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  } else {
    console.warn(
      "[x402-gate] on-chain confirmation ran WITHOUT a recipient check — the " +
        "confirmed tx was not verified to pay the expected payee.",
    );
  }

  // The memo carries `${memoPrefix}:${receiptHash}`. The receipt hash is unique
  // per payment, so its presence in the confirmed tx proves THIS charge settled.
  const logs = tx.meta?.logMessages?.join("\n") ?? "";
  if (!logs.includes(expect.receiptHash)) {
    return {
      confirmed: false,
      reason: "confirmed transaction does not carry the expected receipt hash (memo mismatch)",
    };
  }

  return { confirmed: true, slot: tx.slot };
}
