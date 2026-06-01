/**
 * Tests for @parad0x_labs/royalty-waterfalls
 * node --test tests/royalty-waterfalls.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

// Import directly from src (no build step needed — Node 22 runs TS natively
// when the file is imported as .ts via --experimental-strip-types, but since
// we import .ts from .mjs we use the loader below).
// We use a dynamic import with the actual module path.
import {
  buildWaterfall,
  verifyWaterfall,
  buildDerivativeAttribution,
  verifyDerivativeAttribution,
  computeFeeDistribution,
  buildAttributedReceipt,
  sha256Hex,
  waterfallCanonicalBytes,
  attributionCanonicalBytes,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Minimal Ed25519 keypair for tests using Web Crypto
// ---------------------------------------------------------------------------

/**
 * Generate a test keypair using Web Crypto. Returns a KeypairLike compatible
 * with the package's signing interface.
 */
async function generateTestKeypair() {
  const kp = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const rawPub = await crypto.subtle.exportKey("raw", kp.publicKey);
  const publicKey = new Uint8Array(rawPub);

  async function sign(message) {
    const sigBuf = await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, message);
    return new Uint8Array(sigBuf);
  }

  return { publicKey, sign };
}

// ---------------------------------------------------------------------------
// Helper: build a licence terms hash
// ---------------------------------------------------------------------------

function makeTermsHash(text = "MIT License — royalties survive composition.") {
  return sha256Hex(text);
}

// ---------------------------------------------------------------------------
// Test: waterfall with valid tiers builds and verifies
// ---------------------------------------------------------------------------

test("waterfall with valid tiers builds and signature verifies", async () => {
  const keypair = await generateTestKeypair();

  const tiers = [
    { recipientPubkey: "creator_pub_" + keypair.publicKey.slice(0, 4).join(""), sharesBps: 5000, role: "creator" },
    { recipientPubkey: "builder_pub_abcdef0123456789", sharesBps: 3000, role: "builder" },
    { recipientPubkey: "rail_pub_abcdef0123456789abc", sharesBps: 1000, role: "rail" },
    { recipientPubkey: "affiliate_pub_xyzxyzxyzxyz12", sharesBps: 1000, role: "affiliate" },
  ];

  const waterfall = await buildWaterfall(tiers, makeTermsHash(), keypair);

  // Structural checks
  assert.ok(waterfall.waterfallId, "waterfallId must be present");
  assert.equal(waterfall.tiers.length, 4);
  assert.equal(waterfall.totalBps, 10_000);
  assert.ok(waterfall.signature, "signature must be present");
  assert.ok(waterfall.creatorPubkey, "creatorPubkey must be present");
  assert.ok(waterfall.createdAt > 0, "createdAt must be a positive timestamp");

  // Signature verification
  const valid = await verifyWaterfall(waterfall);
  assert.equal(valid, true, "verifyWaterfall must return true for a freshly built waterfall");
});

test("waterfall with partial bps (<10000) builds and verifies", async () => {
  const keypair = await generateTestKeypair();

  const tiers = [
    { recipientPubkey: "creator_hexhexhex1234567890ab", sharesBps: 7500, role: "creator" },
    { recipientPubkey: "source_hexhexhex1234567890cd", sharesBps: 2000, role: "source" },
  ];

  const waterfall = await buildWaterfall(tiers, makeTermsHash("Custom terms"), keypair);
  assert.equal(waterfall.totalBps, 9500);

  const valid = await verifyWaterfall(waterfall);
  assert.equal(valid, true);
});

// ---------------------------------------------------------------------------
// Test: tiers over 10 000 bps throws
// ---------------------------------------------------------------------------

test("buildWaterfall throws when tiers exceed 10 000 bps", async () => {
  const keypair = await generateTestKeypair();

  const tiers = [
    { recipientPubkey: "pub_aaaaaaaaaaaaaaaaaaaaaaaa", sharesBps: 6000, role: "creator" },
    { recipientPubkey: "pub_bbbbbbbbbbbbbbbbbbbbbbbb", sharesBps: 5000, role: "builder" },
  ];

  await assert.rejects(
    () => buildWaterfall(tiers, makeTermsHash(), keypair),
    (err) => {
      assert.ok(err instanceof RangeError, "must throw RangeError");
      assert.match(err.message, /10.000/i, "message must mention 10 000");
      return true;
    },
  );
});

test("buildWaterfall throws when a tier has sharesBps = 0", async () => {
  const keypair = await generateTestKeypair();

  const tiers = [
    { recipientPubkey: "pub_aaaaaaaaaaaaaaaaaaaaaaaa", sharesBps: 5000, role: "creator" },
    { recipientPubkey: "pub_bbbbbbbbbbbbbbbbbbbbbbbb", sharesBps: 0, role: "builder" },
  ];

  await assert.rejects(
    () => buildWaterfall(tiers, makeTermsHash(), keypair),
    /sharesBps = 0/,
  );
});

test("buildWaterfall throws when a tier has an empty recipientPubkey", async () => {
  const keypair = await generateTestKeypair();

  const tiers = [
    { recipientPubkey: "", sharesBps: 5000, role: "creator" },
  ];

  await assert.rejects(
    () => buildWaterfall(tiers, makeTermsHash(), keypair),
    /empty recipientPubkey/,
  );
});

// ---------------------------------------------------------------------------
// Test: tampered waterfall fails verification
// ---------------------------------------------------------------------------

test("tampered waterfall fails verifyWaterfall", async () => {
  const keypair = await generateTestKeypair();

  const tiers = [
    { recipientPubkey: "pub_legit_aabbccddeeff001122", sharesBps: 10_000, role: "creator" },
  ];
  const waterfall = await buildWaterfall(tiers, makeTermsHash(), keypair);

  // Tamper: change the first tier's sharesBps after signing
  const tampered = {
    ...waterfall,
    tiers: [{ ...waterfall.tiers[0], sharesBps: 9_000 }],
  };
  const valid = await verifyWaterfall(tampered);
  assert.equal(valid, false, "tampered waterfall must fail verification");
});

// ---------------------------------------------------------------------------
// Test: fee distribution sums to total amount
// ---------------------------------------------------------------------------

test("computeFeeDistribution sums exactly to totalAmountAtomic (no loss)", async () => {
  const keypair = await generateTestKeypair();

  const tiers = [
    { recipientPubkey: "pub_creator_xxxx0000000000001", sharesBps: 5000, role: "creator" },
    { recipientPubkey: "pub_builder_xxxx0000000000002", sharesBps: 3000, role: "builder" },
    { recipientPubkey: "pub_rail____xxxx0000000000003", sharesBps: 1500, role: "rail" },
    { recipientPubkey: "pub_affiliate_xx0000000000004", sharesBps:  500, role: "affiliate" },
  ];

  const waterfall = await buildWaterfall(tiers, makeTermsHash(), keypair);
  const totalAmount = 1_000_000n;
  const dist = computeFeeDistribution(totalAmount, waterfall);

  assert.equal(dist.length, 4);
  const total = dist.reduce((s, e) => s + e.amountAtomic, 0n);
  assert.equal(total, totalAmount, "distribution must sum exactly to the input total");
});

test("computeFeeDistribution handles rounding remainder to first tier", async () => {
  const keypair = await generateTestKeypair();

  // 3 equal tiers of 3333 bps each = 9999 bps; 1 bps unaccounted by integer div
  // for amounts that don't divide evenly.
  const tiers = [
    { recipientPubkey: "pub_a_aaaaaaaaaaaaaaaaaaaaaa", sharesBps: 3334, role: "creator" },
    { recipientPubkey: "pub_b_bbbbbbbbbbbbbbbbbbbbbb", sharesBps: 3333, role: "builder" },
    { recipientPubkey: "pub_c_cccccccccccccccccccccc", sharesBps: 3333, role: "source" },
  ];

  const waterfall = await buildWaterfall(tiers, makeTermsHash(), keypair);
  assert.equal(waterfall.totalBps, 10_000);

  // Use a prime-ish total to stress rounding.
  const totalAmount = 999_999n;
  const dist = computeFeeDistribution(totalAmount, waterfall);
  const total = dist.reduce((s, e) => s + e.amountAtomic, 0n);
  assert.equal(total, totalAmount, "rounding remainder must not be lost");
});

test("computeFeeDistribution with partial bps distributes only the entitled share", async () => {
  const keypair = await generateTestKeypair();

  // 5000 bps = 50 %; the remaining 50 % is protocol-retained (not in tiers).
  const tiers = [
    { recipientPubkey: "pub_creator_partial_bps_001", sharesBps: 5000, role: "creator" },
  ];
  const waterfall = await buildWaterfall(tiers, makeTermsHash(), keypair);
  assert.equal(waterfall.totalBps, 5000);

  const totalAmount = 1_000n;
  const dist = computeFeeDistribution(totalAmount, waterfall);
  // Entitled = 5000/10000 * 1000 = 500. No integer rounding loss here.
  assert.equal(dist[0].amountAtomic, 500n);
  // Sum equals 500 — partial waterfall distributes only the entitled portion.
  const total = dist.reduce((s, e) => s + e.amountAtomic, 0n);
  assert.equal(total, 500n, "partial bps waterfall must distribute only the entitled share");
});

// ---------------------------------------------------------------------------
// Test: derivative attribution builds and verifies
// ---------------------------------------------------------------------------

test("buildDerivativeAttribution + verifyDerivativeAttribution round-trip", async () => {
  const sourceKeypair = await generateTestKeypair();
  const sourcePubkeyHex = Buffer.from(sourceKeypair.publicKey).toString("hex");

  const sourceReceiptHash = sha256Hex("some upstream receipt payload");
  const waterfallId = "wf_" + "a".repeat(60);

  const attribution = await buildDerivativeAttribution(
    sourcePubkeyHex,
    sourceReceiptHash,
    waterfallId,
    sourceKeypair,
  );

  assert.equal(attribution.sourceAgentId, sourcePubkeyHex);
  assert.equal(attribution.sourceReceiptHash, sourceReceiptHash);
  assert.equal(attribution.sourceWaterfallId, waterfallId);
  assert.ok(attribution.derivationNonce, "nonce must be present");
  assert.ok(attribution.attributionSignature, "signature must be present");
  assert.ok(attribution.derivedAt > 0);

  const valid = await verifyDerivativeAttribution(attribution, sourcePubkeyHex);
  assert.equal(valid, true, "verifyDerivativeAttribution must return true for a valid attribution");
});

// ---------------------------------------------------------------------------
// Test: wrong pubkey rejects attribution
// ---------------------------------------------------------------------------

test("wrong pubkey rejects verifyDerivativeAttribution", async () => {
  const sourceKeypair = await generateTestKeypair();
  const wrongKeypair  = await generateTestKeypair();
  const sourcePubkeyHex = Buffer.from(sourceKeypair.publicKey).toString("hex");
  const wrongPubkeyHex  = Buffer.from(wrongKeypair.publicKey).toString("hex");

  const attribution = await buildDerivativeAttribution(
    sourcePubkeyHex,
    sha256Hex("receipt payload"),
    "wf_" + "b".repeat(60),
    sourceKeypair,
  );

  const valid = await verifyDerivativeAttribution(attribution, wrongPubkeyHex);
  assert.equal(valid, false, "wrong pubkey must cause verification to return false");
});

test("tampered attribution nonce rejects verification", async () => {
  const kp = await generateTestKeypair();
  const pubHex = Buffer.from(kp.publicKey).toString("hex");

  const attribution = await buildDerivativeAttribution(
    pubHex,
    sha256Hex("payload"),
    "wf_cccc",
    kp,
  );

  const tampered = { ...attribution, derivationNonce: "00".repeat(32) };
  const valid = await verifyDerivativeAttribution(tampered, pubHex);
  assert.equal(valid, false, "tampered nonce must fail");
});

// ---------------------------------------------------------------------------
// Test: buildAttributedReceipt embeds correct fields
// ---------------------------------------------------------------------------

test("buildAttributedReceipt embeds attribution and waterfall metadata", async () => {
  const kp = await generateTestKeypair();
  const pubHex = Buffer.from(kp.publicKey).toString("hex");

  const tiers = [
    { recipientPubkey: pubHex, sharesBps: 8_000, role: "creator" },
    { recipientPubkey: "pub_rail_xxxx0000000000000000", sharesBps: 2_000, role: "rail" },
  ];
  const waterfall = await buildWaterfall(tiers, makeTermsHash(), kp);
  const attribution = await buildDerivativeAttribution(
    pubHex,
    sha256Hex("base receipt content"),
    waterfall.waterfallId,
    kp,
  );

  const baseReceipt = { txId: "0xdeadbeef", amount: 1_000n };
  const attributed = buildAttributedReceipt(baseReceipt, attribution, waterfall);

  // Original fields preserved
  assert.equal(attributed.txId, "0xdeadbeef");

  // Attribution fields present
  assert.equal(attributed.sourceAgentId, pubHex);
  assert.equal(attributed.sourceReceiptHash, attribution.sourceReceiptHash);
  assert.equal(attributed.waterfallId, waterfall.waterfallId);
  assert.equal(attributed.licenceTermsHash, waterfall.licenceTermsHash);

  // Fee distribution embedded
  assert.equal(attributed.feeDistribution.length, 2);
  assert.equal(attributed.feeDistribution[0].sharesBps, 8_000);
  assert.equal(attributed.feeDistribution[0].role, "creator");
  assert.equal(attributed.feeDistribution[1].sharesBps, 2_000);
  assert.equal(attributed.feeDistribution[1].role, "rail");
});

// ---------------------------------------------------------------------------
// Test: sha256Hex helper
// ---------------------------------------------------------------------------

test("sha256Hex produces consistent 64-char hex digest", () => {
  const h1 = sha256Hex("hello");
  const h2 = sha256Hex("hello");
  assert.equal(h1.length, 64);
  assert.equal(h1, h2);
  assert.notEqual(sha256Hex("hello"), sha256Hex("world"));
});

// ---------------------------------------------------------------------------
// Test: end-to-end composition chain A → B → receipt
// ---------------------------------------------------------------------------

test("full composition chain: agent A waterfall → agent B attribution → attributed receipt", async () => {
  const agentAKeypair = await generateTestKeypair();
  const agentAPubHex  = Buffer.from(agentAKeypair.publicKey).toString("hex");

  // Agent A publishes a waterfall.
  const tiersA = [
    { recipientPubkey: agentAPubHex, sharesBps: 6_000, role: "creator" },
    { recipientPubkey: "pub_protocol_railaaaaaaaaaaaaa", sharesBps: 1_000, role: "rail" },
    { recipientPubkey: "pub_affiliate_bbbbbbbbbbbbbbbb", sharesBps: 3_000, role: "affiliate" },
  ];
  const waterfallA = await buildWaterfall(tiersA, makeTermsHash("Agent A licence"), agentAKeypair);
  assert.equal(await verifyWaterfall(waterfallA), true);

  // Agent B consumes Agent A's output and creates an attribution.
  const agentBKeypair = await generateTestKeypair();
  const agentBPubHex  = Buffer.from(agentBKeypair.publicKey).toString("hex");

  // Agent A signs the derivation authorisation (source agent authorises).
  const upstreamReceiptHash = sha256Hex("Agent A's signal payload for this call");
  const attribution = await buildDerivativeAttribution(
    agentAPubHex,
    upstreamReceiptHash,
    waterfallA.waterfallId,
    agentAKeypair,   // source agent authorises
  );
  assert.equal(await verifyDerivativeAttribution(attribution, agentAPubHex), true);

  // Agent B builds its own receipt for this derivation.
  const baseReceipt = {
    txId:       "x402-" + agentBPubHex.slice(0, 16),
    agentPubkey: agentBPubHex,
    deliveredAt: Date.now(),
    amount:     500_000n,
  };
  const attributedReceipt = buildAttributedReceipt(baseReceipt, attribution, waterfallA);

  // Verify the distribution on the x402 payment amount.
  const dist = computeFeeDistribution(500_000n, waterfallA);
  const total = dist.reduce((s, e) => s + e.amountAtomic, 0n);
  assert.equal(total, 500_000n, "distribution must be lossless");
  assert.equal(dist[0].role, "creator");
  assert.equal(dist[0].recipient, agentAPubHex);

  // Attributed receipt has the right fields.
  assert.equal(attributedReceipt.sourceAgentId, agentAPubHex);
  assert.equal(attributedReceipt.waterfallId, waterfallA.waterfallId);
  assert.equal(attributedReceipt.txId, baseReceipt.txId);

  console.log(
    `  chain: A(${agentAPubHex.slice(0, 8)}…) → B(${agentBPubHex.slice(0, 8)}…) ` +
    `tiers=${tiersA.length} dist=[${dist.map((e) => `${e.role}:${e.amountAtomic}`).join(",")}]`,
  );
});
