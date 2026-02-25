import { Buffer } from "node:buffer";
import { CanonicalPaymentProof, CanonicalPaymentRequired, CanonicalX402Context, CompatRequestLike } from "./types.js";

export const PAYMENT_REQUIRED_HEADERS = [
  "payment-required",
  "x-payment-required",
  "x-402-payment-required",
] as const;

export const PAYMENT_PROOF_HEADERS = [
  "payment-signature",
  "x-payment",
  "x-402-payment",
] as const;

function normalizeHeaders(input: CompatRequestLike["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    const normalized = key.toLowerCase();
    if (Array.isArray(value)) {
      out[normalized] = value.join(",");
    } else if (typeof value === "string") {
      out[normalized] = value;
    }
  }
  return out;
}

function firstPresent(headers: Record<string, string>, names: readonly string[]): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = headers[name];
    if (value && value.trim().length > 0) {
      return { name, value };
    }
  }
  return undefined;
}

function parseMaybeJsonOrBase64(value: unknown): { parsed?: unknown; warning?: string; opaque?: string } {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value === "object") {
    return { parsed: value };
  }

  if (typeof value !== "string") {
    return { warning: `unsupported value type: ${typeof value}`, opaque: String(value) };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { warning: "empty value" };
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { parsed: JSON.parse(trimmed) };
    } catch {
      return { warning: "invalid JSON payload", opaque: trimmed };
    }
  }

  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded.startsWith("{") || decoded.startsWith("[")) {
      return { parsed: JSON.parse(decoded) };
    }
  } catch {
    // continue as opaque
  }

  return { warning: "opaque string payload", opaque: trimmed };
}

function normalizeNetwork(input: unknown): CanonicalPaymentRequired["network"] {
  const text = String(input ?? "unknown").toLowerCase();
  if (text.includes("solana")) {
    return "solana";
  }
  if (text.includes("base") || text.includes("evm")) {
    return "base";
  }
  return "unknown";
}

function normalizeAmountAtomic(input: unknown): string | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  const raw = String(input).trim();
  return /^\d+$/.test(raw) ? raw : undefined;
}

function normalizeStyle(requiredHeader?: string, proofHeader?: string): CanonicalX402Context["style"] {
  if (requiredHeader === "payment-required" || proofHeader === "payment-signature") {
    return "coinbase";
  }
  if (proofHeader === "x-payment") {
    return "memeputer";
  }
  if (requiredHeader?.startsWith("x-") || proofHeader?.startsWith("x-")) {
    return "generic";
  }
  return "unknown";
}

function canonicalizeRequired(parsed: unknown, headers: Record<string, string>, body: unknown): CanonicalPaymentRequired | undefined {
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  const obj = parsed as Record<string, unknown>;
  const settlementObj = (obj.settlement && typeof obj.settlement === "object") ? obj.settlement as Record<string, unknown> : undefined;

  const network = normalizeNetwork(obj.network ?? settlementObj?.network ?? settlementObj?.chain ?? obj.chain);
  const amountAtomic = normalizeAmountAtomic(
    obj.amountAtomic ?? obj.amount ?? obj.totalAtomic ?? obj.maxAmount ?? settlementObj?.amountAtomic,
  );
  const recipient = String(obj.recipient ?? obj.to ?? obj.payTo ?? settlementObj?.recipient ?? "").trim();
  const currency = String(obj.currency ?? obj.asset ?? obj.symbol ?? obj.mintSymbol ?? settlementObj?.currency ?? "").trim();
  const memo = obj.memo ? String(obj.memo) : undefined;
  const expiresRaw = obj.expiresAt ?? obj.expires_at ?? obj.expiry;
  const expiresAt = expiresRaw !== undefined ? Number(expiresRaw) : undefined;

  const modeRaw = String(settlementObj?.mode ?? obj.mode ?? "").toLowerCase();
  let mode: CanonicalPaymentRequired["settlement"]["mode"] = "unknown";
  if (modeRaw.includes("spl") || modeRaw.includes("solana") || modeRaw.includes("transfer")) {
    mode = "spl_transfer";
  } else if (modeRaw.includes("evm")) {
    mode = "evm_transfer";
  }

  const chainIdRaw = settlementObj?.chainId ?? obj.chainId;
  const chainId = chainIdRaw !== undefined && Number.isFinite(Number(chainIdRaw)) ? Number(chainIdRaw) : undefined;
  const mint = String(settlementObj?.mint ?? obj.mint ?? "").trim() || undefined;

  if (!amountAtomic || !recipient || !currency) {
    return undefined;
  }

  return {
    version: "x402-v1",
    network,
    currency,
    amountAtomic,
    recipient,
    ...(memo ? { memo } : {}),
    ...(expiresAt && Number.isFinite(expiresAt) ? { expiresAt } : {}),
    settlement: {
      mode,
      ...(mint ? { mint } : {}),
      ...(chainId !== undefined ? { chainId } : {}),
    },
    raw: { headers, body },
  };
}

function canonicalizeProof(parsed: unknown, opaque: string | undefined, headers: Record<string, string>, body: unknown): CanonicalPaymentProof | undefined {
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const txSig = String(obj.txSig ?? obj.txSignature ?? obj.signature ?? obj.paymentSignature ?? "").trim() || undefined;
    const sender = String(obj.sender ?? obj.from ?? obj.payer ?? "").trim() || undefined;
    const amountAtomic = normalizeAmountAtomic(obj.amountAtomic ?? obj.amount ?? obj.totalAtomic);
    const recipient = String(obj.recipient ?? obj.to ?? "").trim() || undefined;
    const currency = String(obj.currency ?? obj.symbol ?? obj.asset ?? "").trim() || undefined;
    const schemeRaw = String(obj.scheme ?? obj.network ?? "").toLowerCase();
    const scheme = schemeRaw.includes("evm") || schemeRaw.includes("base")
      ? "evm"
      : txSig
        ? "solana_spl"
        : "unknown";

    return {
      version: "x402-proof-v1",
      scheme,
      ...(txSig ? { txSig } : {}),
      ...(sender ? { sender } : {}),
      ...(amountAtomic ? { amountAtomic } : {}),
      ...(recipient ? { recipient } : {}),
      ...(currency ? { currency } : {}),
      raw: { headers, body },
    };
  }

  if (opaque) {
    return {
      version: "x402-proof-v1",
      scheme: "unknown",
      proofBlob: opaque,
      raw: { headers, body },
    };
  }

  return undefined;
}

function bodyRequiredCandidate(body: unknown): unknown {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const b = body as Record<string, unknown>;
  return b.paymentRequired ?? b.payment_required ?? b.requirements ?? b.paymentRequirements;
}

function bodyProofCandidate(body: unknown): unknown {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const b = body as Record<string, unknown>;
  return b.payment ?? b.paymentProof ?? b.proof;
}

function contextsMatch(reqA: CanonicalPaymentRequired, proof: CanonicalPaymentProof): boolean {
  if (proof.amountAtomic && proof.amountAtomic !== reqA.amountAtomic) {
    return false;
  }
  if (proof.recipient && proof.recipient !== reqA.recipient) {
    return false;
  }
  if (proof.currency && proof.currency.toUpperCase() !== reqA.currency.toUpperCase()) {
    return false;
  }
  return true;
}

export function parsePaymentRequired(input: CompatRequestLike): CanonicalX402Context {
  const headers = normalizeHeaders(input.headers);
  const warnings: string[] = [];

  const headerCandidate = firstPresent(headers, PAYMENT_REQUIRED_HEADERS);
  const bodyCandidate = bodyRequiredCandidate(input.body);

  const parsedHeader = headerCandidate ? parseMaybeJsonOrBase64(headerCandidate.value) : {};
  const parsedBody = bodyCandidate !== undefined ? parseMaybeJsonOrBase64(bodyCandidate) : {};

  if (parsedHeader.warning) {
    warnings.push(`payment-required header: ${parsedHeader.warning}`);
  }
  if (parsedBody.warning) {
    warnings.push(`payment-required body: ${parsedBody.warning}`);
  }

  const required = canonicalizeRequired(
    parsedHeader.parsed ?? parsedBody.parsed,
    headers,
    input.body,
  );

  return {
    required,
    style: normalizeStyle(headerCandidate?.name),
    parseWarnings: warnings,
  };
}

export function parsePaymentProof(input: CompatRequestLike): CanonicalX402Context {
  const headers = normalizeHeaders(input.headers);
  const warnings: string[] = [];

  const headerCandidate = firstPresent(headers, PAYMENT_PROOF_HEADERS);
  const bodyCandidate = bodyProofCandidate(input.body);

  const parsedHeader = headerCandidate ? parseMaybeJsonOrBase64(headerCandidate.value) : {};
  const parsedBody = bodyCandidate !== undefined ? parseMaybeJsonOrBase64(bodyCandidate) : {};

  if (parsedHeader.warning) {
    warnings.push(`payment-proof header: ${parsedHeader.warning}`);
  }
  if (parsedBody.warning) {
    warnings.push(`payment-proof body: ${parsedBody.warning}`);
  }

  const parsedValue = parsedHeader.parsed ?? parsedBody.parsed;
  const opaque = parsedHeader.opaque ?? parsedBody.opaque;
  const proof = canonicalizeProof(parsedValue, opaque, headers, input.body);

  return {
    proof,
    style: normalizeStyle(undefined, headerCandidate?.name),
    parseWarnings: warnings,
  };
}

export function normalizeX402(input: CompatRequestLike): CanonicalX402Context {
  const requiredCtx = parsePaymentRequired(input);
  const proofCtx = parsePaymentProof(input);
  const style = normalizeStyle(
    requiredCtx.style === "coinbase" || requiredCtx.style === "generic" ? firstPresent(normalizeHeaders(input.headers), PAYMENT_REQUIRED_HEADERS)?.name : undefined,
    proofCtx.style === "coinbase" || proofCtx.style === "memeputer" || proofCtx.style === "generic"
      ? firstPresent(normalizeHeaders(input.headers), PAYMENT_PROOF_HEADERS)?.name
      : undefined,
  );

  const parseWarnings = [...requiredCtx.parseWarnings, ...proofCtx.parseWarnings];

  if (requiredCtx.required && proofCtx.proof && !contextsMatch(requiredCtx.required, proofCtx.proof)) {
    parseWarnings.push("requirements/proof mismatch on amount, recipient, or currency");
  }

  return {
    required: requiredCtx.required,
    proof: proofCtx.proof,
    style,
    parseWarnings,
  };
}

export function encodeCanonicalRequiredHeader(required: CanonicalPaymentRequired): string {
  return Buffer.from(JSON.stringify(required), "utf8").toString("base64");
}

export function encodeCanonicalProofHeader(proof: CanonicalPaymentProof): string {
  return Buffer.from(JSON.stringify(proof), "utf8").toString("base64");
}
