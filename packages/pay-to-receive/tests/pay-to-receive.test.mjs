/**
 * Tests for @parad0x_labs/pay-to-receive
 * Run: node --test tests/pay-to-receive.test.mjs
 *
 * Uses node:test (no external test runner needed).
 * Requires Node >= 22 for WebCrypto Ed25519 support.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";

import {
  DeliveryClass,
  buildReceiveQuote,
  verifyReceiveQuote,
  buildDeliveryReceipt,
  verifyDeliveryReceipt,
  buildPayToReceivePayload,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a real Ed25519 keypair via WebCrypto. */
async function generateKeypair() {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const rawPub = await globalThis.crypto.subtle.exportKey("raw", pair.publicKey);
  const pubkeyBytes = new Uint8Array(rawPub);

  // Export private key as PKCS#8 and extract the 32-byte seed.
  // PKCS#8 Ed25519 on Node 22: 16-byte header prefix + 32-byte seed = 48 bytes total.
  const rawPriv = await globalThis.crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const privBytes = new Uint8Array(rawPriv);
  // Seed starts at byte 16 (after the 16-byte DER header).
  const seed = privBytes.slice(16);

  return { publicKey: pubkeyBytes, seed };
}

function sha256hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Test 1: quote builds and verifies
// ---------------------------------------------------------------------------

test("quote builds and verifies correctly", async () => {
  const keypair = await generateKeypair();

  const quote = await buildReceiveQuote(
    {
      receiverPubkey: keypair.publicKey,
      deliveryClass: DeliveryClass.PRIORITY,
      priceAtomic: 1_000,
      currency: "USDC",
      validSeconds: 300,
      maxPayloadBytes: 65_536,
    },
    { seed: keypair.seed },
  );

  // Structure checks
  assert.equal(typeof quote.quoteId, "string", "quoteId is string");
  assert.equal(quote.quoteId.length, 32, "quoteId is 32 hex chars (16 bytes)");
  assert.equal(quote.deliveryClass, "priority");
  assert.equal(quote.priceAtomic, 1_000);
  assert.equal(quote.currency, "USDC");
  assert.equal(quote.maxPayloadBytes, 65_536);
  assert.ok(quote.validUntil > Date.now(), "validUntil is in the future");
  assert.equal(typeof quote.receiverSignature, "string", "signature is string");
  assert.equal(quote.receiverSignature.length, 128, "Ed25519 sig = 64 bytes = 128 hex chars");

  // receiverSubjectHash must be sha256(pubkey), NOT the raw pubkey
  const expectedHash = sha256hex(keypair.publicKey);
  assert.equal(quote.receiverSubjectHash, expectedHash, "receiverSubjectHash = sha256(pubkey)");

  // Signature must verify
  const valid = await verifyReceiveQuote(quote, keypair.publicKey);
  assert.ok(valid, "quote signature verifies with correct pubkey");
});

// ---------------------------------------------------------------------------
// Test 2: wrong pubkey rejects quote
// ---------------------------------------------------------------------------

test("wrong pubkey rejects quote verification", async () => {
  const keypair = await generateKeypair();
  const otherKeypair = await generateKeypair();

  const quote = await buildReceiveQuote(
    {
      receiverPubkey: keypair.publicKey,
      deliveryClass: DeliveryClass.STANDARD,
      priceAtomic: 500,
      currency: "SOL",
      validSeconds: 60,
      maxPayloadBytes: 1_024,
    },
    { seed: keypair.seed },
  );

  // Verifying with a different pubkey must return false
  const invalidResult = await verifyReceiveQuote(quote, otherKeypair.publicKey);
  assert.equal(invalidResult, false, "wrong pubkey must not verify");

  // But correct pubkey still works
  const validResult = await verifyReceiveQuote(quote, keypair.publicKey);
  assert.ok(validResult, "correct pubkey still verifies");
});

// ---------------------------------------------------------------------------
// Test 3: delivery receipt builds and verifies
// ---------------------------------------------------------------------------

test("delivery receipt builds and verifies correctly", async () => {
  const keypair = await generateKeypair();

  const quote = await buildReceiveQuote(
    {
      receiverPubkey: keypair.publicKey,
      deliveryClass: DeliveryClass.AGENT_ACTION,
      priceAtomic: 2_000,
      currency: "USDC",
      validSeconds: 600,
      maxPayloadBytes: 32_768,
    },
    { seed: keypair.seed },
  );

  const fakeCiphertext = new Uint8Array(64).fill(0xab);
  const payload = buildPayToReceivePayload(quote, fakeCiphertext);
  const resultDigest = sha256hex(Buffer.from("agent result output"));

  const receipt = await buildDeliveryReceipt(
    quote.quoteId,
    payload.payloadHash,
    payload.senderNonce,
    { seed: keypair.seed, publicKey: keypair.publicKey },
    resultDigest,
  );

  // Structure checks
  assert.equal(typeof receipt.receiptId, "string");
  assert.equal(receipt.receiptId.length, 32);
  assert.equal(receipt.quoteId, quote.quoteId, "receipt links back to quote");
  assert.equal(receipt.ciphertextHash, payload.payloadHash, "ciphertextHash matches payload");
  assert.equal(receipt.senderNonce, payload.senderNonce, "senderNonce preserved");
  assert.equal(receipt.resultDigest, resultDigest, "resultDigest stored");
  assert.ok(receipt.deliveredAt > 0, "deliveredAt is set");
  assert.equal(typeof receipt.receiverSignature, "string");
  assert.equal(receipt.receiverSignature.length, 128, "Ed25519 sig = 128 hex chars");

  // Signature must verify
  const valid = await verifyDeliveryReceipt(receipt, keypair.publicKey);
  assert.ok(valid, "receipt signature verifies with correct pubkey");
});

// ---------------------------------------------------------------------------
// Test 4: payload hash is deterministic
// ---------------------------------------------------------------------------

test("payload hash is deterministic for identical ciphertext bytes", () => {
  const fakeCiphertext = new Uint8Array(128);
  for (let i = 0; i < 128; i++) fakeCiphertext[i] = i;

  const quote = {
    quoteId: "aabbccddeeff00112233445566778899",
    receiverSubjectHash: "ignored",
    deliveryClass: DeliveryClass.ENCRYPTED,
    priceAtomic: 100,
    currency: "USDC",
    validUntil: Date.now() + 60_000,
    maxPayloadBytes: 1_024,
    receiverSignature: "fakesig",
  };

  const result1 = buildPayToReceivePayload(quote, fakeCiphertext);
  const result2 = buildPayToReceivePayload(quote, fakeCiphertext);

  // payloadHash must be the same for the same bytes
  assert.equal(result1.payloadHash, result2.payloadHash, "payloadHash is deterministic");

  // encryptedPayload bytes must match the input
  assert.deepEqual(result1.encryptedPayload, fakeCiphertext, "encryptedPayload passthrough");

  // Verify the hash is actually SHA-256 of the bytes
  const expected = sha256hex(fakeCiphertext);
  assert.equal(result1.payloadHash, expected, "payloadHash = sha256(ciphertext)");
});

// ---------------------------------------------------------------------------
// Test 5: senderNonce is unique per call
// ---------------------------------------------------------------------------

test("senderNonce is unique per buildPayToReceivePayload call", () => {
  const fakeCiphertext = randomBytes(64);

  const quote = {
    quoteId: "aabbccddeeff00112233445566778899",
    receiverSubjectHash: "ignored",
    deliveryClass: DeliveryClass.WEBHOOK,
    priceAtomic: 50,
    currency: "SOL",
    validUntil: Date.now() + 120_000,
    maxPayloadBytes: 1_024,
    receiverSignature: "fakesig",
  };

  const nonces = new Set();
  const N = 100;
  for (let i = 0; i < N; i++) {
    const result = buildPayToReceivePayload(quote, fakeCiphertext);
    assert.equal(typeof result.senderNonce, "string", "senderNonce is a string");
    assert.equal(result.senderNonce.length, 32, "senderNonce is 32 hex chars (16 bytes)");
    nonces.add(result.senderNonce);
  }

  assert.equal(nonces.size, N, `all ${N} nonces must be unique`);
});

// ---------------------------------------------------------------------------
// Test 6: payload size limit enforced
// ---------------------------------------------------------------------------

test("buildPayToReceivePayload throws when payload exceeds maxPayloadBytes", () => {
  const oversizedPayload = new Uint8Array(1025);
  const quote = {
    quoteId: "aabbccddeeff00112233445566778899",
    receiverSubjectHash: "ignored",
    deliveryClass: DeliveryClass.STANDARD,
    priceAtomic: 100,
    currency: "USDC",
    validUntil: Date.now() + 60_000,
    maxPayloadBytes: 1_024,
    receiverSignature: "fakesig",
  };

  assert.throws(
    () => buildPayToReceivePayload(quote, oversizedPayload),
    /maxPayloadBytes/,
    "should throw RangeError mentioning maxPayloadBytes",
  );
});

// ---------------------------------------------------------------------------
// Test 7: expired quote is rejected by buildPayToReceivePayload
// ---------------------------------------------------------------------------

test("buildPayToReceivePayload rejects an expired quote", () => {
  const payload = new Uint8Array(16).fill(0x01);
  const expiredQuote = {
    quoteId: "aabbccddeeff00112233445566778899",
    receiverSubjectHash: "ignored",
    deliveryClass: DeliveryClass.PRIORITY,
    priceAtomic: 100,
    currency: "USDC",
    validUntil: Date.now() - 1_000,   // already expired
    maxPayloadBytes: 1_024,
    receiverSignature: "fakesig",
  };

  assert.throws(
    () => buildPayToReceivePayload(expiredQuote, payload),
    /expired/i,
    "should throw mentioning expiry",
  );
});

// ---------------------------------------------------------------------------
// Test 8: tampered receipt signature fails verification
// ---------------------------------------------------------------------------

test("tampered delivery receipt fails verification", async () => {
  const keypair = await generateKeypair();

  const quote = await buildReceiveQuote(
    {
      receiverPubkey: keypair.publicKey,
      deliveryClass: DeliveryClass.STANDARD,
      priceAtomic: 100,
      currency: "USDC",
      validSeconds: 300,
      maxPayloadBytes: 512,
    },
    { seed: keypair.seed },
  );

  const payload = buildPayToReceivePayload(quote, new Uint8Array(16).fill(0xff));
  const receipt = await buildDeliveryReceipt(
    quote.quoteId,
    payload.payloadHash,
    payload.senderNonce,
    { seed: keypair.seed, publicKey: keypair.publicKey },
  );

  // Tamper with the ciphertextHash
  const tampered = { ...receipt, ciphertextHash: "00".repeat(32) };
  const result = await verifyDeliveryReceipt(tampered, keypair.publicKey);
  assert.equal(result, false, "tampered receipt must not verify");
});
