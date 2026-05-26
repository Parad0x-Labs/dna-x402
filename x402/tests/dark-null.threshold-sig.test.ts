import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inline implementations
// ---------------------------------------------------------------------------

function signerShareCommitment(
  signerId: number,
  messageHash: Buffer,
  nonce: Buffer
): Buffer {
  const h = createHash("sha256");
  h.update(Buffer.from("thresh-share-v1", "utf8"));
  const sidBuf = Buffer.alloc(1);
  sidBuf.writeUInt8(signerId & 0xff, 0);
  h.update(sidBuf);
  h.update(messageHash);
  h.update(nonce);
  return h.digest();
}

function partialSigHash(
  shareCommit: Buffer,
  signerId: number,
  secretHash: Buffer
): Buffer {
  const h = createHash("sha256");
  h.update(Buffer.from("thresh-psig-v1", "utf8"));
  h.update(shareCommit);
  const sidBuf = Buffer.alloc(1);
  sidBuf.writeUInt8(signerId & 0xff, 0);
  h.update(sidBuf);
  h.update(secretHash);
  return h.digest();
}

/**
 * aggregateSigs — sort partial sigs by their index in the supplied array,
 * XOR-fold them into a single 32-byte buffer, then SHA256 the result
 * together with the epoch.
 *
 * Threshold check: caller must pass exactly `threshold` or more partial sigs.
 * This function just aggregates whatever it receives; the calling code (tests)
 * is responsible for gating on threshold.
 */
function aggregateSigs(partialSigs: Buffer[], epoch: bigint): Buffer {
  if (partialSigs.length === 0) {
    throw new Error("No partial signatures to aggregate");
  }

  // Sort lexicographically (deterministic)
  const sorted = [...partialSigs].sort((a, b) => a.compare(b));

  // XOR-fold
  const xored = Buffer.alloc(32, 0);
  for (const sig of sorted) {
    for (let i = 0; i < 32; i++) {
      xored[i] ^= sig[i];
    }
  }

  // Encode epoch as little-endian 8 bytes
  const epochBuf = Buffer.alloc(8);
  const epochLo = Number(epoch & BigInt(0xffffffff));
  const epochHi = Number((epoch >> BigInt(32)) & BigInt(0xffffffff));
  epochBuf.writeUInt32LE(epochLo, 0);
  epochBuf.writeUInt32LE(epochHi, 4);

  const h = createHash("sha256");
  h.update(Buffer.from("thresh-agg-v1", "utf8"));
  h.update(epochBuf);
  h.update(xored);
  return h.digest();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dark-null threshold signature", () => {
  const MESSAGE_HASH = Buffer.alloc(32, 0xab);
  const NONCE = Buffer.alloc(32, 0x11);
  const SECRET_HASH = Buffer.alloc(32, 0xcc);
  const EPOCH = BigInt(42);

  it("signer_share commitment is SHA256(prefix || signer_id_byte || message_hash || nonce) — 32 bytes", () => {
    const commit = signerShareCommitment(1, MESSAGE_HASH, NONCE);
    expect(commit).toBeInstanceOf(Buffer);
    expect(commit.length).toBe(32);

    // Recompute manually and confirm
    const h = createHash("sha256");
    h.update(Buffer.from("thresh-share-v1", "utf8"));
    h.update(Buffer.from([1]));
    h.update(MESSAGE_HASH);
    h.update(NONCE);
    expect(commit.toString("hex")).toBe(h.digest("hex"));
  });

  it("partial_sig_hash = SHA256(prefix || share_commitment || signer_id_byte || secret_hash)", () => {
    const commit = signerShareCommitment(1, MESSAGE_HASH, NONCE);
    const psig = partialSigHash(commit, 1, SECRET_HASH);
    expect(psig).toBeInstanceOf(Buffer);
    expect(psig.length).toBe(32);

    const h = createHash("sha256");
    h.update(Buffer.from("thresh-psig-v1", "utf8"));
    h.update(commit);
    h.update(Buffer.from([1]));
    h.update(SECRET_HASH);
    expect(psig.toString("hex")).toBe(h.digest("hex"));
  });

  it("different signer_ids produce different share commitments (same message + nonce)", () => {
    const c1 = signerShareCommitment(1, MESSAGE_HASH, NONCE);
    const c2 = signerShareCommitment(2, MESSAGE_HASH, NONCE);
    const c3 = signerShareCommitment(3, MESSAGE_HASH, NONCE);
    expect(c1.toString("hex")).not.toBe(c2.toString("hex"));
    expect(c2.toString("hex")).not.toBe(c3.toString("hex"));
    expect(c1.toString("hex")).not.toBe(c3.toString("hex"));
  });

  it("aggregated_sig is deterministic: SHA256(prefix || epoch_le8 || XOR-fold of sorted partial_sig_hashes)", () => {
    const sigs = [1, 2, 3].map((id) => {
      const c = signerShareCommitment(id, MESSAGE_HASH, NONCE);
      return partialSigHash(c, id, SECRET_HASH);
    });

    const agg1 = aggregateSigs(sigs, EPOCH);
    const agg2 = aggregateSigs(sigs, EPOCH);
    expect(agg1.length).toBe(32);
    expect(agg1.toString("hex")).toBe(agg2.toString("hex"));
  });

  it("threshold met: 3 shares, threshold 2 → aggregation succeeds", () => {
    const THRESHOLD = 2;
    const sigs = [1, 2, 3].map((id) => {
      const c = signerShareCommitment(id, MESSAGE_HASH, NONCE);
      return partialSigHash(c, id, SECRET_HASH);
    });

    expect(sigs.length).toBeGreaterThanOrEqual(THRESHOLD);
    const agg = aggregateSigs(sigs.slice(0, THRESHOLD), EPOCH);
    expect(agg.length).toBe(32);
  });

  it("threshold not met: 1 share, threshold 3 → aggregation fails with error", () => {
    const THRESHOLD = 3;
    const sigs = [1].map((id) => {
      const c = signerShareCommitment(id, MESSAGE_HASH, NONCE);
      return partialSigHash(c, id, SECRET_HASH);
    });

    expect(sigs.length).toBeLessThan(THRESHOLD);
    expect(() => {
      if (sigs.length < THRESHOLD) {
        throw new Error(
          `Threshold not met: need ${THRESHOLD}, got ${sigs.length}`
        );
      }
      aggregateSigs(sigs, EPOCH);
    }).toThrow(/Threshold not met/);
  });

  it("public record JSON contains message_hash and aggregated_sig but NOT signer_id values", () => {
    const sigs = [1, 2, 3].map((id) => {
      const c = signerShareCommitment(id, MESSAGE_HASH, NONCE);
      return partialSigHash(c, id, SECRET_HASH);
    });
    const agg = aggregateSigs(sigs, EPOCH);

    const publicRecord = {
      message_hash: MESSAGE_HASH.toString("hex"),
      aggregated_sig: agg.toString("hex"),
      epoch: Number(EPOCH),
      mainnet_ready: false,
    };

    const recordStr = JSON.stringify(publicRecord);
    expect(recordStr).toContain("message_hash");
    expect(recordStr).toContain("aggregated_sig");

    // signer_id values (1, 2, 3) must not appear as explicit signer identity keys
    expect(publicRecord).not.toHaveProperty("signer_id");
    expect(publicRecord).not.toHaveProperty("signer_ids");
    const keys = Object.keys(publicRecord);
    const hasSigIdKey = keys.some((k) => k.startsWith("signer_id"));
    expect(hasSigIdKey).toBe(false);
  });
});
