import { Connection } from "@solana/web3.js";
import { PaymentVerifier, SolanaPaymentVerifier } from "../paymentVerifier.js";
import { VerificationResult } from "../types.js";

export type SupportedNetwork = "solana-devnet" | "solana-mainnet";

const DEFAULT_SOLANA_RPC_URL = "https://api.devnet.solana.com";
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface PaymentSupportOptions {
  rpcUrl?: string;
  maxTransferProofAgeSeconds?: number;
  allowUnverifiedNetting?: boolean;
  paymentVerifier?: PaymentVerifier;
}

export function inferPaymentNetwork(
  explicit?: SupportedNetwork,
  rpcUrl?: string,
): SupportedNetwork {
  if (explicit) {
    return explicit;
  }

  const candidate = (rpcUrl ?? DEFAULT_SOLANA_RPC_URL).toLowerCase();
  if (candidate.includes("devnet") || candidate.includes("localhost") || candidate.includes("127.0.0.1")) {
    return "solana-devnet";
  }

  return "solana-mainnet";
}

export function defaultUsdcMintForNetwork(
  explicit?: SupportedNetwork,
  rpcUrl?: string,
): string {
  return inferPaymentNetwork(explicit, rpcUrl) === "solana-mainnet"
    ? MAINNET_USDC_MINT
    : DEVNET_USDC_MINT;
}

export function createPaymentVerifier(options: PaymentSupportOptions): PaymentVerifier {
  if (options.paymentVerifier) {
    return options.paymentVerifier;
  }

  const connection = new Connection(options.rpcUrl ?? DEFAULT_SOLANA_RPC_URL, "confirmed");
  return new SolanaPaymentVerifier(connection, {
    maxTransferProofAgeSeconds: options.maxTransferProofAgeSeconds,
    allowUnverifiedNetting: options.allowUnverifiedNetting,
  });
}

export function verificationFailureStatus(result: VerificationResult): number {
  if (result.retryable) {
    return 503;
  }

  switch (result.errorCode) {
    case "RPC_UNAVAILABLE":
      return 503;
    case "INVALID_PROOF":
    case "PAYMENT_INVALID":
    case "UNDERPAY":
    case "WRONG_MINT":
    case "WRONG_RECIPIENT":
    case "TOO_OLD":
    case "NOT_CONFIRMED_YET":
      return 422;
    default:
      return 400;
  }
}
