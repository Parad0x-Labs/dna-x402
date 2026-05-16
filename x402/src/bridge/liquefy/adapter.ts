/**
 * DNA x Liquefy Bridge — Audit Adapter
 *
 * Transforms DNA payment audit events (NDJSON) into Liquefy-compatible
 * telemetry records that the Liquefy telemetry sink can ingest directly.
 *
 * Usage:
 *   - Standalone: pipe DNA audit export through the CLI
 *   - Server sidecar: attach to the AuditLogger and stream in real-time
 *   - Drop-in: copy the plugin folder into Liquefy's patterns/community/
 */

import type { AuditEntry, AuditEventKind } from "../../logging/audit.js";
import type { SignedReceipt } from "../../types.js";

export interface LiquefyTelemetryRecord {
  _schema: "liquefy.dna.telemetry.v1";
  _source: "dna-x402";
  ts: string;
  event_type: string;
  trace_id: string | null;
  severity: "info" | "warn" | "error";
  domain: "payment" | "receipt" | "market" | "system";
  tags: string[];
  fields: Record<string, unknown>;
}

export interface LiquefyProofArtifact {
  _schema: "liquefy.dna.proof.v1";
  _source: "dna-x402";
  artifact_type: "signed_receipt" | "anchor_proof" | "netting_batch";
  receipt_id: string;
  chain_position: number;
  ts: string;
  integrity: {
    signer_pubkey: string;
    signature: string;
    receipt_hash: string;
    prev_hash: string;
  };
  payment: {
    quote_id: string;
    commit_id: string;
    settlement: string;
    amount_atomic: string;
    fee_atomic: string;
    total_atomic: string;
    mint: string;
    recipient: string;
    settled_onchain: boolean;
    tx_signature: string | null;
  };
  resource: {
    path: string;
    shop_id: string;
    request_digest: string;
    response_digest: string;
  };
}

export interface LiquefyRunManifest {
  _schema: "liquefy.dna.run.v1";
  _source: "dna-x402";
  run_id: string;
  started_at: string;
  ended_at: string | null;
  cluster: string;
  version: string;
  total_payments: number;
  total_receipts: number;
  total_amount_atomic: string;
  mints_used: string[];
  settlements_used: string[];
  shops_involved: string[];
  proof_artifact_count: number;
}

const SEVERITY_MAP: Record<AuditEventKind, "info" | "warn" | "error"> = {
  QUOTE_ISSUED: "info",
  COMMIT_CREATED: "info",
  PAYMENT_VERIFIED: "info",
  PAYMENT_REJECTED: "error",
  RECEIPT_ISSUED: "info",
  RECEIPT_BLOCKED: "warn",
  RECEIPT_ANCHORED: "info",
  NETTING_FLUSH: "info",
  WEBHOOK_SENT: "info",
  WEBHOOK_RECEIVED: "info",
  WEBHOOK_REPLAY_REJECTED: "warn",
  WEBHOOK_FAILED: "warn",
  RATE_LIMITED: "warn",
  PAUSE_ACTIVATED: "warn",
  PAUSE_DEACTIVATED: "info",
  SHOP_REGISTERED: "info",
  SHOP_DISABLED: "warn",
  GOVERNANCE_ACTION: "warn",
  ADMIN_ACTION: "warn",
  AGENT_WALLET_REGISTERED: "info",
  PAPER_AGENT_ACCOUNT_CREATED: "info",
  PAPER_TRADE_RECORDED: "info",
  AGENT_PROFILE_UPDATED: "info",
  ALPHA_MONETIZATION_UPDATED: "warn",
  COPY_SETTINGS_CREATED: "info",
  COPY_SETTINGS_UPDATED: "info",
  COPY_SETTINGS_PAUSED: "warn",
  COPY_DECISION_EVALUATED: "info",
  COPIED_LOT_FINALIZED: "info",
  AGENT_BUILDER_DRAFT_CREATED: "info",
  AGENT_BUILDER_DRAFT_REJECTED: "warn",
  AGENT_BUILDER_DRAFT_CONFIRMED: "info",
  AGENT_RECIPE_CREATED: "info",
  AGENT_RECIPE_CLONED: "info",
  CONFIG_LOADED: "info",
  SERVER_STARTED: "info",
  SERVER_STOPPED: "info",
  GUARD_SPEND_BLOCKED: "warn",
  GUARD_REPLAY_ALERT: "warn",
  GUARD_VALIDATION_FAILED: "warn",
  GUARD_DISPUTE_TAGGED: "warn",
  GUARD_RECEIPT_VERIFIED: "info",
  GUARD_RECEIPT_INVALID: "error",
  GUARD_FAIL_OPEN: "warn",
  GUARD_RUNTIME_ERROR: "error",
};

const DOMAIN_MAP: Record<AuditEventKind, LiquefyTelemetryRecord["domain"]> = {
  QUOTE_ISSUED: "payment",
  COMMIT_CREATED: "payment",
  PAYMENT_VERIFIED: "payment",
  PAYMENT_REJECTED: "payment",
  RECEIPT_ISSUED: "receipt",
  RECEIPT_BLOCKED: "receipt",
  RECEIPT_ANCHORED: "receipt",
  NETTING_FLUSH: "payment",
  WEBHOOK_SENT: "system",
  WEBHOOK_RECEIVED: "system",
  WEBHOOK_REPLAY_REJECTED: "system",
  WEBHOOK_FAILED: "system",
  RATE_LIMITED: "system",
  PAUSE_ACTIVATED: "system",
  PAUSE_DEACTIVATED: "system",
  SHOP_REGISTERED: "market",
  SHOP_DISABLED: "market",
  GOVERNANCE_ACTION: "system",
  ADMIN_ACTION: "system",
  AGENT_WALLET_REGISTERED: "market",
  PAPER_AGENT_ACCOUNT_CREATED: "market",
  PAPER_TRADE_RECORDED: "market",
  AGENT_PROFILE_UPDATED: "market",
  ALPHA_MONETIZATION_UPDATED: "market",
  COPY_SETTINGS_CREATED: "market",
  COPY_SETTINGS_UPDATED: "market",
  COPY_SETTINGS_PAUSED: "market",
  COPY_DECISION_EVALUATED: "market",
  COPIED_LOT_FINALIZED: "market",
  AGENT_BUILDER_DRAFT_CREATED: "market",
  AGENT_BUILDER_DRAFT_REJECTED: "market",
  AGENT_BUILDER_DRAFT_CONFIRMED: "market",
  AGENT_RECIPE_CREATED: "market",
  AGENT_RECIPE_CLONED: "market",
  CONFIG_LOADED: "system",
  SERVER_STARTED: "system",
  SERVER_STOPPED: "system",
  GUARD_SPEND_BLOCKED: "payment",
  GUARD_REPLAY_ALERT: "receipt",
  GUARD_VALIDATION_FAILED: "receipt",
  GUARD_DISPUTE_TAGGED: "receipt",
  GUARD_RECEIPT_VERIFIED: "receipt",
  GUARD_RECEIPT_INVALID: "receipt",
  GUARD_FAIL_OPEN: "system",
  GUARD_RUNTIME_ERROR: "system",
};

export function auditEntryToTelemetry(entry: AuditEntry): LiquefyTelemetryRecord {
  const tags: string[] = [`kind:${entry.kind}`];
  if (entry.settlement) tags.push(`settlement:${entry.settlement}`);
  if (entry.shopId) tags.push(`shop:${entry.shopId}`);
  if (entry.mint) tags.push(`mint:${entry.mint}`);
  if (entry.errorCode) tags.push(`error:${entry.errorCode}`);

  const fields: Record<string, unknown> = {
    audit_id: entry.id,
    kind: entry.kind,
  };
  if (entry.quoteId) fields.quote_id = entry.quoteId;
  if (entry.commitId) fields.commit_id = entry.commitId;
  if (entry.receiptId) fields.receipt_id = entry.receiptId;
  if (entry.amountAtomic) fields.amount_atomic = entry.amountAtomic;
  if (entry.mint) fields.mint = entry.mint;
  if (entry.recipient) fields.recipient = entry.recipient;
  if (entry.settlement) fields.settlement = entry.settlement;
  if (entry.durationMs !== undefined) fields.duration_ms = entry.durationMs;
  if (entry.errorCode) fields.error_code = entry.errorCode;
  if (entry.errorMessage) fields.error_message = entry.errorMessage;
  if (entry.meta) fields.meta = entry.meta;

  return {
    _schema: "liquefy.dna.telemetry.v1",
    _source: "dna-x402",
    ts: entry.ts,
    event_type: entry.kind,
    trace_id: entry.traceId ?? null,
    severity: SEVERITY_MAP[entry.kind] ?? "info",
    domain: DOMAIN_MAP[entry.kind] ?? "system",
    tags,
    fields,
  };
}

let proofCounter = 0;

export function receiptToProofArtifact(receipt: SignedReceipt): LiquefyProofArtifact {
  proofCounter += 1;
  return {
    _schema: "liquefy.dna.proof.v1",
    _source: "dna-x402",
    artifact_type: "signed_receipt",
    receipt_id: receipt.payload.receiptId,
    chain_position: proofCounter,
    ts: receipt.payload.createdAt,
    integrity: {
      signer_pubkey: receipt.signerPublicKey,
      signature: receipt.signature,
      receipt_hash: receipt.receiptHash,
      prev_hash: receipt.prevHash,
    },
    payment: {
      quote_id: receipt.payload.quoteId,
      commit_id: receipt.payload.commitId,
      settlement: receipt.payload.settlement,
      amount_atomic: receipt.payload.amountAtomic,
      fee_atomic: receipt.payload.feeAtomic,
      total_atomic: receipt.payload.totalAtomic,
      mint: receipt.payload.mint,
      recipient: receipt.payload.recipient,
      settled_onchain: receipt.payload.settledOnchain,
      tx_signature: receipt.payload.txSignature ?? null,
    },
    resource: {
      path: receipt.payload.resource,
      shop_id: receipt.payload.shopId,
      request_digest: receipt.payload.requestDigest,
      response_digest: receipt.payload.responseDigest,
    },
  };
}

export function buildRunManifest(
  runId: string,
  startedAt: string,
  receipts: SignedReceipt[],
  cluster: string,
  version: string,
): LiquefyRunManifest {
  const mints = new Set<string>();
  const settlements = new Set<string>();
  const shops = new Set<string>();
  let totalAtomic = 0n;

  for (const r of receipts) {
    mints.add(r.payload.mint);
    settlements.add(r.payload.settlement);
    shops.add(r.payload.shopId);
    totalAtomic += BigInt(r.payload.totalAtomic);
  }

  return {
    _schema: "liquefy.dna.run.v1",
    _source: "dna-x402",
    run_id: runId,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    cluster,
    version,
    total_payments: receipts.length,
    total_receipts: receipts.length,
    total_amount_atomic: totalAtomic.toString(10),
    mints_used: Array.from(mints),
    settlements_used: Array.from(settlements),
    shops_involved: Array.from(shops),
    proof_artifact_count: receipts.length,
  };
}

export function ndjsonLine(record: LiquefyTelemetryRecord | LiquefyProofArtifact | LiquefyRunManifest): string {
  return JSON.stringify(record);
}
