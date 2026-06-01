/**
 * Tests for @parad0x_labs/blind-access
 * Covers both the original HMAC blind-token API and the new PrivateCompute layer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  // HMAC blind token API
  mintBlindTokens,
  verifyBlindToken,
  markSpent,
  buildRedeemPayload,
  // Private Compute API
  createPrivateComputeSession,
  finalizeSession,
  buildCommitmentHash,
  decryptResult,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(str) {
  return createHash("sha256").update(str).digest("hex");
}

// Encrypt with AES-256-GCM (mirrors the internal helper) so we can test decryptResult.
import { createCipheriv } from "node:crypto";
function aesGcmEncrypt(plaintextUtf8, keyHex) {
  const key = Buffer.from(keyHex, "hex");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintextUtf8, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, encrypted, tag]).toString("base64");
}

// ---------------------------------------------------------------------------
// Existing HMAC blind-token tests (smoke-checks to ensure no regression)
// ---------------------------------------------------------------------------

test("mintBlindTokens — returns correct count and tier", () => {
  const batch = mintBlindTokens("supersecret", 3, "pro");
  assert.equal(batch.tokens.length, 3);
  assert.equal(batch.tier, "pro");
  assert.ok(batch.issuedAt > 0);
  assert.ok(batch.expiresAt > batch.issuedAt);
});

test("buildRedeemPayload — includes tokenId and hmac", () => {
  const batch = mintBlindTokens("supersecret", 1, "basic");
  const payload = buildRedeemPayload(batch.tokens[0]);
  assert.equal(payload.tokenId, batch.tokens[0].tokenId);
  assert.equal(payload.hmac, batch.tokens[0].hmac);
});

test("markSpent — sets spentAt, throws on double-spend", () => {
  const batch = mintBlindTokens("supersecret", 1, "basic");
  const spent = markSpent(batch.tokens[0]);
  assert.ok(spent.spentAt > 0);
  assert.throws(() => markSpent(spent), /already spent/);
});

// ---------------------------------------------------------------------------
// PrivateCompute: createPrivateComputeSession
// ---------------------------------------------------------------------------

test("createPrivateComputeSession — produces deterministic inputHash", () => {
  const input = "hello, private world";
  const s1 = createPrivateComputeSession(input);
  const s2 = createPrivateComputeSession(input);
  const expected = sha256Hex(input);

  assert.equal(s1.inputHash, expected, "inputHash should be sha256 of plaintext");
  assert.equal(s2.inputHash, expected, "inputHash must be deterministic for same input");
});

test("createPrivateComputeSession — uses provided keyHex", () => {
  const keyHex = randomBytes(32).toString("hex");
  const session = createPrivateComputeSession("test input", keyHex);
  assert.equal(session.keyHex, keyHex);
});

test("createPrivateComputeSession — generates random sessionId and keyHex when not provided", () => {
  const s1 = createPrivateComputeSession("same input");
  const s2 = createPrivateComputeSession("same input");
  assert.notEqual(s1.sessionId, s2.sessionId, "sessionIds should differ");
  assert.notEqual(s1.keyHex, s2.keyHex, "keys should differ when not provided");
});

test("createPrivateComputeSession — different keys produce different ciphertexts", () => {
  const input = "sensitive agent state";
  const key1 = randomBytes(32).toString("hex");
  const key2 = randomBytes(32).toString("hex");
  const s1 = createPrivateComputeSession(input, key1);
  const s2 = createPrivateComputeSession(input, key2);
  assert.notEqual(
    s1.encryptedInputBase64,
    s2.encryptedInputBase64,
    "different keys must produce different ciphertexts"
  );
});

test("createPrivateComputeSession — same key still produces different ciphertexts (random nonce)", () => {
  const input = "nonce must be random";
  const keyHex = randomBytes(32).toString("hex");
  const s1 = createPrivateComputeSession(input, keyHex);
  const s2 = createPrivateComputeSession(input, keyHex);
  // GCM nonces are random, so ciphertexts should differ almost certainly.
  assert.notEqual(
    s1.encryptedInputBase64,
    s2.encryptedInputBase64,
    "same key, same input — different nonce must produce different ciphertext"
  );
});

test("createPrivateComputeSession — sets createdAt and has no resultHash", () => {
  const session = createPrivateComputeSession("initial");
  assert.ok(session.createdAt > 0);
  assert.equal(session.resultHash, undefined);
  assert.equal(session.commitmentTx, undefined);
  assert.equal(session.executorEndpoint, undefined);
});

// ---------------------------------------------------------------------------
// PrivateCompute: finalizeSession + buildCommitmentHash
// ---------------------------------------------------------------------------

test("finalizeSession — sets resultHash as sha256 of JSON.stringify(response)", () => {
  const session = createPrivateComputeSession("test prompt");
  const response = { answer: 42, status: "ok" };
  const finalised = finalizeSession(session, response);

  const expected = sha256Hex(JSON.stringify(response));
  assert.equal(finalised.resultHash, expected);
  // Original session unchanged
  assert.equal(session.resultHash, undefined);
});

test("finalizeSession + buildCommitmentHash — is deterministic", () => {
  const keyHex = randomBytes(32).toString("hex");
  // Use same key to get same encrypted blob, but inputHash is key-independent.
  const session = createPrivateComputeSession("deterministic test", keyHex);
  const response = { result: "same every time" };

  const f1 = finalizeSession(session, response);
  const f2 = finalizeSession(session, response);

  const c1 = buildCommitmentHash(f1);
  const c2 = buildCommitmentHash(f2);

  assert.deepEqual(
    Buffer.from(c1).toString("hex"),
    Buffer.from(c2).toString("hex"),
    "commitment hash must be deterministic for same inputHash + resultHash"
  );
});

test("buildCommitmentHash — returns 32-byte Uint8Array", () => {
  const session = finalizeSession(createPrivateComputeSession("input"), { x: 1 });
  const hash = buildCommitmentHash(session);
  assert.ok(hash instanceof Uint8Array);
  assert.equal(hash.length, 32);
});

test("buildCommitmentHash — equals sha256(inputHash + resultHash)", () => {
  const session = finalizeSession(createPrivateComputeSession("verify me"), { ok: true });
  const hash = buildCommitmentHash(session);
  const expected = createHash("sha256")
    .update(session.inputHash + session.resultHash)
    .digest();
  assert.deepEqual(Buffer.from(hash).toString("hex"), expected.toString("hex"));
});

test("buildCommitmentHash — throws if resultHash missing", () => {
  const session = createPrivateComputeSession("not finalised");
  assert.throws(() => buildCommitmentHash(session), /finalised|resultHash/i);
});

test("finalizeSession — different responses produce different resultHashes", () => {
  const session = createPrivateComputeSession("same input");
  const f1 = finalizeSession(session, { x: 1 });
  const f2 = finalizeSession(session, { x: 2 });
  assert.notEqual(f1.resultHash, f2.resultHash);
});

// ---------------------------------------------------------------------------
// PrivateCompute: decryptResult round-trip
// ---------------------------------------------------------------------------

test("decryptResult — round-trips correctly (encrypt then decrypt)", () => {
  const keyHex = randomBytes(32).toString("hex");
  const plaintext = "executor result: 42 tokens transferred";

  // Encrypt using the helper defined at the top of this file (same algorithm).
  const encryptedBase64 = aesGcmEncrypt(plaintext, keyHex);
  const decrypted = decryptResult(encryptedBase64, keyHex);

  assert.equal(decrypted, plaintext);
});

test("decryptResult — fails with wrong key (auth tag mismatch)", () => {
  const keyHex = randomBytes(32).toString("hex");
  const wrongKey = randomBytes(32).toString("hex");
  const encryptedBase64 = aesGcmEncrypt("secret data", keyHex);

  assert.throws(
    () => decryptResult(encryptedBase64, wrongKey),
    (err) => {
      // Node throws 'Unsupported state or unable to authenticate data'
      return err instanceof Error;
    }
  );
});

test("decryptResult — full session flow: createSession → decryptResult", () => {
  const input = "private inference prompt";
  const session = createPrivateComputeSession(input);

  // Simulate executor encrypting its result with the session key.
  const executorPlaintext = "answer: the sky is blue";
  const encryptedResult = aesGcmEncrypt(executorPlaintext, session.keyHex);
  const decrypted = decryptResult(encryptedResult, session.keyHex);

  assert.equal(decrypted, executorPlaintext);
});

// ---------------------------------------------------------------------------
// PrivateCompute: full end-to-end flow
// ---------------------------------------------------------------------------

test("full PrivateCompute flow: create → finalize → commit → verify", () => {
  const input = "What is 2+2?";
  const executorResponse = { answer: "4", confidence: 0.999 };

  // Step 1: Agent creates session, sends encryptedInputBase64 + inputHash to executor.
  const session = createPrivateComputeSession(input);
  assert.equal(session.inputHash, sha256Hex(input));

  // Step 2: Agent finalises after receiving executor response.
  const finalised = finalizeSession(session, executorResponse);
  assert.ok(finalised.resultHash);

  // Step 3: Build Solana commitment.
  const commitment = buildCommitmentHash(finalised);
  assert.equal(commitment.length, 32);

  // Step 4: Independently verify commitment value.
  const expectedCommitment = createHash("sha256")
    .update(finalised.inputHash + finalised.resultHash)
    .digest();
  assert.deepEqual(
    Buffer.from(commitment).toString("hex"),
    expectedCommitment.toString("hex")
  );

  // Step 5: Simulate executor encrypting result; agent decrypts.
  const encryptedResult = aesGcmEncrypt(JSON.stringify(executorResponse), session.keyHex);
  const decrypted = decryptResult(encryptedResult, session.keyHex);
  assert.equal(decrypted, JSON.stringify(executorResponse));
});
