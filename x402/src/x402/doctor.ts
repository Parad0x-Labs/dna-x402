import { redactValue } from "../logging/redact.js";
import { X402ErrorCode } from "./errors.js";
import { normalizeX402, PAYMENT_PROOF_HEADERS, PAYMENT_REQUIRED_HEADERS } from "./compat/parse.js";
import { CompatRequestLike } from "./compat/types.js";

function missingFields(input: ReturnType<typeof normalizeX402>): string[] {
  const missing: string[] = [];
  if (!input.required) {
    missing.push("PAYMENT-REQUIRED|X-PAYMENT-REQUIRED|X-402-PAYMENT-REQUIRED");
  }
  if (!input.proof) {
    missing.push("PAYMENT-SIGNATURE|X-PAYMENT|X-402-PAYMENT");
  }
  return missing;
}

function toSummary(value: ReturnType<typeof normalizeX402>["required"] | ReturnType<typeof normalizeX402>["proof"]): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  if ("network" in value) {
    return {
      version: value.version,
      network: value.network,
      currency: value.currency,
      amountAtomic: value.amountAtomic,
      recipient: redactValue(value.recipient),
      settlement: value.settlement,
      expiresAt: value.expiresAt,
    };
  }

  return {
    version: value.version,
    scheme: value.scheme,
    txSig: redactValue(value.txSig),
    sender: redactValue(value.sender),
    proofBlob: redactValue(value.proofBlob),
  };
}

function fixSnippet(dialect: string): string {
  if (dialect === "memeputer") {
    return "curl -H 'X-PAYMENT: <base64proof>' -H 'X-PAYMENT-REQUIRED: <base64requirements>' https://your-host/resource";
  }
  return "curl -H 'PAYMENT-SIGNATURE: <base64proof>' -H 'PAYMENT-REQUIRED: <base64requirements>' https://your-host/resource";
}

export function analyzeX402(input: CompatRequestLike): {
  dialectDetected: string;
  parseWarnings: string[];
  missing: string[];
  requiredSummary: Record<string, unknown> | null;
  proofSummary: Record<string, unknown> | null;
  supportedHeaders: {
    paymentRequired: readonly string[];
    paymentProof: readonly string[];
  };
  suggestedErrorCode: X402ErrorCode | null;
  exampleFix: {
    curl: string;
  };
} {
  const normalized = normalizeX402(input);
  const missing = missingFields(normalized);

  let suggestedErrorCode: X402ErrorCode | null = null;
  if (normalized.parseWarnings.length > 0 && !normalized.required && !normalized.proof) {
    suggestedErrorCode = X402ErrorCode.X402_PARSE_FAILED;
  } else if (normalized.style === "unknown" && !normalized.required && !normalized.proof) {
    suggestedErrorCode = X402ErrorCode.X402_UNSUPPORTED_DIALECT;
  } else if (!normalized.required) {
    suggestedErrorCode = X402ErrorCode.X402_MISSING_PAYMENT_REQUIRED;
  } else if (!normalized.proof) {
    suggestedErrorCode = X402ErrorCode.X402_MISSING_PAYMENT_PROOF;
  }

  return {
    dialectDetected: normalized.style,
    parseWarnings: normalized.parseWarnings,
    missing,
    requiredSummary: toSummary(normalized.required),
    proofSummary: toSummary(normalized.proof),
    supportedHeaders: {
      paymentRequired: PAYMENT_REQUIRED_HEADERS,
      paymentProof: PAYMENT_PROOF_HEADERS,
    },
    suggestedErrorCode,
    exampleFix: {
      curl: fixSnippet(normalized.style),
    },
  };
}
