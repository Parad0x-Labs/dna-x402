import BN from "bn.js";
import { parseAtomic } from "../feePolicy.js";

interface StreamflowLike {
  recipient: string;
  mint: string;
  depositedAmount: BN;
  withdrawnAmount: BN;
  closed: boolean;
}

export interface StreamflowClientLike {
  getOne(data: { id: string }): Promise<StreamflowLike>;
}

export interface StreamflowVerificationInput {
  streamId: string;
  expectedRecipient: string;
  expectedMint: string;
  minFundedAtomic: string;
  requireActive?: boolean;
}

export interface StreamflowVerificationResult {
  ok: boolean;
  settledOnchain: boolean;
  streamId?: string;
  fundedAtomic?: string;
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
}

export async function verifyStreamflowProof(
  client: StreamflowClientLike,
  input: StreamflowVerificationInput,
): Promise<StreamflowVerificationResult> {
  let stream: StreamflowLike;
  try {
    stream = await client.getOne({ id: input.streamId });
  } catch {
    return {
      ok: false,
      settledOnchain: false,
      error: "stream not found",
      errorCode: "NOT_CONFIRMED_YET",
      retryable: true,
    };
  }

  if (stream.mint !== input.expectedMint) {
    return {
      ok: false,
      settledOnchain: false,
      error: `wrong mint: ${stream.mint}`,
      errorCode: "WRONG_MINT",
      retryable: false,
    };
  }

  if (stream.recipient !== input.expectedRecipient) {
    return {
      ok: false,
      settledOnchain: false,
      error: `wrong recipient: ${stream.recipient}`,
      errorCode: "WRONG_RECIPIENT",
      retryable: false,
    };
  }

  if (input.requireActive ?? true) {
    if (stream.closed) {
      return {
        ok: false,
        settledOnchain: false,
        error: "stream is closed",
        errorCode: "PAYMENT_INVALID",
        retryable: false,
      };
    }
  }

  const deposited = BigInt(stream.depositedAmount.toString(10));
  const withdrawn = BigInt(stream.withdrawnAmount.toString(10));
  const funded = deposited - withdrawn;
  const minFunded = parseAtomic(input.minFundedAtomic);
  if (funded < minFunded) {
    return {
      ok: false,
      settledOnchain: false,
      fundedAtomic: funded.toString(10),
      error: `insufficient funded amount ${funded.toString(10)}`,
      errorCode: "UNDERPAY",
      retryable: false,
    };
  }

  return {
    ok: true,
    settledOnchain: true,
    streamId: input.streamId,
    fundedAtomic: funded.toString(10),
  };
}
