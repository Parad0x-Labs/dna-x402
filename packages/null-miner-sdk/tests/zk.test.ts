/**
 * NULL Miner SDK — ZK Module Tests
 *
 * Tests for BN254 Poseidon, Semaphore identity, and SnarkPack receipt batching.
 * All pure computation — no network calls, no Solana connection.
 */

import { createHash } from "crypto";

// Poseidon
import {
  BN254_FIELD_P,
  fieldMod,
  bytesToField,
  fieldToBytes,
  hexToField,
  fieldToHex,
  poseidonHash2,
  poseidonHashHex,
  poseidonMerkleHash,
  sha256Field,
} from "../src/zk/poseidon.js";

// Semaphore
import {
  generateIdentity,
  deriveIdentityFromKey,
  reconstructIdentity,
  computeIdentityCommitment,
  computeNullifierHash,
  buildExternalNullifier,
  IncrementalMerkleTree,
  buildSignalWitness,
  ZERO_LEAF,
  SEMAPHORE_TREE_DEPTH,
} from "../src/zk/semaphore.js";

// Receipt
import {
  buildReceiptWitness,
  computeReceiptPublicInputs,
  buildSnarkPackBatch,
  merkleRootPoseidon,
} from "../src/zk/receipt.js";

// ── Poseidon ──────────────────────────────────────────────────────────────────

describe("BN254 field operations", () => {
  test("fieldMod reduces to [0, p)", () => {
    expect(fieldMod(BN254_FIELD_P)).toBe(0n);
    expect(fieldMod(BN254_FIELD_P + 1n)).toBe(1n);
    expect(fieldMod(-1n)).toBe(BN254_FIELD_P - 1n);
    expect(fieldMod(0n)).toBe(0n);
  });

  test("bytesToField / fieldToBytes roundtrip", () => {
    const n = 12345678901234567890n;
    const buf = fieldToBytes(n);
    expect(buf).toHaveLength(32);
    expect(bytesToField(buf)).toBe(fieldMod(n));
  });

  test("hexToField / fieldToHex roundtrip", () => {
    const hex = "a".repeat(64);
    const n   = hexToField(hex);
    expect(n).toBeGreaterThanOrEqual(0n);
    expect(n).toBeLessThan(BN254_FIELD_P);
    const back = fieldToHex(n);
    expect(back).toHaveLength(64);
    expect(back).toMatch(/^[0-9a-f]+$/);
  });

  test("fieldToBytes produces big-endian encoding", () => {
    const n   = 1n;
    const buf = fieldToBytes(n);
    // 1 in big-endian 32-byte: 31 leading zeros, then 0x01
    expect(buf[31]).toBe(1);
    for (let i = 0; i < 31; i++) expect(buf[i]).toBe(0);
  });

  test("fieldMod output is always < BN254_FIELD_P", () => {
    const values = [0n, 1n, BN254_FIELD_P - 1n, BN254_FIELD_P, 2n * BN254_FIELD_P];
    for (const v of values) {
      const r = fieldMod(v);
      expect(r).toBeGreaterThanOrEqual(0n);
      expect(r).toBeLessThan(BN254_FIELD_P);
    }
  });
});

describe("Poseidon hash", () => {
  test("poseidonHash2 is deterministic", () => {
    const h1 = poseidonHash2(1n, 2n);
    const h2 = poseidonHash2(1n, 2n);
    expect(h1).toBe(h2);
  });

  test("poseidonHash2 is in BN254 field", () => {
    const h = poseidonHash2(100n, 200n);
    expect(h).toBeGreaterThanOrEqual(0n);
    expect(h).toBeLessThan(BN254_FIELD_P);
  });

  test("poseidonHash2 is not commutative (order matters)", () => {
    const h1 = poseidonHash2(1n, 2n);
    const h2 = poseidonHash2(2n, 1n);
    expect(h1).not.toBe(h2);
  });

  test("poseidonHash2 input (0, 0) does not throw", () => {
    expect(() => poseidonHash2(0n, 0n)).not.toThrow();
  });

  test("poseidonHashHex returns 64-char hex", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const h = poseidonHashHex(a, b);
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  test("poseidonHashHex deterministic", () => {
    const a = "1".repeat(64);
    const b = "2".repeat(64);
    expect(poseidonHashHex(a, b)).toBe(poseidonHashHex(a, b));
  });

  test("poseidonMerkleHash produces 32-byte buffer", () => {
    const l = Buffer.alloc(32, 1);
    const r = Buffer.alloc(32, 2);
    const h = poseidonMerkleHash(l, r);
    expect(h).toHaveLength(32);
    expect(Buffer.isBuffer(h)).toBe(true);
  });

  test("sha256Field returns bigint in BN254 field", () => {
    const n = sha256Field("test", Buffer.from("data"));
    expect(typeof n).toBe("bigint");
    expect(n).toBeGreaterThanOrEqual(0n);
    expect(n).toBeLessThan(BN254_FIELD_P);
  });
});

// ── Semaphore Identity ────────────────────────────────────────────────────────

describe("SemaphoreIdentity", () => {
  test("generateIdentity produces all required fields", () => {
    const id = generateIdentity();
    expect(id.nullifier).toHaveLength(32);
    expect(id.trapdoor).toHaveLength(32);
    expect(id.identityCommitment).toHaveLength(32);
  });

  test("identityCommitment differs between random identities", () => {
    const id1 = generateIdentity();
    const id2 = generateIdentity();
    expect(id1.identityCommitment.equals(id2.identityCommitment)).toBe(false);
  });

  test("computeIdentityCommitment is deterministic", () => {
    const n = Buffer.alloc(32, 0xab);
    const t = Buffer.alloc(32, 0xcd);
    const c1 = computeIdentityCommitment(n, t);
    const c2 = computeIdentityCommitment(n, t);
    expect(c1.equals(c2)).toBe(true);
  });

  test("identityCommitment changes when nullifier changes", () => {
    const t  = Buffer.alloc(32, 1);
    const n1 = Buffer.alloc(32, 1);
    const n2 = Buffer.alloc(32, 2);
    expect(
      computeIdentityCommitment(n1, t).equals(computeIdentityCommitment(n2, t))
    ).toBe(false);
  });

  test("deriveIdentityFromKey is deterministic", () => {
    const key = Buffer.from("a".repeat(64), "hex");
    const id1 = deriveIdentityFromKey(key);
    const id2 = deriveIdentityFromKey(key);
    expect(id1.identityCommitment.equals(id2.identityCommitment)).toBe(true);
    expect(id1.nullifier.equals(id2.nullifier)).toBe(true);
    expect(id1.trapdoor.equals(id2.trapdoor)).toBe(true);
  });

  test("deriveIdentityFromKey differs per key", () => {
    const k1 = Buffer.from("a".repeat(64), "hex");
    const k2 = Buffer.from("b".repeat(64), "hex");
    const id1 = deriveIdentityFromKey(k1);
    const id2 = deriveIdentityFromKey(k2);
    expect(id1.identityCommitment.equals(id2.identityCommitment)).toBe(false);
  });

  test("reconstructIdentity matches original", () => {
    const id  = generateIdentity();
    const id2 = reconstructIdentity(id.nullifier, id.trapdoor);
    expect(id2.identityCommitment.equals(id.identityCommitment)).toBe(true);
  });
});

describe("NullifierHash", () => {
  test("computeNullifierHash is deterministic", () => {
    const nullifier = Buffer.alloc(32, 0xaa);
    const ext       = Buffer.alloc(32, 0xbb);
    const h1 = computeNullifierHash(nullifier, ext);
    const h2 = computeNullifierHash(nullifier, ext);
    expect(h1.equals(h2)).toBe(true);
  });

  test("nullifierHash differs per external nullifier (context separation)", () => {
    const nullifier = Buffer.alloc(32, 0xaa);
    const ext1      = Buffer.alloc(32, 1);
    const ext2      = Buffer.alloc(32, 2);
    const h1 = computeNullifierHash(nullifier, ext1);
    const h2 = computeNullifierHash(nullifier, ext2);
    expect(h1.equals(h2)).toBe(false);
  });

  test("nullifierHash differs per identity (unlinkable across contexts)", () => {
    const n1  = Buffer.alloc(32, 1);
    const n2  = Buffer.alloc(32, 2);
    const ext = Buffer.alloc(32, 0xcc);
    const h1 = computeNullifierHash(n1, ext);
    const h2 = computeNullifierHash(n2, ext);
    expect(h1.equals(h2)).toBe(false);
  });

  test("buildExternalNullifier is deterministic", () => {
    const e1 = buildExternalNullifier("null-miner-task-v1", "task-group-1");
    const e2 = buildExternalNullifier("null-miner-task-v1", "task-group-1");
    expect(e1.equals(e2)).toBe(true);
    expect(e1).toHaveLength(32);
  });

  test("buildExternalNullifier differs per domain and contextId", () => {
    const e1 = buildExternalNullifier("domain-a", "ctx-1");
    const e2 = buildExternalNullifier("domain-b", "ctx-1");
    const e3 = buildExternalNullifier("domain-a", "ctx-2");
    expect(e1.equals(e2)).toBe(false);
    expect(e1.equals(e3)).toBe(false);
  });
});

// ── Incremental Merkle Tree ───────────────────────────────────────────────────

describe("IncrementalMerkleTree", () => {
  test("empty tree has correct root (all zeros leaf level)", () => {
    const tree = new IncrementalMerkleTree(4);
    expect(tree.root).toHaveLength(32);
    expect(tree.size).toBe(0);
  });

  test("insert returns correct index", () => {
    const tree = new IncrementalMerkleTree(4);
    const leaf = Buffer.alloc(32, 1);
    const idx  = tree.insert(leaf);
    expect(idx).toBe(0);
    expect(tree.size).toBe(1);
    const idx2 = tree.insert(Buffer.alloc(32, 2));
    expect(idx2).toBe(1);
  });

  test("root changes after insert", () => {
    const tree = new IncrementalMerkleTree(4);
    const root0 = Buffer.from(tree.root);
    tree.insert(Buffer.alloc(32, 1));
    expect(root0.equals(tree.root)).toBe(false);
  });

  test("proof verification passes for inserted leaf", () => {
    const tree = new IncrementalMerkleTree(4);
    const leaf = Buffer.alloc(32, 0xab);
    const idx  = tree.insert(leaf);
    const proof = tree.generateProof(idx);

    expect(IncrementalMerkleTree.verifyProof(
      proof.leaf, proof.siblings, proof.pathIndices, proof.root
    )).toBe(true);
  });

  test("proof verification fails for wrong leaf", () => {
    const tree   = new IncrementalMerkleTree(4);
    const idx    = tree.insert(Buffer.alloc(32, 1));
    const proof  = tree.generateProof(idx);
    const wrong  = Buffer.alloc(32, 2);

    expect(IncrementalMerkleTree.verifyProof(
      wrong, proof.siblings, proof.pathIndices, proof.root
    )).toBe(false);
  });

  test("multiple inserts all verify", () => {
    const tree  = new IncrementalMerkleTree(8);
    const leaves = Array.from({ length: 5 }, (_, i) => Buffer.alloc(32, i + 1));

    for (const leaf of leaves) tree.insert(leaf);

    for (let i = 0; i < leaves.length; i++) {
      const proof = tree.generateProof(i);
      expect(IncrementalMerkleTree.verifyProof(
        proof.leaf, proof.siblings, proof.pathIndices, proof.root
      )).toBe(true);
    }
  });

  test("proof has correct depth (siblings.length == tree depth)", () => {
    const depth = 6;
    const tree  = new IncrementalMerkleTree(depth);
    tree.insert(Buffer.alloc(32, 1));
    const proof = tree.generateProof(0);
    expect(proof.siblings).toHaveLength(depth);
    expect(proof.pathIndices).toHaveLength(depth);
  });

  test("throws on insert into full tree", () => {
    const tree = new IncrementalMerkleTree(2);  // capacity 4
    for (let i = 0; i < 4; i++) tree.insert(Buffer.alloc(32, i));
    expect(() => tree.insert(Buffer.alloc(32, 99))).toThrow(/full/);
  });

  test("throws on proof for un-inserted index", () => {
    const tree = new IncrementalMerkleTree(4);
    expect(() => tree.generateProof(0)).toThrow();
  });
});

describe("SemaphoreSignalWitness", () => {
  test("buildSignalWitness produces valid witness", () => {
    const tree     = new IncrementalMerkleTree(4);
    const identity = generateIdentity();
    const idx      = tree.insert(identity.identityCommitment);
    const ext      = buildExternalNullifier("null-miner-test-v1", "ctx-1");

    const witness = buildSignalWitness({
      identity,
      tree,
      leafIndex: idx,
      externalNullifier: ext,
      signal: Buffer.from("deadbeef", "hex"),
    });

    expect(witness.nullifierHash).toHaveLength(32);
    expect(witness.signalHash).toHaveLength(32);
    expect(witness.merkleProof.root).toHaveLength(32);

    // Proof verifies
    const { leaf, siblings, pathIndices, root } = witness.merkleProof;
    expect(IncrementalMerkleTree.verifyProof(leaf, siblings, pathIndices, root)).toBe(true);

    // nullifierHash = Poseidon2(nullifier, externalNullifier)
    const expectedNH = computeNullifierHash(identity.nullifier, ext);
    expect(witness.nullifierHash.equals(expectedNH)).toBe(true);
  });
});

// ── Receipt ───────────────────────────────────────────────────────────────────

describe("ReceiptWitness", () => {
  const BASE_OPTS = {
    payerAddress:  "PayerWallet11111111111111111111111111111111",
    amountAtomic:  5000,
    resource:      "/api/task/complete",
    platformId:    "test-platform",
    nullifierSeed: "a".repeat(64),
    taskId:        "b".repeat(64),
  };

  test("buildReceiptWitness returns field elements", () => {
    const w = buildReceiptWitness(BASE_OPTS);
    expect(typeof w.payerAddressField).toBe("bigint");
    expect(typeof w.resourceHash).toBe("bigint");
    expect(typeof w.platformIdHash).toBe("bigint");
    expect(typeof w.nullifierSeed).toBe("bigint");
    expect(typeof w.taskIdField).toBe("bigint");
    expect(w.amountAtomic).toBe(5000);
  });

  test("buildReceiptWitness is deterministic", () => {
    const w1 = buildReceiptWitness(BASE_OPTS);
    const w2 = buildReceiptWitness(BASE_OPTS);
    expect(w1.payerAddressField).toBe(w2.payerAddressField);
    expect(w1.nullifierSeed).toBe(w2.nullifierSeed);
  });

  test("computeReceiptPublicInputs returns expected shape", () => {
    const w = buildReceiptWitness(BASE_OPTS);
    const p = computeReceiptPublicInputs(w);
    expect(p.receiptCommitment).toHaveLength(64);
    expect(p.nullifierHash).toHaveLength(64);
    expect(p.amountBound).toBe(5000);
    expect(p.contextId).toHaveLength(64);
  });

  test("receipt commitment changes if amount changes", () => {
    const w1 = buildReceiptWitness({ ...BASE_OPTS, amountAtomic: 5000 });
    const w2 = buildReceiptWitness({ ...BASE_OPTS, amountAtomic: 9999 });
    const p1 = computeReceiptPublicInputs(w1);
    const p2 = computeReceiptPublicInputs(w2);
    expect(p1.receiptCommitment).not.toBe(p2.receiptCommitment);
  });

  test("nullifier hash changes if task changes", () => {
    const w1 = buildReceiptWitness({ ...BASE_OPTS, taskId: "b".repeat(64) });
    const w2 = buildReceiptWitness({ ...BASE_OPTS, taskId: "c".repeat(64) });
    const p1 = computeReceiptPublicInputs(w1);
    const p2 = computeReceiptPublicInputs(w2);
    expect(p1.nullifierHash).not.toBe(p2.nullifierHash);
  });
});

describe("SnarkPack batch", () => {
  function makeReceipt(seed: string) {
    return computeReceiptPublicInputs(buildReceiptWitness({
      payerAddress:  (seed + "1".repeat(44)).slice(0, 44),  // vary payer per seed
      amountAtomic:  1000,
      resource:      `/api/${seed}`,
      platformId:    "p",
      nullifierSeed: seed.repeat(64).slice(0, 64),
      taskId:        seed.repeat(64).slice(0, 64),
    }));
  }

  test("buildSnarkPackBatch returns correct count", () => {
    const receipts = [makeReceipt("a"), makeReceipt("b"), makeReceipt("c")];
    const batch = buildSnarkPackBatch(receipts);
    expect(batch.count).toBe(3);
    expect(batch.receipts).toHaveLength(3);
  });

  test("batchRoot is 64-char hex", () => {
    const batch = buildSnarkPackBatch([makeReceipt("a"), makeReceipt("b")]);
    expect(batch.batchRoot).toHaveLength(64);
    expect(batch.batchRoot).toMatch(/^[0-9a-f]+$/);
  });

  test("batchNullifier is 64-char hex", () => {
    const batch = buildSnarkPackBatch([makeReceipt("a")]);
    expect(batch.batchNullifier).toHaveLength(64);
  });

  test("different batches produce different roots", () => {
    const b1 = buildSnarkPackBatch([makeReceipt("a"), makeReceipt("b")]);
    const b2 = buildSnarkPackBatch([makeReceipt("c"), makeReceipt("d")]);
    expect(b1.batchRoot).not.toBe(b2.batchRoot);
  });

  test("merkleRootPoseidon works for power-of-2 and non-power-of-2 inputs", () => {
    const single = merkleRootPoseidon([Buffer.alloc(32, 1)]);
    expect(single).toHaveLength(32);

    const three  = merkleRootPoseidon([Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3)]);
    expect(three).toHaveLength(32);

    const four   = merkleRootPoseidon(Array.from({ length: 4 }, (_, i) => Buffer.alloc(32, i + 1)));
    expect(four).toHaveLength(32);
  });

  test("empty batch throws", () => {
    expect(() => buildSnarkPackBatch([])).toThrow();
  });
});
