import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildDagMerkleRoot } from "../src/index.ts";

const sha256 = (b) => createHash("sha256").update(b).digest();

// RFC-6962 §2.1 domain-separated reference hashers, recomputed independently
// here so the test pins buildDagMerkleRoot to the exact on-wire root format.
const refLeaf = (r) =>
  sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(JSON.stringify(r), "utf8")]));
const refNode = (l, r) => sha256(Buffer.concat([Buffer.from([0x01]), l, r]));

function makeReceipt(i) {
  return {
    receiptId: `rid_${i}`,
    sequenceNonce: i,
    agentPubkey: i % 2 === 0 ? "AgentAlice" : "AgentBob",
    actionHash: sha256(Buffer.from(`action-${i}`)).toString("hex"),
    timestamp: 1_700_000_000_000 + i,
  };
}

// ── Domain separation (second-preimage resistance) ────────────────────────────

test("a leaf hash can never equal an internal node hash for the same bytes", () => {
  // The classic forgery: present an internal node's (left || right) preimage as a
  // single leaf. RFC-6962's 0x00 / 0x01 prefixes put them in different domains.
  const left  = sha256(Buffer.from("left-child"));
  const right = sha256(Buffer.from("right-child"));
  const concat = Buffer.concat([left, right]);

  const asLeaf = sha256(Buffer.concat([Buffer.from([0x00]), concat])); // hashLeafBytes
  const asNode = refNode(left, right);                                  // hashInternal
  assert.ok(!asLeaf.equals(asNode),
    "a leaf hash must never collide with an internal node hash over identical bytes");
});

test("buildDagMerkleRoot uses RFC-6962 domain separation (0x00 leaves, 0x01 nodes)", () => {
  const rs = [makeReceipt(0), makeReceipt(1)];
  const root = buildDagMerkleRoot(rs);

  const expected = refNode(refLeaf(rs[0]), refLeaf(rs[1]));
  assert.ok(root.equals(expected), "root must be SHA-256(0x01 || leaf0 || leaf1) with 0x00-prefixed leaves");

  // The pre-fix, vulnerable form had no prefixes: leaves = sha256(json),
  // node = sha256(left || right). Prove the fix moved the root away from it.
  const vulnLeaf0 = sha256(Buffer.from(JSON.stringify(rs[0]), "utf8"));
  const vulnLeaf1 = sha256(Buffer.from(JSON.stringify(rs[1]), "utf8"));
  const vulnerable = sha256(Buffer.concat([vulnLeaf0, vulnLeaf1]));
  assert.ok(!root.equals(vulnerable),
    "root must NOT match the non-domain-separated (vulnerable) computation");
});

// ── Sanity: shape and determinism ─────────────────────────────────────────────

test("root is deterministic and always 32 bytes", () => {
  for (const n of [1, 2, 7, 100]) {
    const rs = Array.from({ length: n }, (_, i) => makeReceipt(i));
    const a = buildDagMerkleRoot(rs);
    const b = buildDagMerkleRoot(rs);
    assert.equal(a.length, 32, `root must be 32 bytes for n=${n}`);
    assert.ok(a.equals(b), `root must be deterministic for n=${n}`);
  }
});

test("empty batch returns the 32-byte zero root", () => {
  assert.ok(buildDagMerkleRoot([]).equals(Buffer.alloc(32, 0)));
});

test("a 1-receipt root is just its domain-separated leaf hash", () => {
  const r = makeReceipt(0);
  assert.ok(buildDagMerkleRoot([r]).equals(refLeaf(r)),
    "single-leaf root must equal hashLeaf(r), not a re-hash");
});

test("changing any receipt field changes the root", () => {
  const base = [makeReceipt(0), makeReceipt(1)];
  const root = buildDagMerkleRoot(base);
  const tampered = [{ ...base[0], actionHash: "tampered" }, base[1]];
  assert.ok(!buildDagMerkleRoot(tampered).equals(root), "tampered receipt must change the root");
});
