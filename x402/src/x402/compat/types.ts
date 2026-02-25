export interface CanonicalPaymentRequired {
  version: "x402-v1";
  network: "solana" | "base" | "unknown";
  currency: string;
  amountAtomic: string;
  recipient: string;
  memo?: string;
  expiresAt?: number;
  settlement: {
    mode: "spl_transfer" | "evm_transfer" | "unknown";
    mint?: string;
    chainId?: number;
  };
  raw: { headers: Record<string, string>; body?: unknown };
}

export interface CanonicalPaymentProof {
  version: "x402-proof-v1";
  scheme: "solana_spl" | "evm" | "unknown";
  txSig?: string;
  proofBlob?: string;
  sender?: string;
  amountAtomic?: string;
  recipient?: string;
  currency?: string;
  raw: { headers: Record<string, string>; body?: unknown };
}

export interface CanonicalX402Context {
  required?: CanonicalPaymentRequired;
  proof?: CanonicalPaymentProof;
  style: "coinbase" | "memeputer" | "generic" | "unknown";
  parseWarnings: string[];
}

export interface CompatRequestLike {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}
