import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildDagReceipt, buildX402AccessReceipt, verifyDagChain,
  buildDagMerkleRoot, checkAccumulatedRoot, hashAction,
  anchorDagRoot, verifyAnchoredRoot, resolveReceiptAnchorProgramId,
  RECEIPT_ANCHOR_PROGRAM_ID, RECEIPT_ANCHOR_UNAVAILABLE,
} from "../src/index.ts";

const AGENT = "web0:agent:verify-test";
const sha = (b) => createHash("sha256").update(b).digest();

// Craft a receipt_anchor bucket account: [ver1][bump1][bucket_id8 LE][count4 LE][root32][updated8].
function bucketAccount({ count = 1, rootHex }) {
  const b = Buffer.alloc(54);
  b[0] = 1; b[1] = 255;
  b.writeBigUInt64LE(123n, 2);
  b.writeUInt32LE(count, 10);
  Buffer.from(rootHex, "hex").copy(b, 14);
  b.writeBigInt64LE(0n, 46);
  return b;
}
// The on-chain root a FRESH bucket holds after anchoring `anchorHex`.
const freshAccumulated = (anchorHex) =>
  sha(Buffer.concat([Buffer.alloc(32), Buffer.from(anchorHex, "hex")])).toString("hex");

function accountabilityBatch() {
  const payment = buildDagReceipt({
    agentPubkey: AGENT, layer: "payment", sequenceNonce: 0, timestamp: 1,
    actionHash: hashAction({ layer: "payment", amount: "5000" }),
  });
  const access = buildX402AccessReceipt({
    agentPubkey: AGENT, scopeHash: "scope-1", epoch: 7, nullifier: "null-1",
    fundingReceiptId: payment.receiptId, sequenceNonce: 1, parentReceiptId: payment.receiptId, timestamp: 2,
  });
  return [payment, access];
}

test("checkAccumulatedRoot: a fresh (count=1) bucket holding our root verifies", () => {
  const root = buildDagMerkleRoot(accountabilityBatch()).toString("hex");
  const acc = bucketAccount({ count: 1, rootHex: freshAccumulated(root) });
  const r = checkAccumulatedRoot(root, acc);
  assert.equal(r.anchored, true);
  assert.equal(r.matchesFreshAccumulator, true);
  assert.equal(r.count, 1);
});

test("checkAccumulatedRoot: a bucket holding a DIFFERENT root does not verify", () => {
  const root = buildDagMerkleRoot(accountabilityBatch()).toString("hex");
  const acc = bucketAccount({ count: 1, rootHex: freshAccumulated("ab".repeat(32)) }); // someone else's root
  const r = checkAccumulatedRoot(root, acc);
  assert.equal(r.anchored, false);
  assert.equal(r.matchesFreshAccumulator, false);
});

test("checkAccumulatedRoot: a multi-anchor (count>1) bucket can't verify a lone root (honest null)", () => {
  const root = buildDagMerkleRoot(accountabilityBatch()).toString("hex");
  const acc = bucketAccount({ count: 2, rootHex: freshAccumulated(root) });
  const r = checkAccumulatedRoot(root, acc);
  assert.equal(r.matchesFreshAccumulator, null);
  assert.equal(r.anchored, false);
  assert.match(r.note, /count=2/);
});

test("full accountability (offline): valid chain + anchored root = accountable", () => {
  const batch = accountabilityBatch();
  const chain = verifyDagChain(batch);
  const root = buildDagMerkleRoot(batch).toString("hex");
  const anchor = checkAccumulatedRoot(root, bucketAccount({ count: 1, rootHex: freshAccumulated(root) }));
  const accountable = chain.valid && anchor.anchored;
  assert.equal(accountable, true);
});

test("full accountability: an equivocating batch is NOT accountable even if a root is anchored", () => {
  const a = buildDagReceipt({ agentPubkey: AGENT, layer: "payment", sequenceNonce: 0, actionHash: hashAction("x") });
  const dup = buildDagReceipt({ agentPubkey: AGENT, layer: "job", sequenceNonce: 0, actionHash: hashAction("y") }); // same nonce
  const batch = [a, dup];
  const chain = verifyDagChain(batch);
  const root = buildDagMerkleRoot(batch).toString("hex");
  const anchor = checkAccumulatedRoot(root, bucketAccount({ count: 1, rootHex: freshAccumulated(root) }));
  assert.equal(chain.valid, false);       // equivocation caught
  assert.equal(anchor.anchored, true);    // the bytes are anchored, but...
  assert.equal(chain.valid && anchor.anchored, false); // ...not accountable
});

test("receipt anchoring refuses without an explicit receipt_anchor program (no network call)", async () => {
  const UNAVAILABLE = /unavailable until the redeploy under a fresh key/;
  assert.equal(RECEIPT_ANCHOR_PROGRAM_ID, null);
  assert.match(RECEIPT_ANCHOR_UNAVAILABLE, UNAVAILABLE);
  assert.throws(() => resolveReceiptAnchorProgramId(), UNAVAILABLE);
  const own = "Anchor1111111111111111111111111111111111111";
  assert.equal(resolveReceiptAnchorProgramId(own), own);

  let calls = 0;
  const connection = new Proxy({}, { get: () => () => { calls += 1; throw new Error("network touched"); } });
  const receipt = buildDagReceipt({ agentPubkey: AGENT, actionHash: hashAction("a"), sequenceNonce: 0 });
  await assert.rejects(anchorDagRoot([receipt], connection, {}), UNAVAILABLE);
  await assert.rejects(verifyAnchoredRoot("00".repeat(32), connection, { bucketId: 1n }), UNAVAILABLE);
  assert.equal(calls, 0);
});
