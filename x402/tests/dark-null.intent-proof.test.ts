import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Inline implementation: intent commitment hash
// Mirrors the dark-intent-proof Rust crate contract.
// ---------------------------------------------------------------------------

function intentCommitmentHash(
  intentBytes: Buffer,
  nonce: Buffer,
  timestamp: bigint,
): Buffer {
  const timestampBuf = Buffer.alloc(8);
  timestampBuf.writeBigUInt64LE(timestamp);
  return createHash("sha256")
    .update(Buffer.from("intent-commit-v1", "utf8"))
    .update(intentBytes)
    .update(nonce)
    .update(timestampBuf)
    .digest();
}

interface IntentRecord {
  intentType: string;
  commitmentHash: string;
  mainnet_ready: boolean;
}

function makeIntentPublicRecord(
  intentType: string,
  intentBytes: Buffer,
  nonce: Buffer,
  timestamp: bigint,
): IntentRecord {
  return {
    intentType,
    commitmentHash: intentCommitmentHash(intentBytes, nonce, timestamp).toString("hex"),
    mainnet_ready: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const INTENT_BYTES_A = Buffer.from(JSON.stringify({ action: "buy", market: "BTC-USD", qty: 1 }), "utf8");
const INTENT_BYTES_B = Buffer.from(JSON.stringify({ action: "sell", market: "ETH-USD", qty: 2 }), "utf8");
const NONCE_1 = Buffer.from("nonce-intent-0000000000000000000001", "utf8");
const NONCE_2 = Buffer.from("nonce-intent-0000000000000000000002", "utf8");
const TIMESTAMP_1 = 1748217600n; // 2025-05-26T00:00:00Z

describe("dark-null intent commitment/reveal (ZK contract mirror)", () => {
  it("commitment_hash = SHA256(intent-commit-v1 || intent_bytes || nonce || timestamp_le8) — 32 bytes", () => {
    const hash = intentCommitmentHash(INTENT_BYTES_A, NONCE_1, TIMESTAMP_1);
    expect(hash).toBeInstanceOf(Buffer);
    expect(hash.length).toBe(32);

    // Verify the construction manually.
    const timestampBuf = Buffer.alloc(8);
    timestampBuf.writeBigUInt64LE(TIMESTAMP_1);
    const expected = createHash("sha256")
      .update(Buffer.from("intent-commit-v1", "utf8"))
      .update(INTENT_BYTES_A)
      .update(NONCE_1)
      .update(timestampBuf)
      .digest();
    expect(hash).toEqual(expected);
  });

  it("same intent + nonce + timestamp → same commitment (deterministic)", () => {
    const h1 = intentCommitmentHash(INTENT_BYTES_A, NONCE_1, TIMESTAMP_1);
    const h2 = intentCommitmentHash(INTENT_BYTES_A, NONCE_1, TIMESTAMP_1);
    expect(h1).toEqual(h2);
  });

  it("different nonce → different commitment (nonce-binding)", () => {
    const h1 = intentCommitmentHash(INTENT_BYTES_A, NONCE_1, TIMESTAMP_1);
    const h2 = intentCommitmentHash(INTENT_BYTES_A, NONCE_2, TIMESTAMP_1);
    expect(h1).not.toEqual(h2);
  });

  it("reveal: recomputed hash matches stored commitment", () => {
    const stored = intentCommitmentHash(INTENT_BYTES_A, NONCE_1, TIMESTAMP_1);
    // Simulate reveal: re-derive from the same revealed inputs.
    const revealed = intentCommitmentHash(INTENT_BYTES_A, NONCE_1, TIMESTAMP_1);
    expect(revealed).toEqual(stored);
  });

  it("wrong intent bytes in reveal → hash mismatch (reveal fails)", () => {
    const stored = intentCommitmentHash(INTENT_BYTES_A, NONCE_1, TIMESTAMP_1);
    const tamperedReveal = intentCommitmentHash(INTENT_BYTES_B, NONCE_1, TIMESTAMP_1);
    expect(tamperedReveal).not.toEqual(stored);
  });

  it("public_record JSON contains commitment_hash and intent_type but NOT intent_bytes", () => {
    const record = makeIntentPublicRecord("buy_order", INTENT_BYTES_A, NONCE_1, TIMESTAMP_1);

    expect(record).toHaveProperty("commitmentHash");
    expect(typeof record.commitmentHash).toBe("string");
    expect(record.commitmentHash.length).toBe(64); // 32 bytes = 64 hex chars
    expect(record).toHaveProperty("intentType", "buy_order");

    const raw = JSON.stringify(record);
    // intent_bytes must not appear in the record.
    expect(raw).not.toContain(INTENT_BYTES_A.toString("utf8"));
    expect(raw).not.toContain(INTENT_BYTES_A.toString("base64"));
  });
});
