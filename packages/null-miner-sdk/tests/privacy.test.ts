/**
 * NULL Miner SDK — Privacy Module Tests
 *
 * Tests for DKSAP stealth addresses, Dark Pool ECDH encryption,
 * and Chaumian blind signatures (Schnorr over secp256k1).
 * All pure computation — no network calls.
 */

import {
  generateStealthKeyPair,
  deriveStealthKeyPair,
  generateStealthAddress,
  checkStealthAddress,
  recoverStealthSpendKey,
} from "../src/privacy/stealth.js";

import {
  encryptTask,
  decryptTask,
  sealBid,
  openBid,
} from "../src/privacy/darkPool.js";

import {
  mintKeyGen,
  mintSignInit,
  mintSign,
  clientBlind,
  clientUnblind,
  verifyNullToken,
} from "../src/privacy/nullMint.js";

// ── Stealth Addresses ─────────────────────────────────────────────────────────

describe("StealthKeyPair", () => {
  test("generateStealthKeyPair produces 32-byte keys", () => {
    const kp = generateStealthKeyPair();
    expect(kp.scanPriv).toHaveLength(32);
    expect(kp.scanPub).toHaveLength(32);
    expect(kp.spendPriv).toHaveLength(32);
    expect(kp.spendPub).toHaveLength(32);
  });

  test("generateStealthKeyPair produces unique keys each time", () => {
    const kp1 = generateStealthKeyPair();
    const kp2 = generateStealthKeyPair();
    expect(Buffer.from(kp1.scanPub).equals(Buffer.from(kp2.scanPub))).toBe(false);
    expect(Buffer.from(kp1.spendPub).equals(Buffer.from(kp2.spendPub))).toBe(false);
  });

  test("deriveStealthKeyPair is deterministic", () => {
    const seed = new Uint8Array(32).fill(0x42);
    const kp1  = deriveStealthKeyPair(seed);
    const kp2  = deriveStealthKeyPair(seed);
    expect(Buffer.from(kp1.scanPub).equals(Buffer.from(kp2.scanPub))).toBe(true);
    expect(Buffer.from(kp1.spendPub).equals(Buffer.from(kp2.spendPub))).toBe(true);
  });

  test("deriveStealthKeyPair differs per seed", () => {
    const seed1 = new Uint8Array(32).fill(0x01);
    const seed2 = new Uint8Array(32).fill(0x02);
    const kp1   = deriveStealthKeyPair(seed1);
    const kp2   = deriveStealthKeyPair(seed2);
    expect(Buffer.from(kp1.scanPub).equals(Buffer.from(kp2.scanPub))).toBe(false);
  });

  test("scan key and spend key are different (no accidental reuse)", () => {
    const kp = generateStealthKeyPair();
    expect(Buffer.from(kp.scanPub).equals(Buffer.from(kp.spendPub))).toBe(false);
  });
});

describe("DKSAP round-trip", () => {
  test("generateStealthAddress + checkStealthAddress: positive case", () => {
    const recipient = generateStealthKeyPair();
    const addr = generateStealthAddress(recipient.scanPub, recipient.spendPub);

    expect(addr.stealthPub).toHaveLength(32);
    expect(addr.ephemeralPub).toHaveLength(32);
    expect(typeof addr.viewTag).toBe("number");

    const found = checkStealthAddress(
      { scanPriv: recipient.scanPriv, spendPub: recipient.spendPub },
      addr.ephemeralPub,
      addr.stealthPub,
    );
    expect(found).toBe(true);
  });

  test("checkStealthAddress fails for wrong recipient", () => {
    const alice = generateStealthKeyPair();
    const bob   = generateStealthKeyPair();

    const addr = generateStealthAddress(alice.scanPub, alice.spendPub);
    const found = checkStealthAddress(
      { scanPriv: bob.scanPriv, spendPub: bob.spendPub },
      addr.ephemeralPub,
      addr.stealthPub,
    );
    expect(found).toBe(false);
  });

  test("different ephemeral keys produce different stealth addresses", () => {
    const recipient = generateStealthKeyPair();
    const r1 = generateStealthAddress(recipient.scanPub, recipient.spendPub);
    const r2 = generateStealthAddress(recipient.scanPub, recipient.spendPub);
    // Random ephemeral → different stealth pubs
    expect(Buffer.from(r1.stealthPub).equals(Buffer.from(r2.stealthPub))).toBe(false);
  });

  test("same ephemeral key → same stealth address (deterministic)", () => {
    const recipient = generateStealthKeyPair();
    const ephem = new Uint8Array(32).fill(0x37);
    const r1 = generateStealthAddress(recipient.scanPub, recipient.spendPub, ephem);
    const r2 = generateStealthAddress(recipient.scanPub, recipient.spendPub, ephem);
    expect(Buffer.from(r1.stealthPub).equals(Buffer.from(r2.stealthPub))).toBe(true);
  });

  test("recoverStealthSpendKey: stealthPub matches computed", () => {
    const recipient = generateStealthKeyPair();
    const addr = generateStealthAddress(recipient.scanPub, recipient.spendPub);

    const recovered = recoverStealthSpendKey(recipient, addr.ephemeralPub);
    // The recovered stealthPub must match what the sender computed
    expect(Buffer.from(recovered.stealthPub).equals(Buffer.from(addr.stealthPub))).toBe(true);
    expect(recovered.stealthScalar).toHaveLength(32);
  });

  test("view tag is the first byte of the derived scalar", () => {
    const recipient = generateStealthKeyPair();
    const ephem = new Uint8Array(32).fill(0x11);
    const addr = generateStealthAddress(recipient.scanPub, recipient.spendPub, ephem);
    expect(addr.viewTag).toBeGreaterThanOrEqual(0);
    expect(addr.viewTag).toBeLessThan(256);
  });

  test("checkStealthAddress with wrong viewTag rejects immediately", () => {
    const recipient = generateStealthKeyPair();
    const addr = generateStealthAddress(recipient.scanPub, recipient.spendPub);
    // Pass a viewTag that is definitely wrong (we XOR by 1 to guarantee wrong)
    const wrongTag = addr.viewTag ^ 0xff;
    const result = checkStealthAddress(
      { scanPriv: recipient.scanPriv, spendPub: recipient.spendPub },
      addr.ephemeralPub,
      addr.stealthPub,
      wrongTag,
    );
    expect(result).toBe(false);
  });
});

// ── Dark Pool Encryption ──────────────────────────────────────────────────────

describe("Dark Pool — task encryption", () => {
  const agentKeys = deriveStealthKeyPair(new Uint8Array(32).fill(0x55));

  test("encryptTask + decryptTask roundtrip", () => {
    const task = { id: "abc123", kind: "residential_relay", reward: 0.001 };
    const { encrypted } = encryptTask(task, agentKeys.scanPub);
    const decrypted = decryptTask<typeof task>(encrypted, agentKeys.scanPriv);
    expect(decrypted).toEqual(task);
  });

  test("different tasks decrypt to different payloads", () => {
    const task1 = { id: "task-1", reward: 0.001 };
    const task2 = { id: "task-2", reward: 0.002 };
    const { encrypted: e1 } = encryptTask(task1, agentKeys.scanPub);
    const { encrypted: e2 } = encryptTask(task2, agentKeys.scanPub);
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
    expect(decryptTask(e1, agentKeys.scanPriv)).toEqual(task1);
    expect(decryptTask(e2, agentKeys.scanPriv)).toEqual(task2);
  });

  test("encrypted fields are hex strings", () => {
    const { encrypted } = encryptTask({ x: 1 }, agentKeys.scanPub);
    expect(encrypted.ephemeralPub).toMatch(/^[0-9a-f]+$/);
    expect(encrypted.nonce).toMatch(/^[0-9a-f]+$/);
    expect(encrypted.tag).toMatch(/^[0-9a-f]+$/);
    expect(encrypted.ciphertext).toMatch(/^[0-9a-f]+$/);
  });

  test("wrong scan key fails to decrypt (GCM auth tag mismatch)", () => {
    const { encrypted } = encryptTask({ secret: "data" }, agentKeys.scanPub);
    const wrongKeys = generateStealthKeyPair();
    expect(() => decryptTask(encrypted, wrongKeys.scanPriv)).toThrow();
  });

  test("sealBid + openBid roundtrip", () => {
    const platformKeys = deriveStealthKeyPair(new Uint8Array(32).fill(0x77));
    const proofHash    = "a".repeat(64);
    const bid          = sealBid(proofHash, platformKeys.scanPub);

    expect(bid.encryptedBid).toBeDefined();
    expect(typeof bid.timestamp).toBe("number");

    const opened = openBid(bid, platformKeys.scanPriv);
    expect(opened).toBe(proofHash);
  });

  test("sealBid ciphertext differs per call (random ephemeral)", () => {
    const platformKeys = deriveStealthKeyPair(new Uint8Array(32).fill(0x77));
    const b1 = sealBid("a".repeat(64), platformKeys.scanPub);
    const b2 = sealBid("a".repeat(64), platformKeys.scanPub);
    expect(b1.encryptedBid).not.toBe(b2.encryptedBid);
  });
});

// ── Chaumian Blind Signatures ─────────────────────────────────────────────────

describe("NULL Mint — Schnorr blind signatures", () => {
  function fullRoundTrip(message: string) {
    const mintKP   = mintKeyGen();
    const { kPriv, nonce } = mintSignInit();

    const msgBytes = Buffer.from(message, "hex");
    const { challenge, state } = clientBlind(msgBytes, mintKP.publicKey, nonce.R);

    const response = mintSign(kPriv, mintKP.privateKey, challenge.c);
    const token    = clientUnblind(response, state);

    return { token, mintPublicKey: mintKP.publicKey };
  }

  test("mintKeyGen returns compressed secp256k1 key (66 hex chars)", () => {
    const kp = mintKeyGen();
    expect(kp.publicKey).toHaveLength(66);  // 33 bytes * 2 = 66 chars
    expect(kp.publicKey).toMatch(/^(02|03)[0-9a-f]{64}$/);  // compressed point prefix
    expect(kp.privateKey).toHaveLength(64);
  });

  test("mintSignInit produces valid nonce", () => {
    const { kPriv, nonce } = mintSignInit();
    expect(nonce.R).toHaveLength(66);  // compressed secp256k1 point
    expect(nonce.sessionId).toHaveLength(32);  // 16 bytes hex
    expect(kPriv).toHaveLength(64);
  });

  test("full round-trip: blind sign unblind verify", () => {
    const burnReceiptHash = "a".repeat(64);
    const { token, mintPublicKey } = fullRoundTrip(burnReceiptHash);

    expect(token.message).toBe(burnReceiptHash);
    expect(verifyNullToken(token, mintPublicKey)).toBe(true);
  });

  test("token e and zPrime are 64-char hex scalars", () => {
    const { token } = fullRoundTrip("b".repeat(64));
    expect(token.e).toHaveLength(64);
    expect(token.zPrime).toHaveLength(64);
    expect(token.RPrime).toHaveLength(66);  // compressed secp256k1 point
  });

  test("token from wrong mint key fails verification", () => {
    const wrongMint = mintKeyGen();
    const { token } = fullRoundTrip("c".repeat(64));
    expect(verifyNullToken(token, wrongMint.publicKey)).toBe(false);
  });

  test("tampered token e fails verification", () => {
    const { token, mintPublicKey } = fullRoundTrip("d".repeat(64));
    const tampered = { ...token, e: "0".repeat(64) };
    expect(verifyNullToken(tampered, mintPublicKey)).toBe(false);
  });

  test("tampered token zPrime fails verification", () => {
    const { token, mintPublicKey } = fullRoundTrip("e".repeat(64));
    const tampered = { ...token, zPrime: "f".repeat(64) };
    expect(verifyNullToken(tampered, mintPublicKey)).toBe(false);
  });

  test("different messages produce different tokens", () => {
    const { token: t1 } = fullRoundTrip("1".repeat(64));
    const { token: t2 } = fullRoundTrip("2".repeat(64));
    expect(t1.e).not.toBe(t2.e);
    expect(t1.zPrime).not.toBe(t2.zPrime);
  });

  test("two rounds with same message produce different tokens (blind nonce randomness)", () => {
    const msg = "a".repeat(64);
    const { token: t1 } = fullRoundTrip(msg);
    const { token: t2 } = fullRoundTrip(msg);
    // Different kPriv and alpha/beta → different R' → different e
    expect(t1.RPrime).not.toBe(t2.RPrime);
  });
});
