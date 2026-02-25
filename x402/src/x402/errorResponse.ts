import type { Request, Response } from "express";
import { headerNamesOnly, redactValue } from "../logging/redact.js";
import { X402Error, X402ErrorCode, asX402Error } from "./errors.js";

interface ErrorContext {
  dialectDetected?: string;
  missing?: string[];
  receivedHeaders?: Record<string, string | undefined>;
  paymentRequired?: unknown;
  paymentProof?: unknown;
  exampleCurl?: string;
}

function normalizeHints(hint: string[]): string[] {
  return hint.filter(Boolean).slice(0, 4);
}

function redactedBlock(context: ErrorContext): { paymentRequired?: string | null; paymentProof?: string | null } | undefined {
  const paymentRequired = context.paymentRequired !== undefined ? redactValue(context.paymentRequired) : undefined;
  const paymentProof = context.paymentProof !== undefined ? redactValue(context.paymentProof) : undefined;

  if (paymentRequired === undefined && paymentProof === undefined) {
    return undefined;
  }

  return {
    paymentRequired,
    paymentProof,
  };
}

function defaultCurl(code: X402ErrorCode): string {
  if (code === X402ErrorCode.X402_MISSING_PAYMENT_PROOF) {
    return "curl -H 'PAYMENT-SIGNATURE: <proof>' -H 'PAYMENT-REQUIRED: <requirements>' https://your-host/resource";
  }
  return "curl -X POST https://your-host/x402/doctor -H 'content-type: application/json' -d '{\"headers\":{}}'";
}

export function toErrorPayload(error: X402Error, context: ErrorContext = {}): {
  error: {
    code: string;
    message: string;
    cause: string;
    hint: string[];
    dialectDetected: string;
    missing: string[];
    receivedHeaders: string[];
    redacted?: {
      paymentRequired?: string | null;
      paymentProof?: string | null;
    };
    exampleFix: { curl: string };
    traceId: string;
    docsUrl: string;
  };
} {
  const receivedHeaders = context.receivedHeaders ? headerNamesOnly(context.receivedHeaders) : [];
  const redacted = redactedBlock(context);

  return {
    error: {
      code: error.code,
      message: error.message,
      cause: error.causeText,
      hint: normalizeHints(error.hint),
      dialectDetected: context.dialectDetected ?? "unknown",
      missing: context.missing ?? [],
      receivedHeaders,
      ...(redacted ? { redacted } : {}),
      exampleFix: {
        curl: context.exampleCurl ?? defaultCurl(error.code),
      },
      traceId: error.traceId,
      docsUrl: error.docsUrl,
    },
  };
}

export function sendX402Error(req: Request, res: Response, rawError: unknown, context: ErrorContext = {}): Response {
  const error = asX402Error(rawError, req.traceId);
  const payload = toErrorPayload(error, {
    ...context,
    receivedHeaders: context.receivedHeaders ?? Object.fromEntries(
      Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : (value ?? undefined)]),
    ),
  });
  res.setHeader("X-TRACE-ID", error.traceId);
  return res.status(error.httpStatus).json(payload);
}
