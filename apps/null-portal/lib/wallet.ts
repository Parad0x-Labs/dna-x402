/**
 * wallet.ts — client-side Phantom helper for the .null portal.
 *
 * Connect + sign pattern adapted from the battle-tested
 * parad0x-website/lib/solanaPhantomDeposit.ts:
 *   - Phantom v22+ detection via window.phantom.solana, falling back to a
 *     legacy window.solana ONLY when it advertises isPhantom.
 *   - signAndSendTransaction, with the blockhash fetched FRESH at sign time
 *     (confirmed commitment) to avoid the stale-blockhash "block height
 *     exceeded" failure.
 *   - Post-sign confirmation: strict confirm with a short deadline, then a
 *     signature-status poll. NEVER throw once Phantom returns a signature
 *     (re-throwing would re-prompt the user).
 *
 * Only the connect/sign primitives are ported — no betting/deposit code.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";

// ── Phantom provider typing ──────────────────────────────────────────────────
type PhantomSignResult = { signature: string } | string;

export type PhantomProvider = {
  isPhantom?: boolean;
  publicKey?: { toString(): string; toBase58?: () => string } | null;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{
    publicKey: { toString(): string; toBase58?: () => string };
  }>;
  disconnect?(): Promise<void>;
  on?(event: string, handler: (args: unknown) => void): void;
  removeListener?(event: string, handler: (args: unknown) => void): void;
  signAndSendTransaction?(tx: Transaction): Promise<PhantomSignResult>;
  signTransaction?(tx: Transaction): Promise<Transaction>;
};

/**
 * Phantom-first provider lookup. The legacy window.solana global can be
 * hijacked by other wallets; Phantom v22+ lives at window.phantom.solana.
 */
export function getPhantom(): PhantomProvider | undefined {
  if (typeof window === "undefined") return undefined;
  const win = window as unknown as {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
  };
  if (win.phantom?.solana) return win.phantom.solana;
  if (win.solana?.isPhantom) return win.solana;
  return undefined;
}

export function normalizeWalletAddress(
  value?: { toString?: () => string; toBase58?: () => string } | string | null,
): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.toBase58?.() || value.toString?.() || "";
}

export class PhantomNotFoundError extends Error {
  constructor() {
    super(
      "Phantom not detected. Install Phantom (or unlock it / disable conflicting Solana wallets like Backpack) and retry.",
    );
    this.name = "PhantomNotFoundError";
  }
}

/** Connect to Phantom (silent re-connect first, then a full prompt). Returns the
 *  connected base58 address. Has an 8s handshake deadline. */
export async function connectPhantom(
  opts: { onlyIfTrusted?: boolean } = {},
): Promise<string> {
  const phantom = getPhantom();
  if (!phantom?.connect) throw new PhantomNotFoundError();

  const connectDeadline = 8_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      opts.onlyIfTrusted
        ? phantom.connect({ onlyIfTrusted: true })
        : phantom.connect({ onlyIfTrusted: true }).catch(() => phantom.connect()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Phantom did not respond in ${connectDeadline / 1000}s — unlock the extension and retry.`,
              ),
            ),
          connectDeadline,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const addr = normalizeWalletAddress(phantom.publicKey);
  if (!addr) {
    throw new Error("Connected wallet address unavailable. Reconnect Phantom and retry.");
  }
  return addr;
}

export async function disconnectPhantom(): Promise<void> {
  const phantom = getPhantom();
  try {
    await phantom?.disconnect?.();
  } catch {
    // ignore — Phantom may not expose disconnect; the UI just clears state.
  }
}

/**
 * Build, sign and send a transaction made of the given instructions, paid by
 * the connected wallet. Returns the on-chain signature once observed.
 *
 *  - Fetches a FRESH confirmed blockhash right before signing.
 *  - Prepends a modest ComputeBudget so Phantom's simulator is happy.
 *  - Strict-confirm with a 15s deadline, then a 60s signature-status poll.
 *  - Never throws after Phantom hands back a signature.
 */
export async function signAndSendInstructions(input: {
  connection: Connection;
  owner: string;
  instructions: TransactionInstruction[];
  computeUnits?: number;
  priorityMicroLamports?: number;
}): Promise<string> {
  const phantom = getPhantom();
  if (!phantom?.connect) throw new PhantomNotFoundError();

  // Make sure we are connected to the wallet we think we are.
  await connectPhantom();
  const connected = normalizeWalletAddress(phantom.publicKey);
  if (!connected) {
    throw new Error("Connected wallet address unavailable. Reconnect Phantom and retry.");
  }
  if (connected !== input.owner) {
    throw new Error(
      "Phantom is connected to a different wallet than the one shown here. Reconnect and retry.",
    );
  }

  const owner = new PublicKey(input.owner);
  // FRESH blockhash at sign time — avoids the stale "block height exceeded" fail.
  const latest = await input.connection.getLatestBlockhash("confirmed");

  const tx = new Transaction({
    feePayer: owner,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  // ComputeBudget first — silences Phantom's "could not estimate compute" advisory
  // and prioritizes the tx. Unused CU is refunded, so over-allocating is free.
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnits ?? 120_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: input.priorityMicroLamports ?? 50_000 }));
  for (const ix of input.instructions) tx.add(ix);

  let signature = "";
  if (phantom.signAndSendTransaction) {
    const result = await phantom.signAndSendTransaction(tx);
    signature = typeof result === "string" ? result : result.signature;
  } else if (phantom.signTransaction) {
    const signed = await phantom.signTransaction(tx);
    signature = await input.connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
    });
  } else {
    throw new Error("Phantom wallet cannot sign transactions in this browser.");
  }
  if (!signature) throw new Error("Phantom returned no signature.");

  // Confirmation strategy: strict confirm (fast path), then signature-status
  // poll (works even after the blockhash window closes). Never throw here.
  try {
    await Promise.race([
      input.connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        "confirmed",
      ),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("strict-confirm-timeout-15s")), 15_000),
      ),
    ]);
    return signature;
  } catch {
    const pollStart = Date.now();
    const POLL_TIMEOUT_MS = 60_000;
    const POLL_INTERVAL_MS = 3_000;
    while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      try {
        const statusResp = await input.connection.getSignatureStatus(signature, {
          searchTransactionHistory: true,
        });
        const status = statusResp?.value;
        if (status && !status.err) return signature;
        if (status?.err) {
          // Real on-chain failure — surface it (this is pre-return, the tx
          // genuinely failed, so the caller should show an error).
          throw new Error(
            `Transaction failed on-chain: ${JSON.stringify(status.err)} (sig ${signature})`,
          );
        }
      } catch (e) {
        // A thrown on-chain-err above should propagate; transient RPC blips loop.
        if (e instanceof Error && e.message.startsWith("Transaction failed on-chain")) {
          throw e;
        }
      }
    }
    // Poll timed out but Phantom gave us a sig — return it; the tx may still land.
    return signature;
  }
}
