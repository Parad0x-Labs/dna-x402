import { Connection } from "@solana/web3.js";
import { PaymentProof, Quote, VerificationResult } from "./types.js";
import { verifySplTransferProof } from "./verifier/splTransfer.js";
import { StreamflowClientLike, verifyStreamflowProof } from "./verifier/streamflow.js";
import { CachedRpcClient, extractRpcErrorMessage, isRetryableRpcError } from "./verifier/rpcClient.js";

export interface PaymentVerifier {
  verify(quote: Quote, paymentProof: PaymentProof): Promise<VerificationResult>;
}

export interface SolanaPaymentVerifierOptions {
  streamflowClient?: StreamflowClientLike;
  maxTransferProofAgeSeconds?: number;
  allowUnverifiedNetting?: boolean;
  rpcCache?: {
    statusTtlMs?: number;
    parsedTxTtlMs?: number;
    blockTimeTtlMs?: number;
    maxCacheEntries?: number;
    maxRetries?: number;
    retryBaseMs?: number;
    circuitBreakerFailures?: number;
    circuitBreakerCooldownMs?: number;
  };
}

export class SolanaPaymentVerifier implements PaymentVerifier {
  private readonly cachedRpc: CachedRpcClient;

  constructor(
    private readonly connection: Connection,
    private readonly options: SolanaPaymentVerifierOptions = {},
  ) {
    this.cachedRpc = new CachedRpcClient(connection, options.rpcCache);
  }

  async verify(quote: Quote, paymentProof: PaymentProof): Promise<VerificationResult> {
    switch (paymentProof.settlement) {
      case "transfer":
        return this.verifyTransfer(quote, paymentProof.txSignature, paymentProof.amountAtomic);
      case "stream":
        return this.verifyStream(quote, paymentProof.streamId, paymentProof.amountAtomic, paymentProof.topupSignature);
      case "netting":
        if (!this.options.allowUnverifiedNetting) {
          return {
            ok: false,
            settledOnchain: false,
            error: "netting settlement requires explicit external liability attestation",
            errorCode: "PAYMENT_INVALID",
            retryable: false,
          };
        }
        return {
          ok: true,
          settledOnchain: false,
        };
      default:
        return {
          ok: false,
          settledOnchain: false,
          error: "Unsupported settlement proof",
        };
    }
  }

  private parseAtomicHint(value?: string): bigint | undefined {
    if (!value) {
      return undefined;
    }
    try {
      return BigInt(value);
    } catch {
      return undefined;
    }
  }

  private async verifyTransfer(quote: Quote, txSignature: string, amountAtomicHint?: string): Promise<VerificationResult> {
    const requiredMinAmount = quote.totalAtomic;
    const hintedAmount = this.parseAtomicHint(amountAtomicHint);
    const effectiveMinAmount = hintedAmount && hintedAmount > BigInt(requiredMinAmount)
      ? hintedAmount.toString(10)
      : requiredMinAmount;
    try {
      return await verifySplTransferProof(this.cachedRpc, {
        txSignature,
        expectedMint: quote.mint,
        expectedRecipient: quote.recipient,
        minAmountAtomic: effectiveMinAmount,
        maxAgeSeconds: this.options.maxTransferProofAgeSeconds ?? 900,
      });
    } catch (error) {
      const cause = extractRpcErrorMessage(error);
      const invalidParam = cause.toLowerCase().includes("invalid param: invalid");
      return {
        ok: false,
        settledOnchain: false,
        error: invalidParam ? "invalid tx signature format" : `rpc unavailable: ${cause}`,
        errorCode: invalidParam ? "INVALID_PROOF" : "RPC_UNAVAILABLE",
        retryable: invalidParam ? false : isRetryableRpcError(error),
      };
    }
  }

  private async verifyStream(quote: Quote, streamId: string, amountAtomicHint?: string, _topupSignature?: string): Promise<VerificationResult> {
    if (!streamId) {
      return {
        ok: false,
        settledOnchain: false,
        error: "Missing streamId",
      };
    }

    if (this.options.streamflowClient) {
      const requiredMinFunded = quote.totalAtomic;
      const hintedAmount = this.parseAtomicHint(amountAtomicHint);
      const effectiveMinFunded = hintedAmount && hintedAmount > BigInt(requiredMinFunded)
        ? hintedAmount.toString(10)
        : requiredMinFunded;
      return verifyStreamflowProof(this.options.streamflowClient, {
        streamId,
        expectedRecipient: quote.recipient,
        expectedMint: quote.mint,
        minFundedAtomic: effectiveMinFunded,
        requireActive: true,
      });
    }

    return {
      ok: false,
      settledOnchain: false,
      streamId,
      error: "stream settlement requires a streamflow client for funded-state verification",
      errorCode: "PAYMENT_INVALID",
      retryable: false,
    };
  }
}
