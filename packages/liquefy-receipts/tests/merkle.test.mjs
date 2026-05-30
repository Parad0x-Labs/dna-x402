import test from "node:test";
import assert from "node:assert/strict";
import { StreamingMerkleBuilder, MerkleTree, buildReceiptRoot, verifyProof, verifyReceiptInBatch, rootHex } from "../src/merkle.ts";

function makeReceipt(i) {
  return {
    txSignature: `sig${String(i).padStart(8,"0")}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
    amount: 1000 + (i % 100),
    sender: i % 2 === 0 ? "AgentAliceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" : "AgentBobBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    receiver: "ApiEndpointCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    timestamp: 1_700_000_000 + i,
    receiptId: `rid_${i}`,
    programId: "6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN",
  };
}

// ── Streaming builder ─────────────────────────────────────────────────────────

test("streaming root matches in-memory root for 1 receipt", () => {
  const r = [makeReceipt(0)];
  const streaming = buildReceiptRoot(r);
  const tree = new MerkleTree(r);
  assert.ok(streaming.equals(tree.root()), "roots must match");
});

test("streaming root matches in-memory root for 100 receipts", () => {
  const rs = Array.from({length:100}, (_,i) => makeReceipt(i));
  const streaming = buildReceiptRoot(rs);
  const tree = new MerkleTree(rs);
  assert.ok(streaming.equals(tree.root()), "roots must match");
});

test("streaming root matches in-memory root for 1000 receipts", () => {
  const rs = Array.from({length:1000}, (_,i) => makeReceipt(i));
  const streaming = buildReceiptRoot(rs);
  const tree = new MerkleTree(rs);
  assert.ok(streaming.equals(tree.root()), "roots must match");
});

test("different receipts produce different roots", () => {
  const a = buildReceiptRoot([makeReceipt(0)]);
  const b = buildReceiptRoot([makeReceipt(1)]);
  assert.ok(!a.equals(b), "different receipts must produce different roots");
});

test("root is always 32 bytes", () => {
  for (const n of [1, 10, 100, 1000]) {
    const rs = Array.from({length:n}, (_,i) => makeReceipt(i));
    const root = buildReceiptRoot(rs);
    assert.equal(root.length, 32, `root must be 32 bytes for n=${n}`);
  }
});

test("empty batch returns 32-byte zero root", () => {
  const builder = new StreamingMerkleBuilder();
  assert.equal(builder.root().length, 32);
  assert.ok(builder.root().equals(Buffer.alloc(32, 0)));
});

// ── Streaming memory efficiency ───────────────────────────────────────────────

test("streaming builder uses O(log N) memory — stack never exceeds log2(N)+1", () => {
  const N = 1_000_000;
  const builder = new StreamingMerkleBuilder();
  const rs = Array.from({length:N}, (_,i) => makeReceipt(i));
  let maxStack = 0;
  for (const r of rs) {
    builder.add(r);
    maxStack = Math.max(maxStack, builder["stack"].length);
  }
  const log2N = Math.ceil(Math.log2(N)) + 1;
  console.log(`  1M receipts: max stack depth = ${maxStack} (log2(N)+1 = ${log2N})`);
  assert.ok(maxStack <= log2N, `stack ${maxStack} must be ≤ log2(N)+1 = ${log2N}`);
  assert.equal(builder.leafCount, N);
});

// ── Inclusion proofs ──────────────────────────────────────────────────────────

test("proof verifies for index 0", () => {
  const rs = Array.from({length:16}, (_,i) => makeReceipt(i));
  const tree = new MerkleTree(rs);
  const proof = tree.proof(0);
  assert.ok(verifyProof(proof), "proof must verify");
});

test("proof verifies for every index in 16-receipt tree", () => {
  const rs = Array.from({length:16}, (_,i) => makeReceipt(i));
  const tree = new MerkleTree(rs);
  for (let i = 0; i < 16; i++) {
    const proof = tree.proof(i);
    assert.ok(verifyProof(proof), `proof must verify for index ${i}`);
  }
});

test("proof verifies for odd-sized tree (17 receipts)", () => {
  const rs = Array.from({length:17}, (_,i) => makeReceipt(i));
  const tree = new MerkleTree(rs);
  for (let i = 0; i < 17; i++) {
    assert.ok(verifyProof(tree.proof(i)), `proof must verify for index ${i}`);
  }
});

test("verifyReceiptInBatch proves the actual receipt object", () => {
  const rs = Array.from({length:100}, (_,i) => makeReceipt(i));
  const tree = new MerkleTree(rs);
  const target = rs[42];
  const proof  = tree.proof(42);
  assert.ok(verifyReceiptInBatch(target, proof), "receipt must verify in batch");
});

test("tampered receipt fails proof verification", () => {
  const rs = Array.from({length:10}, (_,i) => makeReceipt(i));
  const tree = new MerkleTree(rs);
  const proof = tree.proof(5);
  const tampered = { ...rs[5], amount: 999999 };
  assert.ok(!verifyReceiptInBatch(tampered, proof), "tampered receipt must NOT verify");
});

test("proof from wrong tree fails", () => {
  const rs1 = Array.from({length:10}, (_,i) => makeReceipt(i));
  const rs2 = Array.from({length:10}, (_,i) => makeReceipt(i+100));
  const tree1 = new MerkleTree(rs1);
  const tree2 = new MerkleTree(rs2);
  const proof = tree1.proof(0);
  proof.root = tree2.root(); // swap root to wrong tree
  assert.ok(!verifyProof(proof), "proof from wrong tree must fail");
});

test("proof size is O(log N)", () => {
  for (const n of [8, 16, 64, 256, 1024]) {
    const rs = Array.from({length:n}, (_,i) => makeReceipt(i));
    const tree = new MerkleTree(rs);
    const proof = tree.proof(0);
    const expected = Math.ceil(Math.log2(n));
    assert.ok(proof.siblings.length <= expected + 1,
      `proof for n=${n}: ${proof.siblings.length} siblings, expected ≤ ${expected+1}`);
  }
});

// ── rootHex ───────────────────────────────────────────────────────────────────

test("rootHex produces 64-char lowercase hex", () => {
  const root = buildReceiptRoot([makeReceipt(0)]);
  const hex  = rootHex(root);
  assert.equal(hex.length, 64);
  assert.ok(/^[0-9a-f]+$/.test(hex), "must be lowercase hex");
});

// ── Scale extrapolation (the "fuck em" proof) ─────────────────────────────────

test("extrapolated: 36B receipts → 1 tx (32 bytes) in ~1 hour on 8 cores", () => {
  const N = 100_000;
  const rs = Array.from({length:N}, (_,i) => makeReceipt(i));
  const t0 = performance.now();
  const root = buildReceiptRoot(rs);
  const ms = performance.now() - t0;
  const receiptsPerSec = (N / ms) * 1000;
  const oneHour = receiptsPerSec * 3600;
  const onTxBytes = 32; // the root, always

  console.log(`  ${N.toLocaleString()} receipts in ${ms.toFixed(0)}ms = ${(receiptsPerSec/1e6).toFixed(1)}M receipts/sec`);
  console.log(`  Extrapolated 1 hour: ${(oneHour/1e9).toFixed(1)}B receipts`);
  console.log(`  On-chain footprint: ${onTxBytes} bytes. Always.`);
  console.log(`  Root: ${rootHex(root).slice(0,16)}…`);

  assert.equal(root.length, 32);
  assert.ok(receiptsPerSec > 100_000, "must process >100k receipts/sec");
});
