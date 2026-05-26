/**
 * Layer: ZK proof aggregation data contract
 *
 * TypeScript mirror of the `dark-proof-aggregator` Rust crate data format.
 * Tests the batch ID, proof counting, compute unit model, batch hash
 * determinism, and JSON serialisation rules — all without network access.
 *
 * No source imports needed: the batch data structure and hash function are
 * implemented inline below using node:crypto SHA-256.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inline implementation — mirrors dark-proof-aggregator Rust crate
// ---------------------------------------------------------------------------

const MAX_BATCH_SIZE = 32;

/** CU model constants matching the on-chain program */
const CU_BASE = 150_000;
const CU_PER_PROOF = 50_000;

interface ProofEntry {
  proofHash: string; // hex SHA-256 of the raw proof bytes
}

interface ProofBatch {
  batchId: string;           // 32-byte hex (64 chars)
  epoch: number;
  verified_count: number;
  proofs: ProofEntry[];
}

function newBatch(epoch: number): ProofBatch {
  const batchId = createHash("sha256")
    .update("batch-id-v1")
    .update(Buffer.from(epoch.toString()))
    .update(crypto.getRandomValues(new Uint8Array(16)))
    .digest("hex");
  return { batchId, epoch, verified_count: 0, proofs: [] };
}

function addProof(batch: ProofBatch, proofBytes: Buffer): ProofBatch {
  if (batch.proofs.length >= MAX_BATCH_SIZE) {
    throw new Error("batch full");
  }
  const proofHash = createHash("sha256").update(proofBytes).digest("hex");
  const proofs = [...batch.proofs, { proofHash }];
  return { ...batch, proofs, verified_count: batch.verified_count + 1 };
}

function computeBatchHash(proofHashes: string[]): string {
  const h = createHash("sha256").update("batch-hash-v1");
  for (const ph of proofHashes) {
    h.update(Buffer.from(ph, "hex"));
  }
  return h.digest("hex");
}

function computeUnits(proofCount: number): number {
  return CU_BASE + proofCount * CU_PER_PROOF;
}

function batchToJson(batch: ProofBatch): object {
  // Serialised form omits raw proof bytes; exposes only hashes and metadata
  return {
    batch_id: batch.batchId,
    epoch: batch.epoch,
    verified_count: batch.verified_count,
    proof_hashes: batch.proofs.map((p) => p.proofHash),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("zk proof-aggregation data contract", () => {
  it("batch_id is 32 bytes (hex string length 64)", () => {
    const batch = newBatch(1);
    expect(batch.batchId).toHaveLength(64);
    // must be valid hex
    expect(batch.batchId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("empty batch has verified_count = 0", () => {
    const batch = newBatch(1);
    expect(batch.verified_count).toBe(0);
    expect(batch.proofs).toHaveLength(0);
  });

  it("each added proof increments verified_count", () => {
    let batch = newBatch(1);
    for (let i = 1; i <= 5; i++) {
      batch = addProof(batch, Buffer.from(`proof-${i}`));
      expect(batch.verified_count).toBe(i);
    }
  });

  it("MAX_BATCH_SIZE is 32", () => {
    expect(MAX_BATCH_SIZE).toBe(32);
  });

  it("CU model: 1 proof = 200_000 CU (base 150K + 1×50K)", () => {
    expect(computeUnits(1)).toBe(200_000);
  });

  it("CU model: 10 proofs = 650_000 CU (base 150K + 10×50K)", () => {
    expect(computeUnits(10)).toBe(650_000);
  });

  it("batch_hash is deterministic: same proofs → same hash", () => {
    const proofBufs = [Buffer.from("proof-alpha"), Buffer.from("proof-beta")];
    const hashes = proofBufs.map((b) =>
      createHash("sha256").update(b).digest("hex")
    );

    const hash1 = computeBatchHash(hashes);
    const hash2 = computeBatchHash(hashes);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it("batch JSON contains batch_id and epoch fields but not raw proof bytes", () => {
    let batch = newBatch(42);
    batch = addProof(batch, Buffer.from("raw-proof-bytes-secret"));
    const json = JSON.stringify(batchToJson(batch));

    expect(json).toContain("batch_id");
    expect(json).toContain("epoch");
    // raw proof bytes must not appear verbatim
    expect(json).not.toContain("raw-proof-bytes-secret");
    // proof_hashes should appear but as hex digests, not raw strings
    const parsed = JSON.parse(json) as { proof_hashes: string[] };
    expect(parsed.proof_hashes[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});
