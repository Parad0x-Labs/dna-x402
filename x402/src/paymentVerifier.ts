import { Connection } from "@solana/web3.js";
import { PaymentProof, Quote, VerificationResult } from "./types.js";
import { verifySplTransferProof } from "./verifier/splTransfer.js";
import { StreamflowClientLike, verifyStreamflowProof } from "./verifier/streamflow.js";

export interface PaymentVerifier {
  verify(quote: Quote, paymentProof: PaymentProof): Promise<VerificationResult>;
}

export interface SolanaPaymentVerifierOptions {
  streamflowClient?: StreamflowClientLike;
  maxTransferProofAgeSeconds?: number;
}

export class SolanaPaymentVerifier implements PaymentVerifier {
  constructor(
    private readonly connection: Connection,
    private readonly options: SolanaPaymentVerifierOptions = {},
  ) {}

  async verify(quote: Quote, paymentProof: PaymentProof): Promise<VerificationResult> {
    switch (paymentProof.settlement) {
      case "transfer":
        return this.verifyTransfer(quote, paymentProof.txSignature, paymentProof.amountAtomic);
      case "stream":
        return this.verifyStream(quote, paymentProof.streamId, paymentProof.amountAtomic, paymentProof.topupSignature);
      case "netting":
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

  private async verifyTransfer(quote: Quote, txSignature: string, amountAtomicHint?: string): Promise<VerificationResult> {
    return verifySplTransferProof(this.connection, {
      txSignature,
      expectedMint: quote.mint,
      expectedRecipient: quote.recipient,
      minAmountAtomic: amountAtomicHint ?? quote.totalAtomic,
      maxAgeSeconds: this.options.maxTransferProofAgeSeconds ?? 900,
    });
  }

  private async verifyStream(quote: Quote, streamId: string, amountAtomicHint?: string, topupSignature?: string): Promise<VerificationResult> {
    if (!streamId) {
      return {
        ok: false,
        settledOnchain: false,
        error: "Missing streamId",
      };
    }

    if (this.options.streamflowClient) {
      return verifyStreamflowProof(this.options.streamflowClient, {
        streamId,
        expectedRecipient: quote.recipient,
        expectedMint: quote.mint,
        minFundedAtomic: amountAtomicHint ?? quote.totalAtomic,
        requireActive: true,
      });
    }

    if (!topupSignature) {
      return {
        ok: false,
        settledOnchain: false,
        streamId,
        error: "stream proof missing topupSignature and streamflow client",
      };
    }

    const status = await this.connection.getSignatureStatus(topupSignature, { searchTransactionHistory: true });
    const ok = Boolean(status.value && !status.value.err);
    return {
      ok,
      settledOnchain: ok,
      txSignature: topupSignature,
      streamId,
      error: ok ? undefined : "Top-up signature not confirmed",
    };
  }
}
