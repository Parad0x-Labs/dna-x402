import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDagReceipt,
  buildX402AccessReceipt,
  verifyDagChain,
  buildDagMerkleRoot,
  traceProvenance,
  hashAction,
} from "../src/index.ts";

// Values mirror the on-chain x402 e2e (build/zk/x402-access-v2-e2e.mjs): the agent
// identity is its commitment, plus the scope/epoch/nullifier the access proof bound.
const AGENT = "12604248273428109876543210987654321098765432109876543210987654321";
const SCOPE = "8444325186691880123456789012345678901234567890123456789012345678";
const EPOCH = 7;
const NULLIFIER = "1116613260830072987654321098765432109876543210987654321098765432";

function paymentReceipt() {
  return buildDagReceipt({
    agentPubkey: AGENT,
    actionHash: hashAction({ layer: "payment", amount: "5000", counterparty: "cp" }),
    sequenceNonce: 0,
    layer: "payment",
    timestamp: 1,
  });
}

test("cross-layer chain: payment -> x402-access -> job verifies (unordered batch)", () => {
  const payment = paymentReceipt();
  const access = buildX402AccessReceipt({
    agentPubkey: AGENT, scopeHash: SCOPE, epoch: EPOCH, nullifier: NULLIFIER,
    fundingReceiptId: payment.receiptId, sequenceNonce: 1, parentReceiptId: payment.receiptId, timestamp: 2,
  });
  const job = buildDagReceipt({
    agentPubkey: AGENT, actionHash: hashAction({ layer: "job", result: "ok" }),
    sequenceNonce: 2, parentReceiptId: access.receiptId, layer: "job",
    crossRefs: [access.receiptId], timestamp: 3,
  });

  const res = verifyDagChain([job, access, payment]); // deliberately unordered
  assert.equal(res.valid, true, res.violation);
  assert.equal(access.layer, "x402-access");
  assert.deepEqual(access.crossRefs, [payment.receiptId]); // x402 access ↔ funding payment
});

test("provenance: job traces back across layers to the payment", () => {
  const payment = paymentReceipt();
  const access = buildX402AccessReceipt({
    agentPubkey: AGENT, scopeHash: SCOPE, epoch: EPOCH, nullifier: NULLIFIER,
    fundingReceiptId: payment.receiptId, sequenceNonce: 1, parentReceiptId: payment.receiptId, timestamp: 2,
  });
  const job = buildDagReceipt({
    agentPubkey: AGENT, actionHash: hashAction("job"), sequenceNonce: 2,
    parentReceiptId: access.receiptId, layer: "job", crossRefs: [access.receiptId], timestamp: 3,
  });

  const { ancestors, reachedLayers } = traceProvenance(job.receiptId, [payment, access, job]);
  assert.ok(reachedLayers.has("payment"), "must reach the funding payment layer");
  assert.ok(reachedLayers.has("x402-access"), "must reach the access layer");
  assert.equal(ancestors.length, 2);
});

test("anti-equivocation spans layers: same agent+nonce in two layers is proof of cheating", () => {
  const payment = buildDagReceipt({ agentPubkey: AGENT, actionHash: hashAction("a"), sequenceNonce: 0, layer: "payment" });
  const accessDup = buildDagReceipt({ agentPubkey: AGENT, actionHash: hashAction("b"), sequenceNonce: 0, layer: "x402-access" });
  const res = verifyDagChain([payment, accessDup]);
  assert.equal(res.valid, false);
  assert.match(res.violation, /EQUIVOCATION/);
  assert.equal(res.equivocationEvidence?.length, 2);
});

test("x402-access receiptId binds scope, epoch, and nullifier", () => {
  const base = {
    agentPubkey: AGENT, scopeHash: SCOPE, epoch: EPOCH, nullifier: NULLIFIER,
    fundingReceiptId: "pay", sequenceNonce: 1, parentReceiptId: "pay",
  };
  const a = buildX402AccessReceipt(base);
  assert.notEqual(a.receiptId, buildX402AccessReceipt({ ...base, nullifier: "0" }).receiptId);
  assert.notEqual(a.receiptId, buildX402AccessReceipt({ ...base, scopeHash: "0" }).receiptId);
  assert.notEqual(a.receiptId, buildX402AccessReceipt({ ...base, epoch: 8 }).receiptId);
});

test("Merkle root is tamper-evident over crossRefs (forging the funding edge changes the root)", () => {
  const payment = paymentReceipt();
  const access = buildX402AccessReceipt({
    agentPubkey: AGENT, scopeHash: SCOPE, epoch: EPOCH, nullifier: NULLIFIER,
    fundingReceiptId: payment.receiptId, sequenceNonce: 1, parentReceiptId: payment.receiptId,
  });
  const root1 = buildDagMerkleRoot([payment, access]);
  const forged = { ...access, crossRefs: ["a_payment_that_never_happened"] };
  const root2 = buildDagMerkleRoot([payment, forged]);
  assert.notDeepEqual(root1, root2);
});

test("a cycle in the cross-layer graph is rejected", () => {
  const a = buildDagReceipt({ agentPubkey: AGENT, actionHash: hashAction("a"), sequenceNonce: 0, layer: "payment" });
  const b = buildDagReceipt({ agentPubkey: "agent2", actionHash: hashAction("b"), sequenceNonce: 0, layer: "job", crossRefs: [a.receiptId] });
  const aCyclic = { ...a, crossRefs: [b.receiptId] }; // a ↔ b cross-ref cycle
  const res = verifyDagChain([aCyclic, b]);
  assert.equal(res.valid, false);
  assert.match(res.violation, /Cycle/);
});

test("a self cross-reference is rejected at build time", () => {
  const r = buildDagReceipt({ agentPubkey: AGENT, actionHash: hashAction("x"), sequenceNonce: 0, layer: "payment" });
  // Rebuilding with identical (agent, nonce, action) yields the same receiptId → self-ref.
  assert.throws(
    () => buildDagReceipt({ agentPubkey: AGENT, actionHash: hashAction("x"), sequenceNonce: 0, layer: "payment", crossRefs: [r.receiptId] }),
    /cross-reference itself/
  );
});

test("backward compatible: a plain (layer-less) chain still verifies", () => {
  const g = buildDagReceipt({ agentPubkey: AGENT, actionHash: hashAction("g"), sequenceNonce: 0 });
  const n = buildDagReceipt({ agentPubkey: AGENT, actionHash: hashAction("n"), sequenceNonce: 1, parentReceiptId: g.receiptId });
  assert.equal(verifyDagChain([g, n]).valid, true);
  assert.equal(g.layer, undefined);
  assert.equal(g.crossRefs, undefined);
});
