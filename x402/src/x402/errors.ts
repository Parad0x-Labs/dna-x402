import crypto from "node:crypto";

export enum X402ErrorCode {
  X402_PARSE_FAILED = "X402_PARSE_FAILED",
  X402_UNSUPPORTED_DIALECT = "X402_UNSUPPORTED_DIALECT",
  X402_MISSING_PAYMENT_REQUIRED = "X402_MISSING_PAYMENT_REQUIRED",
  X402_MISSING_PAYMENT_PROOF = "X402_MISSING_PAYMENT_PROOF",
  X402_NOT_CONFIRMED_YET = "X402_NOT_CONFIRMED_YET",
  X402_RPC_UNAVAILABLE = "X402_RPC_UNAVAILABLE",
  X402_REQUIRED_INVALID = "X402_REQUIRED_INVALID",
  X402_PROOF_INVALID = "X402_PROOF_INVALID",
  X402_REQUIRED_PROOF_MISMATCH = "X402_REQUIRED_PROOF_MISMATCH",
  X402_UNSUPPORTED_NETWORK = "X402_UNSUPPORTED_NETWORK",
  X402_UNSUPPORTED_CURRENCY = "X402_UNSUPPORTED_CURRENCY",
  X402_INVALID_AMOUNT = "X402_INVALID_AMOUNT",
  X402_INVALID_RECIPIENT = "X402_INVALID_RECIPIENT",
  X402_EXPIRED_REQUIREMENTS = "X402_EXPIRED_REQUIREMENTS",
  X402_REPLAY_DETECTED = "X402_REPLAY_DETECTED",
  X402_UNDERPAY = "X402_UNDERPAY",
  X402_WRONG_MINT = "X402_WRONG_MINT",
  X402_WRONG_RECIPIENT = "X402_WRONG_RECIPIENT",
  X402_VERIFICATION_FAILED = "X402_VERIFICATION_FAILED",
  X402_PAUSED = "X402_PAUSED",
  X402_RATE_LIMITED = "X402_RATE_LIMITED",
  X402_INTERNAL = "X402_INTERNAL",
}

export interface X402ErrorDefinition {
  status: number;
  message: string;
  cause: string;
  hint: string[];
}

const DEFINITIONS: Record<X402ErrorCode, X402ErrorDefinition> = {
  [X402ErrorCode.X402_PARSE_FAILED]: {
    status: 400,
    message: "Could not parse x402 requirements or proof.",
    cause: "The request payload was not valid JSON or base64(JSON).",
    hint: [
      "Send PAYMENT-REQUIRED / PAYMENT-SIGNATURE as JSON or base64(JSON).",
      "Use GET or POST /x402/doctor to inspect your request format.",
    ],
  },
  [X402ErrorCode.X402_UNSUPPORTED_DIALECT]: {
    status: 400,
    message: "Unsupported x402 dialect.",
    cause: "The request did not include any supported x402 header names.",
    hint: [
      "Use PAYMENT-REQUIRED or X-PAYMENT-REQUIRED for requirements.",
      "Use PAYMENT-SIGNATURE or X-PAYMENT for payment proof.",
    ],
  },
  [X402ErrorCode.X402_MISSING_PAYMENT_REQUIRED]: {
    status: 402,
    message: "Missing payment requirements context.",
    cause: "The request provided no x402 requirements payload.",
    hint: [
      "First request the resource and capture the 402 requirements.",
      "Retry with PAYMENT-REQUIRED or X-PAYMENT-REQUIRED.",
    ],
  },
  [X402ErrorCode.X402_MISSING_PAYMENT_PROOF]: {
    status: 402,
    message: "Missing payment proof header.",
    cause: "Request did not include X-PAYMENT or PAYMENT-SIGNATURE.",
    hint: [
      "Retry the same request with a payment proof header.",
      "Supported proof headers: X-PAYMENT, PAYMENT-SIGNATURE, X-402-PAYMENT.",
    ],
  },
  [X402ErrorCode.X402_NOT_CONFIRMED_YET]: {
    status: 409,
    message: "Payment transaction is not confirmed yet.",
    cause: "The referenced payment transaction has not reached required confirmation.",
    hint: [
      "Wait briefly and retry with the same proof.",
      "If this repeats, check transaction status on the configured cluster.",
    ],
  },
  [X402ErrorCode.X402_RPC_UNAVAILABLE]: {
    status: 503,
    message: "Payment verifier RPC is temporarily unavailable.",
    cause: "RPC provider is rate limiting or timing out verification requests.",
    hint: [
      "Retry with exponential backoff.",
      "Reduce concurrency or use a higher-throughput RPC endpoint.",
    ],
  },
  [X402ErrorCode.X402_REQUIRED_INVALID]: {
    status: 422,
    message: "Requirements payload is missing required fields.",
    cause: "One or more of amount, recipient, or currency could not be parsed.",
    hint: [
      "Verify amountAtomic, recipient, and currency are provided.",
      "Use /x402/doctor to inspect parsed requirement fields.",
    ],
  },
  [X402ErrorCode.X402_PROOF_INVALID]: {
    status: 400,
    message: "Payment proof is invalid.",
    cause: "Proof payload could not be recognized as a supported payment proof.",
    hint: [
      "Send txSig / txSignature in PAYMENT-SIGNATURE or X-PAYMENT.",
      "Ensure header value is valid JSON or base64(JSON).",
    ],
  },
  [X402ErrorCode.X402_REQUIRED_PROOF_MISMATCH]: {
    status: 409,
    message: "Payment proof does not match payment requirements.",
    cause: "Proof details differ from required amount, recipient, or currency.",
    hint: [
      "Generate a new payment proof using the latest requirements.",
      "Do not reuse payment proof from a different request.",
    ],
  },
  [X402ErrorCode.X402_UNSUPPORTED_NETWORK]: {
    status: 422,
    message: "Unsupported payment network.",
    cause: "The request targeted a network not enabled on this server.",
    hint: [
      "Use the network returned in the 402 requirements payload.",
      "Check deployment config for supported network labels.",
    ],
  },
  [X402ErrorCode.X402_UNSUPPORTED_CURRENCY]: {
    status: 422,
    message: "Unsupported payment currency.",
    cause: "The currency or mint is not accepted by this endpoint.",
    hint: [
      "Use the currency and mint returned in requirements.",
      "Do not change token symbol or mint between request and payment.",
    ],
  },
  [X402ErrorCode.X402_INVALID_AMOUNT]: {
    status: 422,
    message: "Invalid amount.",
    cause: "Amount was non-positive or not parseable as atomic units.",
    hint: [
      "Use integer atomic units greater than zero.",
      "Avoid decimal strings in amountAtomic.",
    ],
  },
  [X402ErrorCode.X402_INVALID_RECIPIENT]: {
    status: 422,
    message: "Invalid recipient address.",
    cause: "Recipient field is missing or invalid for the selected network.",
    hint: [
      "Use recipient exactly as returned in requirements.",
      "Ensure recipient is a valid address for the active network.",
    ],
  },
  [X402ErrorCode.X402_EXPIRED_REQUIREMENTS]: {
    status: 409,
    message: "Payment requirements have expired.",
    cause: "The requirements expiration timestamp is in the past.",
    hint: [
      "Request a new 402 quote and use the fresh requirements payload.",
      "Do not reuse expired requirement headers.",
    ],
  },
  [X402ErrorCode.X402_REPLAY_DETECTED]: {
    status: 409,
    message: "Replay detected for payment proof.",
    cause: "The same transaction proof has already been consumed.",
    hint: [
      "Create a new payment proof and retry.",
      "Do not reuse transaction signatures across requests.",
    ],
  },
  [X402ErrorCode.X402_UNDERPAY]: {
    status: 402,
    message: "Payment amount is below required total.",
    cause: "On-chain amount observed is lower than required amount.",
    hint: [
      "Send a new payment for the full required amount.",
      "Verify atomic units and fee-inclusive total.",
    ],
  },
  [X402ErrorCode.X402_WRONG_MINT]: {
    status: 402,
    message: "Payment mint does not match required mint.",
    cause: "Proof references a token mint different from the requirement.",
    hint: [
      "Pay with the exact mint requested in payment requirements.",
      "Do not substitute token symbols across clusters.",
    ],
  },
  [X402ErrorCode.X402_WRONG_RECIPIENT]: {
    status: 402,
    message: "Payment recipient does not match required recipient.",
    cause: "Proof references a destination address different from requirements.",
    hint: [
      "Pay to the recipient exactly as provided in requirements.",
      "Do not route funds through alternate recipient addresses.",
    ],
  },
  [X402ErrorCode.X402_VERIFICATION_FAILED]: {
    status: 402,
    message: "Payment verification failed.",
    cause: "On-chain verification did not confirm the supplied payment proof.",
    hint: [
      "Confirm transaction on the correct cluster and retry.",
      "Ensure amount, mint, and recipient match requirements exactly.",
    ],
  },
  [X402ErrorCode.X402_PAUSED]: {
    status: 503,
    message: "x402 processing is paused.",
    cause: "Operator safety switch is enabled for this route.",
    hint: [
      "Retry later after operator unpauses x402 processing.",
      "Check /health pause flags for current state.",
    ],
  },
  [X402ErrorCode.X402_RATE_LIMITED]: {
    status: 429,
    message: "Rate limit exceeded.",
    cause: "Request frequency exceeded configured safety limits.",
    hint: [
      "Use exponential backoff and retry after delay.",
      "Reduce concurrent retries for this endpoint.",
    ],
  },
  [X402ErrorCode.X402_INTERNAL]: {
    status: 500,
    message: "Internal x402 server error.",
    cause: "Unexpected server-side exception occurred.",
    hint: [
      "Retry request with provided traceId.",
      "Contact support with traceId and timestamp if issue persists.",
    ],
  },
};

export function docsAnchorForCode(code: X402ErrorCode): string {
  return `/docs/x402-compat#error-${code.toLowerCase().replace(/_/g, "-")}`;
}

export function errorDefinition(code: X402ErrorCode): X402ErrorDefinition {
  return DEFINITIONS[code];
}

export class X402Error extends Error {
  readonly code: X402ErrorCode;
  readonly httpStatus: number;
  readonly causeText: string;
  readonly hint: string[];
  readonly docsUrl: string;
  readonly traceId: string;
  readonly details?: Record<string, unknown>;

  constructor(code: X402ErrorCode, options: {
    message?: string;
    cause?: string;
    hint?: string[];
    docsUrl?: string;
    traceId?: string;
    details?: Record<string, unknown>;
  } = {}) {
    const definition = errorDefinition(code);
    super(options.message ?? definition.message);
    this.name = "X402Error";
    this.code = code;
    this.httpStatus = definition.status;
    this.causeText = options.cause ?? definition.cause;
    this.hint = options.hint ?? definition.hint;
    this.docsUrl = options.docsUrl ?? docsAnchorForCode(code);
    this.traceId = options.traceId ?? crypto.randomUUID();
    this.details = options.details;
  }

  static isX402Error(value: unknown): value is X402Error {
    return value instanceof X402Error;
  }
}

export function asX402Error(value: unknown, traceId?: string): X402Error {
  if (value instanceof X402Error) {
    return value;
  }
  if (value instanceof Error) {
    return new X402Error(X402ErrorCode.X402_INTERNAL, {
      cause: value.message,
      traceId,
    });
  }
  return new X402Error(X402ErrorCode.X402_INTERNAL, {
    cause: String(value),
    traceId,
  });
}
