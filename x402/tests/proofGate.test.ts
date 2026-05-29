import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  STATEMENT_KIND,
  CLAIM_RECORD_LEN,
  getClaimPda,
  hashReceiptPayload,
  hashString,
  hashBytes,
  buildRecordClaimData,
  decodeClaimRecord,
} from "../src/sdk/proofGate.js";

// ── STATEMENT_KIND constants ──────────────────────────────────────────────────

describe("STATEMENT_KIND", () => {
  it("has correct byte values matching on-chain spec", () => {
    expect(STATEMENT_KIND.RECEIPT_REDEEM).toBe(0x10);
    expect(STATEMENT_KIND.SESSION_NET_SETTLEMENT).toBe(0x11);
    expect(STATEMENT_KIND.MODEL_OUTPUT_BOUND).toBe(0x12);
    expect(STATEMENT_KIND.NULLIFIER_NOT_REUSED).toBe(0x13);
    expect(STATEMENT_KIND.API_METER_BURN).toBe(0x14);
    expect(STATEMENT_KIND.PREDICTION_COMMIT_REVEAL).toBe(0x15);
  });

  it("CLAIM_RECORD_LEN matches on-chain layout 1+32+32+1+8 = 74", () => {
    expect(CLAIM_RECORD_LEN).toBe(74);
  });
});

// ── buildRecordClaimData ──────────────────────────────────────────────────────

describe("buildRecordClaimData", () => {
  it("produces 34-byte buffer with correct layout", () => {
    const hash = new Uint8Array(32).fill(0xab);
    const buf = buildRecordClaimData(hash, STATEMENT_KIND.RECEIPT_REDEEM);
    expect(buf.length).toBe(34);
    expect(buf[0]).toBe(0x00); // discriminant
    expect(Array.from(buf.slice(1, 33))).toEqual(Array.from(hash));
    expect(buf[33]).toBe(0x10); // RECEIPT_REDEEM
  });

  it("encodes every valid statement kind", () => {
    const hash = new Uint8Array(32).fill(0x01);
    const kinds = [0x10, 0x11, 0x12, 0x13, 0x14, 0x15] as const;
    for (const kind of kinds) {
      const buf = buildRecordClaimData(hash, kind);
      expect(buf[33]).toBe(kind);
    }
  });

  it("throws on hash length != 32", () => {
    expect(() => buildRecordClaimData(new Uint8Array(16), 0x10)).toThrow(/32 bytes/);
    expect(() => buildRecordClaimData(new Uint8Array(64), 0x10)).toThrow(/32 bytes/);
  });

  it("throws on statement kind outside 0x10-0x15", () => {
    const hash = new Uint8Array(32);
    expect(() => buildRecordClaimData(hash, 0x09)).toThrow(/out of valid range/);
    expect(() => buildRecordClaimData(hash, 0x16)).toThrow(/out of valid range/);
    expect(() => buildRecordClaimData(hash, 0x00)).toThrow(/out of valid range/);
  });

  it("all-zero hash stays all-zero in packed buffer", () => {
    const hash = new Uint8Array(32);
    const buf = buildRecordClaimData(hash, STATEMENT_KIND.API_METER_BURN);
    expect(Array.from(buf.slice(1, 33))).toEqual(new Array(32).fill(0));
  });

  it("all-0xff hash stays all-0xff in packed buffer", () => {
    const hash = new Uint8Array(32).fill(0xff);
    const buf = buildRecordClaimData(hash, STATEMENT_KIND.PREDICTION_COMMIT_REVEAL);
    expect(Array.from(buf.slice(1, 33))).toEqual(new Array(32).fill(0xff));
  });

  it("two different hashes produce different buffers", () => {
    const h1 = new Uint8Array(32).fill(0x11);
    const h2 = new Uint8Array(32).fill(0x22);
    expect(buildRecordClaimData(h1, 0x10)).not.toEqual(buildRecordClaimData(h2, 0x10));
  });
});

// ── hashReceiptPayload ────────────────────────────────────────────────────────

describe("hashReceiptPayload", () => {
  it("returns 32 bytes", () => {
    expect(hashReceiptPayload({ a: 1, b: 2 }).length).toBe(32);
  });

  it("is deterministic", () => {
    const p = { receiptId: "abc", totalAtomic: "5000" };
    expect(hashReceiptPayload(p)).toEqual(hashReceiptPayload(p));
  });

  it("key order does not affect output (canonical)", () => {
    const p1 = { z: 1, a: 2 };
    const p2 = { a: 2, z: 1 };
    expect(hashReceiptPayload(p1)).toEqual(hashReceiptPayload(p2));
  });

  it("different payloads produce different hashes", () => {
    const h1 = hashReceiptPayload({ id: "x" });
    const h2 = hashReceiptPayload({ id: "y" });
    expect(h1).not.toEqual(h2);
  });
});

// ── hashString ────────────────────────────────────────────────────────────────

describe("hashString", () => {
  it("returns 32 bytes", () => {
    expect(hashString("hello").length).toBe(32);
  });

  it("is deterministic", () => {
    expect(hashString("abc")).toEqual(hashString("abc"));
  });

  it("different strings produce different hashes", () => {
    expect(hashString("foo")).not.toEqual(hashString("bar"));
  });

  it("empty string produces valid 32-byte hash", () => {
    expect(hashString("").length).toBe(32);
  });
});

// ── hashBytes ─────────────────────────────────────────────────────────────────

describe("hashBytes", () => {
  it("returns 32 bytes for any input", () => {
    expect(hashBytes(new Uint8Array(0)).length).toBe(32);
    expect(hashBytes(new Uint8Array(100).fill(0xff)).length).toBe(32);
  });

  it("consistent with hashString for same content", () => {
    const input = Buffer.from("hello world", "utf8");
    const fromBytes = hashBytes(new Uint8Array(input));
    const fromString = hashString("hello world");
    expect(fromBytes).toEqual(fromString);
  });
});

// ── decodeClaimRecord ─────────────────────────────────────────────────────────

describe("decodeClaimRecord", () => {
  function makeRecord(opts: {
    bump?: number;
    claimHash?: Uint8Array;
    authority?: Uint8Array;
    kind?: number;
    slot?: bigint;
  }) {
    const buf = Buffer.alloc(CLAIM_RECORD_LEN, 0);
    buf[0] = opts.bump ?? 254;
    if (opts.claimHash) Buffer.from(opts.claimHash).copy(buf, 1);
    if (opts.authority) Buffer.from(opts.authority).copy(buf, 33);
    buf[65] = opts.kind ?? 0x10;
    buf.writeBigUInt64LE(opts.slot ?? 0n, 66);
    return buf;
  }

  it("decodes bump correctly", () => {
    const rec = decodeClaimRecord(makeRecord({ bump: 255 }));
    expect(rec?.bump).toBe(255);
  });

  it("decodes claimHash correctly", () => {
    const hash = new Uint8Array(32).fill(0xca);
    const rec = decodeClaimRecord(makeRecord({ claimHash: hash }));
    expect(rec?.claimHash).toEqual(hash);
  });

  it("decodes authority as PublicKey", () => {
    const kp = new Uint8Array(32).fill(0x01);
    const rec = decodeClaimRecord(makeRecord({ authority: kp }));
    expect(rec?.authority).toBeInstanceOf(PublicKey);
  });

  it("decodes statementKind", () => {
    const rec = decodeClaimRecord(makeRecord({ kind: 0x14 }));
    expect(rec?.statementKind).toBe(0x14);
  });

  it("decodes recordedAtSlot correctly", () => {
    const rec = decodeClaimRecord(makeRecord({ slot: 123_456_789n }));
    expect(rec?.recordedAtSlot).toBe(123_456_789n);
  });

  it("decodes max slot (u64::MAX)", () => {
    const rec = decodeClaimRecord(makeRecord({ slot: 18446744073709551615n }));
    expect(rec?.recordedAtSlot).toBe(18446744073709551615n);
  });

  it("returns null for buffer shorter than CLAIM_RECORD_LEN", () => {
    expect(decodeClaimRecord(Buffer.alloc(10))).toBeNull();
    expect(decodeClaimRecord(Buffer.alloc(0))).toBeNull();
    expect(decodeClaimRecord(Buffer.alloc(CLAIM_RECORD_LEN - 1))).toBeNull();
  });

  it("accepts exactly CLAIM_RECORD_LEN bytes", () => {
    expect(decodeClaimRecord(Buffer.alloc(CLAIM_RECORD_LEN))).not.toBeNull();
  });

  it("accepts buffers longer than CLAIM_RECORD_LEN (extra data ignored)", () => {
    expect(decodeClaimRecord(Buffer.alloc(CLAIM_RECORD_LEN + 10))).not.toBeNull();
  });
});

// ── getClaimPda ───────────────────────────────────────────────────────────────

describe("getClaimPda", () => {
  const programId = new PublicKey("11111111111111111111111111111111");
  const authority = new PublicKey("SysvarC1ock11111111111111111111111111111111");

  it("returns a valid PublicKey", () => {
    const hash = new Uint8Array(32).fill(0x01);
    const [pda] = getClaimPda(hash, authority, programId);
    expect(pda).toBeInstanceOf(PublicKey);
  });

  it("is deterministic for same inputs", () => {
    const hash = new Uint8Array(32).fill(0x02);
    const [pda1] = getClaimPda(hash, authority, programId);
    const [pda2] = getClaimPda(hash, authority, programId);
    expect(pda1.toString()).toBe(pda2.toString());
  });

  it("different hashes produce different PDAs", () => {
    const [pda1] = getClaimPda(new Uint8Array(32).fill(0xaa), authority, programId);
    const [pda2] = getClaimPda(new Uint8Array(32).fill(0xbb), authority, programId);
    expect(pda1.toString()).not.toBe(pda2.toString());
  });

  it("different authorities produce different PDAs", () => {
    const hash = new Uint8Array(32).fill(0x03);
    const auth2 = new PublicKey("SysvarRent111111111111111111111111111111111");
    const [pda1] = getClaimPda(hash, authority, programId);
    const [pda2] = getClaimPda(hash, auth2, programId);
    expect(pda1.toString()).not.toBe(pda2.toString());
  });

  it("throws on hash length != 32", () => {
    expect(() => getClaimPda(new Uint8Array(16), authority, programId)).toThrow(/32 bytes/);
  });

  it("bump is in range 0-255", () => {
    const hash = new Uint8Array(32).fill(0x07);
    const [, bump] = getClaimPda(hash, authority, programId);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });
});
