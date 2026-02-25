import {
  Connection,
  ParsedInstruction,
  PartiallyDecodedInstruction,
} from "@solana/web3.js";
import { parseAtomic } from "../feePolicy.js";
import { extractRpcErrorMessage, isRetryableRpcError } from "./rpcClient.js";

export interface SplTransferVerificationInput {
  txSignature: string;
  expectedMint: string;
  expectedRecipient: string;
  minAmountAtomic: string;
  maxAgeSeconds?: number;
  nowMs?: number;
}

export interface SplTransferVerificationResult {
  ok: boolean;
  settledOnchain: boolean;
  txSignature?: string;
  slot?: number;
  blockTime?: number | null;
  amountObservedAtomic?: string;
  error?: string;
  errorCode?:
    | "INVALID_PROOF"
    | "NOT_CONFIRMED_YET"
    | "RPC_UNAVAILABLE"
    | "PAYMENT_INVALID"
    | "UNDERPAY"
    | "WRONG_MINT"
    | "WRONG_RECIPIENT"
    | "TOO_OLD";
  retryable?: boolean;
  details?: Record<string, unknown>;
}

type TokenBalanceLike = {
  owner?: string;
  mint?: string;
  uiTokenAmount?: {
    amount?: string;
  };
};

function isParsedInstruction(ix: ParsedInstruction | PartiallyDecodedInstruction): ix is ParsedInstruction {
  return "parsed" in ix;
}

function sumBalances(balances: TokenBalanceLike[] | null | undefined, owner: string, mint: string): bigint {
  if (!balances) {
    return 0n;
  }
  let sum = 0n;
  for (const item of balances) {
    if (item.owner !== owner || item.mint !== mint) {
      continue;
    }
    const amount = item.uiTokenAmount?.amount;
    if (!amount || !/^\d+$/.test(amount)) {
      continue;
    }
    sum += BigInt(amount);
  }
  return sum;
}

function amountFromParsedTransfer(ix: ParsedInstruction, expectedRecipient: string, expectedMint: string): bigint {
  if (ix.program !== "spl-token") {
    return 0n;
  }
  const parsed = ix.parsed as { info?: Record<string, unknown>; type?: string };
  const info = parsed.info ?? {};
  const destination = typeof info.destination === "string" ? info.destination : undefined;
  const mint = typeof info.mint === "string" ? info.mint : undefined;
  if (!destination || destination !== expectedRecipient || !mint || mint !== expectedMint) {
    return 0n;
  }

  const tokenAmount = info.tokenAmount as { amount?: string } | undefined;
  if (tokenAmount?.amount && /^\d+$/.test(tokenAmount.amount)) {
    return BigInt(tokenAmount.amount);
  }

  const amount = info.amount;
  if (typeof amount === "string" && /^\d+$/.test(amount)) {
    return BigInt(amount);
  }
  return 0n;
}

function parsedTransferSignal(ix: ParsedInstruction): { destination?: string; mint?: string } | undefined {
  if (ix.program !== "spl-token") {
    return undefined;
  }
  const parsed = ix.parsed as { info?: Record<string, unknown> };
  const info = parsed.info ?? {};
  const destination = typeof info.destination === "string" ? info.destination : undefined;
  const mint = typeof info.mint === "string" ? info.mint : undefined;
  if (!destination && !mint) {
    return undefined;
  }
  return { destination, mint };
}

function looksLikeValidSolanaSignature(signature: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(signature);
}

function rpcUnavailable(error: unknown): SplTransferVerificationResult {
  const message = extractRpcErrorMessage(error);
  return {
    ok: false,
    settledOnchain: false,
    error: `rpc unavailable: ${message}`,
    errorCode: "RPC_UNAVAILABLE",
    retryable: isRetryableRpcError(error),
    details: { rpcError: message },
  };
}

export async function verifySplTransferProof(
  connection: Pick<Connection, "getSignatureStatus" | "getParsedTransaction" | "getBlockTime">,
  input: SplTransferVerificationInput,
): Promise<SplTransferVerificationResult> {
  if (!looksLikeValidSolanaSignature(input.txSignature)) {
    return {
      ok: false,
      settledOnchain: false,
      error: "invalid tx signature format",
      errorCode: "INVALID_PROOF",
      retryable: false,
    };
  }

  let status: Awaited<ReturnType<typeof connection.getSignatureStatus>>;
  try {
    status = await connection.getSignatureStatus(input.txSignature, { searchTransactionHistory: true });
  } catch (error) {
    return rpcUnavailable(error);
  }
  if (!status.value) {
    return {
      ok: false,
      settledOnchain: false,
      error: "signature not found or not confirmed yet",
      errorCode: "NOT_CONFIRMED_YET",
      retryable: true,
    };
  }

  if (status.value.err) {
    return {
      ok: false,
      settledOnchain: false,
      error: "transaction failed",
      errorCode: "PAYMENT_INVALID",
      retryable: false,
    };
  }

  let tx: Awaited<ReturnType<typeof connection.getParsedTransaction>>;
  try {
    tx = await connection.getParsedTransaction(input.txSignature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  } catch (error) {
    return rpcUnavailable(error);
  }

  if (!tx || !tx.meta) {
    return {
      ok: false,
      settledOnchain: false,
      error: "parsed transaction unavailable",
      errorCode: "NOT_CONFIRMED_YET",
      retryable: true,
    };
  }

  if (tx.meta.err) {
    return {
      ok: false,
      settledOnchain: false,
      error: "on-chain transaction contains error",
      errorCode: "PAYMENT_INVALID",
      retryable: false,
    };
  }

  const minAmount = parseAtomic(input.minAmountAtomic);
  const pre = sumBalances(tx.meta.preTokenBalances as TokenBalanceLike[], input.expectedRecipient, input.expectedMint);
  const post = sumBalances(tx.meta.postTokenBalances as TokenBalanceLike[], input.expectedRecipient, input.expectedMint);
  let observed = post - pre;

  const parsedIxs = tx.transaction.message.instructions.filter(isParsedInstruction);

  if (observed < minAmount) {
    const fromInstructions = parsedIxs.reduce((sum, ix) => {
      return sum + amountFromParsedTransfer(ix, input.expectedRecipient, input.expectedMint);
    }, 0n);
    observed = observed > fromInstructions ? observed : fromInstructions;
  }

  if (observed < minAmount) {
    const recipientMints = new Set<string>();
    const mintRecipients = new Set<string>();
    const preBalances = tx.meta.preTokenBalances as TokenBalanceLike[] | null | undefined;
    const postBalances = tx.meta.postTokenBalances as TokenBalanceLike[] | null | undefined;

    for (const balance of [...(preBalances ?? []), ...(postBalances ?? [])]) {
      if (balance.owner === input.expectedRecipient && balance.mint) {
        recipientMints.add(balance.mint);
      }
      if (balance.mint === input.expectedMint && balance.owner) {
        mintRecipients.add(balance.owner);
      }
    }

    for (const ix of parsedIxs) {
      const signal = parsedTransferSignal(ix);
      if (!signal) {
        continue;
      }
      if (signal.destination === input.expectedRecipient && signal.mint) {
        recipientMints.add(signal.mint);
      }
      if (signal.mint === input.expectedMint && signal.destination) {
        mintRecipients.add(signal.destination);
      }
    }

    if (recipientMints.size > 0 && !recipientMints.has(input.expectedMint)) {
      return {
        ok: false,
        settledOnchain: false,
        slot: tx.slot,
        blockTime: tx.blockTime,
        amountObservedAtomic: observed.toString(10),
        error: `wrong mint: expected ${input.expectedMint}`,
        errorCode: "WRONG_MINT",
        retryable: false,
      };
    }

    if (mintRecipients.size > 0 && !mintRecipients.has(input.expectedRecipient)) {
      return {
        ok: false,
        settledOnchain: false,
        slot: tx.slot,
        blockTime: tx.blockTime,
        amountObservedAtomic: observed.toString(10),
        error: `wrong recipient: expected ${input.expectedRecipient}`,
        errorCode: "WRONG_RECIPIENT",
        retryable: false,
      };
    }

    return {
      ok: false,
      settledOnchain: false,
      slot: tx.slot,
      blockTime: tx.blockTime,
      amountObservedAtomic: observed.toString(10),
      error: `underpaid: observed ${observed.toString(10)} expected >= ${minAmount.toString(10)}`,
      errorCode: "UNDERPAY",
      retryable: false,
    };
  }

  let blockTime = tx.blockTime;
  if (blockTime === null || blockTime === undefined) {
    try {
      blockTime = await connection.getBlockTime(tx.slot);
    } catch (error) {
      return rpcUnavailable(error);
    }
  }
  if (input.maxAgeSeconds && blockTime) {
    const nowMs = input.nowMs ?? Date.now();
    const ageMs = nowMs - blockTime * 1000;
    if (ageMs > input.maxAgeSeconds * 1000) {
      return {
        ok: false,
        settledOnchain: false,
        txSignature: input.txSignature,
        slot: tx.slot,
        blockTime,
        amountObservedAtomic: observed.toString(10),
        error: "payment proof too old",
        errorCode: "TOO_OLD",
        retryable: false,
      };
    }
  }

  return {
    ok: true,
    settledOnchain: true,
    txSignature: input.txSignature,
    slot: tx.slot,
    blockTime,
    amountObservedAtomic: observed.toString(10),
  };
}
