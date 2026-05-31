/**
 * Tests for @dna-x402/liquefy-receipts
 * node --test tests/liquefy-receipts.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "fflate";

// ── import from src directly (no build needed for tests) ──────────────────────
import { compressReceipts, decompressReceipts } from "../src/compress.ts";
import { netReceipts }                          from "../src/net.ts";
import { generateKey, importKey, encryptBlob, decryptBlob, serializeBlob, deserializeBlob } from "../src/encrypt.ts";
import { buildAnchorIxData, batchHash }         from "../src/anchor.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeReceipts(n, overrides = {}) {
  return Array.from({ length: n }, (_, i) => ({
    txSignature:  `sig${i.toString().padStart(6,"0")}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
    amount:       1000 + (i % 10),        // clustered amounts
    sender:       i % 3 === 0 ? "AgentAlicePubkeyAAAAAAAAAAAAAAAAAAAAAAAAAAAA" : "AgentBobPubkeyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    receiver:     "ApiEndpointPubkeyCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    timestamp:    1_700_000_000 + i,      // sequential
    receiptId:    `rid_${i}`,
    programId:    "6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN",
    ...overrides,
  }));
}

// ── compression tests ─────────────────────────────────────────────────────────

test("round-trip: 100 receipts compress and restore exactly", () => {
  const receipts = makeReceipts(100);
  const compressed = compressReceipts(receipts);
  const restored   = decompressReceipts(compressed);

  assert.equal(restored.length, 100);
  assert.equal(restored[0].sender,    receipts[0].sender);
  assert.equal(restored[42].receiver, receipts[42].receiver);
  assert.equal(Number(restored[7].amount), receipts[7].amount);
});

test("round-trip: 1000 receipts", () => {
  const receipts   = makeReceipts(1000);
  const compressed = compressReceipts(receipts);
  const restored   = decompressReceipts(compressed);
  assert.equal(restored.length, 1000);
  assert.equal(restored[999].receiptId, "rid_999");
});

test("compression ratio >10x on 1000 repetitive receipts", () => {
  const receipts   = makeReceipts(1000);
  const compressed = compressReceipts(receipts);
  const rawSize    = new TextEncoder().encode(JSON.stringify(receipts)).length;
  const ratio      = rawSize / compressed.length;
  console.log(`  compression ratio: ${ratio.toFixed(1)}× (raw ${rawSize}B → compressed ${compressed.length}B)`);
  assert.ok(ratio > 10, `expected >10× got ${ratio.toFixed(1)}×`);
});

test("empty receipts returns empty buffer", () => {
  const compressed = compressReceipts([]);
  assert.equal(compressed.length, 0);
});

test("single receipt round-trips", () => {
  const receipts = makeReceipts(1);
  const restored = decompressReceipts(compressReceipts(receipts));
  assert.equal(restored[0].txSignature, receipts[0].txSignature);
});

// ── netting tests ─────────────────────────────────────────────────────────────

test("netting: bilateral flows cancel correctly", () => {
  const receipts = [
    { sender: "Alice", receiver: "Bob", amount: 500n, timestamp: 1, txSignature: "s1", receiptId: "r1" },
    { sender: "Alice", receiver: "Bob", amount: 300n, timestamp: 2, txSignature: "s2", receiptId: "r2" },
    { sender: "Bob",   receiver: "Alice", amount: 200n, timestamp: 3, txSignature: "s3", receiptId: "r3" },
  ];
  const nets = netReceipts(receipts);
  assert.equal(nets.length, 1);
  assert.equal(nets[0].sender,    "Alice");
  assert.equal(nets[0].receiver,  "Bob");
  assert.equal(nets[0].netAmount, 600n);   // 800 - 200
  assert.equal(nets[0].receiptCount, 3);
});

test("netting: fully cancelled pair drops to zero", () => {
  const receipts = [
    { sender: "A", receiver: "B", amount: 100n, timestamp: 1, txSignature: "s1" },
    { sender: "B", receiver: "A", amount: 100n, timestamp: 2, txSignature: "s2" },
  ];
  const nets = netReceipts(receipts);
  assert.equal(nets.length, 0);
});

test("netting: unidirectional flow preserved", () => {
  const receipts = [
    { sender: "A", receiver: "B", amount: 50n, timestamp: 1, txSignature: "s1" },
    { sender: "A", receiver: "B", amount: 75n, timestamp: 2, txSignature: "s2" },
  ];
  const nets = netReceipts(receipts);
  assert.equal(nets.length, 1);
  assert.equal(nets[0].netAmount, 125n);
});

test("netting: 100 receipts between 3 agents reduces to ≤3 settlements", () => {
  const agents = ["AgentA", "AgentB", "AgentC"];
  const receipts = Array.from({ length: 100 }, (_, i) => ({
    sender: agents[i % 3], receiver: agents[(i + 1) % 3],
    amount: BigInt(100 + i), timestamp: i, txSignature: `s${i}`,
  }));
  const nets = netReceipts(receipts);
  assert.ok(nets.length <= 3, `expected ≤3 settlements, got ${nets.length}`);
  console.log(`  100 receipts → ${nets.length} net settlements`);
});

// ── encryption tests ──────────────────────────────────────────────────────────

test("encrypt+decrypt round-trip", async () => {
  const rawKey     = await generateKey();
  const key        = await importKey(rawKey);
  const plaintext  = new TextEncoder().encode("hello x402 private receipt");
  const blob       = await encryptBlob(plaintext, key);
  const recovered  = await decryptBlob(blob, key);
  assert.deepEqual(recovered, plaintext);
});

test("serialize+deserialize blob preserves nonce+ciphertext", async () => {
  const rawKey    = await generateKey();
  const key       = await importKey(rawKey);
  const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
  const blob      = await encryptBlob(plaintext, key);
  const ser       = serializeBlob(blob);
  const deser     = deserializeBlob(ser);
  const recovered = await decryptBlob(deser, key);
  assert.deepEqual(recovered, plaintext);
});

test("wrong key fails to decrypt", async () => {
  const key1 = await importKey(await generateKey());
  const key2 = await importKey(await generateKey());
  const blob  = await encryptBlob(new Uint8Array([99]), key1);
  await assert.rejects(() => decryptBlob(blob, key2));
});

// ── anchor tests ──────────────────────────────────────────────────────────────

test("buildAnchorIxData: version=0x01, flags=0x00, 34 bytes total", () => {
  const commitment = new Uint8Array(32).fill(0xAB);
  const data = buildAnchorIxData(commitment);
  assert.equal(data.length, 34);
  assert.equal(data[0], 0x01);   // INSTRUCTION_VERSION_V1
  assert.equal(data[1], 0x00);   // flags: no bucket
  assert.deepEqual(data.slice(2), commitment);
});

test("batchHash is deterministic", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  assert.equal(batchHash(bytes), batchHash(bytes));
  assert.notEqual(batchHash(bytes), batchHash(new Uint8Array([1, 2, 4])));
});

// ── end-to-end pipeline test ──────────────────────────────────────────────────

test("full pipeline: 500 receipts → net → compress → encrypt → anchor payload", async () => {
  const receipts   = makeReceipts(500);
  const nets       = netReceipts(receipts);
  const compressed = compressReceipts(receipts);

  const rawKey = await generateKey();
  const key    = await importKey(rawKey);
  const blob   = await encryptBlob(compressed, key);
  const ser    = serializeBlob(blob);

  // Anchor: SHA-256 hash of the encrypted blob → 32-byte commitment → 34-byte ix
  const { createHash } = await import("node:crypto");
  const commitment = new Uint8Array(createHash("sha256").update(ser).digest());
  const ixData = buildAnchorIxData(commitment);

  const rawSize = new TextEncoder().encode(JSON.stringify(receipts)).length;
  const ratio   = rawSize / compressed.length;
  console.log(`  500 receipts: raw=${rawSize}B compressed=${compressed.length}B ratio=${ratio.toFixed(1)}× nets=${nets.length} ixDataLen=${ixData.length}B`);

  assert.ok(ratio > 10);
  assert.ok(nets.length < receipts.length);
  assert.equal(ixData.length, 34);
  assert.equal(ixData[0], 0x01); // INSTRUCTION_VERSION_V1

  // verify round-trip survives the full pipeline
  const deser     = deserializeBlob(ser);
  const decrypted = await decryptBlob(deser, key);
  const restored  = decompressReceipts(decrypted);
  assert.equal(restored.length, 500);
  assert.equal(restored[0].receiver, receipts[0].receiver);
});
