/**
 * Layer: Agent payment session data contract
 *
 * TypeScript mirror of the `dark-agent-payment-sdk` Rust crate format.
 * Tests session ID derivation, session evidence JSON rules, and tamper
 * detection for agent payment sessions.
 *
 * No source imports needed. All session functions are implemented inline
 * using node:crypto SHA-256.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inline implementation — mirrors dark-agent-payment-sdk Rust crate
// ---------------------------------------------------------------------------

/**
 * Derives a 32-byte session ID.
 * Domain-separated with "agent-session-v1" so distinct session versions
 * cannot collide.
 */
function makeSessionId(capabilityHash: Buffer, receiptHash: Buffer): Buffer {
  return createHash("sha256")
    .update("agent-session-v1")
    .update(capabilityHash)
    .update(receiptHash)
    .digest();
}

interface AgentPaymentSession {
  sessionId: Buffer;       // 32-byte derived session ID
  capabilityHash: Buffer;  // 32-byte hash of agent capability
  receiptHash: Buffer;     // 32-byte hash of payment receipt
  agentIdHash: Buffer;     // 32-byte hash of agent identity (raw agent_id is NOT stored)
  createdAt: number;       // unix timestamp
}

function newAgentPaymentSession(
  capabilityHash: Buffer,
  receiptHash: Buffer,
  agentIdHash: Buffer,
  createdAt: number,
): AgentPaymentSession {
  return {
    sessionId: makeSessionId(capabilityHash, receiptHash),
    capabilityHash,
    receiptHash,
    agentIdHash,
    createdAt,
  };
}

/**
 * Session evidence JSON — exposes session_id and receipt_hash for
 * verifiability but intentionally omits raw agent_id bytes.
 */
function sessionEvidenceJson(session: AgentPaymentSession): string {
  return JSON.stringify({
    session_id: session.sessionId.toString("hex"),
    receipt_hash: session.receiptHash.toString("hex"),
    agent_id_hash: session.agentIdHash.toString("hex"),
    created_at: session.createdAt,
    // raw agent_id bytes are intentionally absent
  });
}

/**
 * Verifies a session by recomputing the session_id from the stored inputs
 * and comparing against the stored session_id.
 */
function verifySession(session: AgentPaymentSession): boolean {
  const recomputed = makeSessionId(session.capabilityHash, session.receiptHash);
  return recomputed.equals(session.sessionId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent payment session data contract", () => {
  const CAPABILITY_HASH = createHash("sha256").update("capability:inference-v1").digest();
  const RECEIPT_HASH    = createHash("sha256").update("receipt:payment-abc123").digest();
  const AGENT_ID_RAW    = Buffer.from("raw-agent-id-bytes-do-not-expose-in-json", "utf8");
  const AGENT_ID_HASH   = createHash("sha256").update("agent-id:").update(AGENT_ID_RAW).digest();

  it("session ID is 32 bytes (hex string length 64)", () => {
    const id = makeSessionId(CAPABILITY_HASH, RECEIPT_HASH);
    expect(id).toBeInstanceOf(Buffer);
    expect(id.length).toBe(32);
    expect(id.toString("hex")).toHaveLength(64);
    expect(id.toString("hex")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("session ID = SHA256('agent-session-v1' || capability_hash || receipt_hash)", () => {
    const expected = createHash("sha256")
      .update("agent-session-v1")
      .update(CAPABILITY_HASH)
      .update(RECEIPT_HASH)
      .digest();
    const actual = makeSessionId(CAPABILITY_HASH, RECEIPT_HASH);
    expect(actual.equals(expected)).toBe(true);
  });

  it("different capability_hash produces different session_id", () => {
    const altCapability = createHash("sha256").update("capability:vision-v1").digest();
    const id1 = makeSessionId(CAPABILITY_HASH, RECEIPT_HASH);
    const id2 = makeSessionId(altCapability, RECEIPT_HASH);
    expect(id1.equals(id2)).toBe(false);
  });

  it("different receipt_hash produces different session_id", () => {
    const altReceipt = createHash("sha256").update("receipt:payment-xyz789").digest();
    const id1 = makeSessionId(CAPABILITY_HASH, RECEIPT_HASH);
    const id2 = makeSessionId(CAPABILITY_HASH, altReceipt);
    expect(id1.equals(id2)).toBe(false);
  });

  it("session_evidence_json contains session_id and receipt_hash fields", () => {
    const session = newAgentPaymentSession(CAPABILITY_HASH, RECEIPT_HASH, AGENT_ID_HASH, 1_700_000_000);
    const json = sessionEvidenceJson(session);
    const parsed = JSON.parse(json);

    expect(parsed).toHaveProperty("session_id");
    expect(parsed).toHaveProperty("receipt_hash");
    expect(parsed.session_id).toBe(session.sessionId.toString("hex"));
    expect(parsed.receipt_hash).toBe(RECEIPT_HASH.toString("hex"));
  });

  it("session_evidence_json does NOT contain raw agent_id bytes", () => {
    const session = newAgentPaymentSession(CAPABILITY_HASH, RECEIPT_HASH, AGENT_ID_HASH, 1_700_000_000);
    const json = sessionEvidenceJson(session);

    // The raw bytes must not appear as utf8
    expect(json).not.toContain("raw-agent-id-bytes-do-not-expose-in-json");
    // Nor as hex
    const rawHex = AGENT_ID_RAW.toString("hex");
    expect(json).not.toContain(rawHex);
  });

  it("verify session: recomputed session_id matches stored → true", () => {
    const session = newAgentPaymentSession(CAPABILITY_HASH, RECEIPT_HASH, AGENT_ID_HASH, 1_700_000_000);
    expect(verifySession(session)).toBe(true);
  });

  it("verify tampered: flipped byte in session_id → false", () => {
    const session = newAgentPaymentSession(CAPABILITY_HASH, RECEIPT_HASH, AGENT_ID_HASH, 1_700_000_000);
    // Flip the first byte of the stored session_id without changing the inputs
    const tamperedId = Buffer.from(session.sessionId);
    tamperedId[0] ^= 0xff;
    const tampered: AgentPaymentSession = { ...session, sessionId: tamperedId };
    expect(verifySession(tampered)).toBe(false);
  });
});
