/**
 * Layer: Compliance receipt data contract
 *
 * TypeScript mirror of the `dark-compliance-receipts` Rust crate format.
 * Tests subject hash derivation, result hash derivation, receipt hash
 * aggregation, and public record JSON serialisation rules.
 *
 * No source imports needed. All hash functions are implemented inline
 * using node:crypto SHA-256.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inline implementation — mirrors dark-compliance-receipts Rust crate
// ---------------------------------------------------------------------------

/**
 * Computes a 32-byte subject hash.
 * Domain-separated with "compliance-subject-v1" to prevent cross-domain
 * collisions.
 */
function subjectHash(subjectData: Buffer): Buffer {
  return createHash("sha256")
    .update("compliance-subject-v1")
    .update(subjectData)
    .digest();
}

/** Check type codes (single byte) */
const CHECK_TYPE = {
  aml:      0x01,
  sanctions: 0x02,
  kyc:      0x03,
} as const;
type CheckTypeKey = keyof typeof CHECK_TYPE;

/**
 * Computes a 32-byte result hash encoding the compliance outcome.
 *
 * passed_byte : 0x01 = passed, 0x00 = failed
 * checkType_byte: one of CHECK_TYPE values
 * checkedAt_le  : 8-byte little-endian unix timestamp (u64)
 */
function resultHash(passed: boolean, checkType: CheckTypeKey, checkedAt: bigint): Buffer {
  const passedByte    = Buffer.from([passed ? 0x01 : 0x00]);
  const checkTypeByte = Buffer.from([CHECK_TYPE[checkType]]);
  const checkedAtBuf  = Buffer.alloc(8);
  checkedAtBuf.writeBigUInt64LE(checkedAt, 0);

  return createHash("sha256")
    .update("compliance-result-v1")
    .update(passedByte)
    .update(checkTypeByte)
    .update(checkedAtBuf)
    .digest();
}

/**
 * Computes a 32-byte receipt hash binding subject and result together.
 *
 * receipt_hash = SHA256("compliance-receipt-v1" || subject_hash || result_hash || checkedAt_le)
 */
function receiptHash(
  subjectH: Buffer,
  resultH: Buffer,
  checkedAt: bigint,
): Buffer {
  const checkedAtBuf = Buffer.alloc(8);
  checkedAtBuf.writeBigUInt64LE(checkedAt, 0);

  return createHash("sha256")
    .update("compliance-receipt-v1")
    .update(subjectH)
    .update(resultH)
    .update(checkedAtBuf)
    .digest();
}

interface ComplianceReceipt {
  subjectH: Buffer;   // 32-byte subject hash (subject identity hidden)
  resultH: Buffer;    // 32-byte result hash
  receiptH: Buffer;   // 32-byte final receipt hash
  checkedAt: bigint;
}

function buildReceipt(
  subjectData: Buffer,
  passed: boolean,
  checkType: CheckTypeKey,
  checkedAt: bigint,
): ComplianceReceipt {
  const sHash = subjectHash(subjectData);
  const rHash = resultHash(passed, checkType, checkedAt);
  const rcHash = receiptHash(sHash, rHash, checkedAt);
  return { subjectH: sHash, resultH: rHash, receiptH: rcHash, checkedAt };
}

/**
 * Public record JSON — exposes receipt_hash for auditability but intentionally
 * omits subject_hash to preserve subject identity privacy.
 */
function publicRecordJson(receipt: ComplianceReceipt): string {
  return JSON.stringify({
    receipt_hash: receipt.receiptH.toString("hex"),
    checked_at: receipt.checkedAt.toString(),
    // subject_hash is intentionally absent — subject identity hidden
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compliance receipt data contract", () => {
  const SUBJECT_DATA   = Buffer.from("wallet:5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM", "utf8");
  const CHECKED_AT     = 1_700_000_000n;

  it("subject_hash = SHA256('compliance-subject-v1' || subjectData) — 32 bytes", () => {
    const hash = subjectHash(SUBJECT_DATA);
    expect(hash).toBeInstanceOf(Buffer);
    expect(hash.length).toBe(32);

    // Verify the exact construction
    const expected = createHash("sha256")
      .update("compliance-subject-v1")
      .update(SUBJECT_DATA)
      .digest();
    expect(hash.equals(expected)).toBe(true);
  });

  it("different subject data → different subject_hash", () => {
    const other = Buffer.from("wallet:AnotherWalletAddress", "utf8");
    const h1 = subjectHash(SUBJECT_DATA);
    const h2 = subjectHash(other);
    expect(h1.equals(h2)).toBe(false);
  });

  it("result_hash = SHA256('compliance-result-v1' || passed_byte || checkType_byte || checkedAt_le) — 32 bytes", () => {
    const hash = resultHash(true, "aml", CHECKED_AT);
    expect(hash).toBeInstanceOf(Buffer);
    expect(hash.length).toBe(32);

    // Verify the exact construction
    const checkedAtBuf = Buffer.alloc(8);
    checkedAtBuf.writeBigUInt64LE(CHECKED_AT, 0);
    const expected = createHash("sha256")
      .update("compliance-result-v1")
      .update(Buffer.from([0x01]))        // passed
      .update(Buffer.from([0x01]))        // aml
      .update(checkedAtBuf)
      .digest();
    expect(hash.equals(expected)).toBe(true);
  });

  it("failed check has different result_hash than passed check (same other inputs)", () => {
    const passed = resultHash(true,  "kyc", CHECKED_AT);
    const failed = resultHash(false, "kyc", CHECKED_AT);
    expect(passed.equals(failed)).toBe(false);
  });

  it("receipt_hash = SHA256('compliance-receipt-v1' || subject_hash || result_hash || checkedAt_le) — 32 bytes", () => {
    const sHash = subjectHash(SUBJECT_DATA);
    const rHash = resultHash(true, "sanctions", CHECKED_AT);
    const rcHash = receiptHash(sHash, rHash, CHECKED_AT);

    expect(rcHash).toBeInstanceOf(Buffer);
    expect(rcHash.length).toBe(32);

    // Verify the exact construction
    const checkedAtBuf = Buffer.alloc(8);
    checkedAtBuf.writeBigUInt64LE(CHECKED_AT, 0);
    const expected = createHash("sha256")
      .update("compliance-receipt-v1")
      .update(sHash)
      .update(rHash)
      .update(checkedAtBuf)
      .digest();
    expect(rcHash.equals(expected)).toBe(true);
  });

  it("public record JSON contains receipt_hash but NOT subject_hash", () => {
    const receipt = buildReceipt(SUBJECT_DATA, true, "aml", CHECKED_AT);
    const json = publicRecordJson(receipt);
    const parsed = JSON.parse(json);

    // receipt_hash must be present and correct
    expect(parsed).toHaveProperty("receipt_hash");
    expect(parsed.receipt_hash).toBe(receipt.receiptH.toString("hex"));

    // subject_hash must NOT appear (subject identity hidden)
    expect(json).not.toContain(receipt.subjectH.toString("hex"));
    expect(json).not.toContain("subject_hash");
  });
});
