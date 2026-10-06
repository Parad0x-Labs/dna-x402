/**
 * Tests for @parad0x_labs/zk-access
 * Run: node --experimental-transform-types --test tests/zk-access.test.mjs
 *
 * (--experimental-transform-types is needed because src uses a TypeScript enum,
 *  which plain type stripping does not support.)
 *
 * Signatures are cross-checked with node:crypto's independent Ed25519
 * implementation, not only with the @noble/curves code under test.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, randomBytes, verify as nodeVerify } from "node:crypto";

import {
  AccessTier,
  issueAccessCredential,
  verifyAccessCredential,
  consumeCall,
  buildAccessProofInput,
  AccessCallLedger,
} from "../src/index.ts";

const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n; // Ed25519 group order
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Derive the Ed25519 public key (hex) from a 32-byte seed with node:crypto. */
function nodePubkeyHex(seed) {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const jwk = createPublicKey(priv).export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url").toString("hex");
}

function nodeVerifyHex(sigHex, message, pubHex) {
  const pub = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pubHex, "hex").toString("base64url") },
    format: "jwk",
  });
  return nodeVerify(null, Buffer.from(message), pub, Buffer.from(sigHex, "hex"));
}

const canonical = (c) =>
  `zk-access-v1:${c.agentPubkey}:${c.tier}:${c.callsRemaining}:${c.validUntilSlot}:${c.issuedByPubkey}`;

const issuerSeed = randomBytes(32);
const TRUSTED = [nodePubkeyHex(issuerSeed)];
const agentPubkey = nodePubkeyHex(randomBytes(32));

function issue(over = {}, seed = issuerSeed) {
  return issueAccessCredential(
    { agentPubkey, tier: AccessTier.PRO, callsRemaining: 3, validUntilSlot: 350_000_000, ...over },
    seed,
  );
}

const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");
const u64be = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const field = (hex) => (BigInt("0x" + hex) % R).toString(16).padStart(64, "0");

// ---------------------------------------------------------------------------
// AccessTier
// ---------------------------------------------------------------------------

test("AccessTier is ordered FREE < BASIC < PRO < ELITE as 0..3", () => {
  assert.deepEqual(
    [AccessTier.FREE, AccessTier.BASIC, AccessTier.PRO, AccessTier.ELITE],
    [0, 1, 2, 3],
  );
});

// ---------------------------------------------------------------------------
// issueAccessCredential
// ---------------------------------------------------------------------------

describe("issueAccessCredential", () => {
  test("signs the canonical payload with the issuer key (checked with node:crypto)", () => {
    const c = issue();
    assert.equal(c.issuedByPubkey, nodePubkeyHex(issuerSeed));
    assert.match(c.signature, /^[0-9a-f]{128}$/);
    assert.equal(c.agentPubkey, agentPubkey);
    assert.equal(c.tier, AccessTier.PRO);
    assert.equal(c.callsRemaining, 3);
    assert.equal(c.validUntilSlot, 350_000_000);
    assert.ok(nodeVerifyHex(c.signature, canonical(c), c.issuedByPubkey));
  });

  test("Ed25519 signing is deterministic for identical parameters", () => {
    assert.equal(issue().signature, issue().signature);
    assert.notEqual(issue().signature, issue({ callsRemaining: 4 }).signature);
  });

  test("rejects an issuer key that is not a 32-byte seed", () => {
    for (const len of [0, 31, 33, 64]) {
      assert.throws(() => issue({}, new Uint8Array(len)), /must be 32 bytes/, `len ${len}`);
    }
  });

  test("rejects a tier outside FREE..ELITE", () => {
    for (const tier of [4, -1, 1.5, NaN]) {
      assert.throws(() => issue({ tier }), /tier/, String(tier));
    }
  });

  test("rejects negative, fractional or non-finite callsRemaining", () => {
    for (const callsRemaining of [-1, 1.5, NaN, Infinity]) {
      assert.throws(() => issue({ callsRemaining }), /callsRemaining/, String(callsRemaining));
    }
    assert.doesNotThrow(() => issue({ callsRemaining: 0 }));
  });

  test("rejects negative, fractional or non-finite validUntilSlot (NaN would never expire)", () => {
    for (const validUntilSlot of [-1, 10.5, NaN, Infinity]) {
      assert.throws(() => issue({ validUntilSlot }), /validUntilSlot/, String(validUntilSlot));
    }
  });
});

// ---------------------------------------------------------------------------
// verifyAccessCredential
// ---------------------------------------------------------------------------

describe("verifyAccessCredential", () => {
  test("accepts a fresh credential up to and including its expiry slot", () => {
    const c = issue({ validUntilSlot: 1000 });
    assert.deepEqual(verifyAccessCredential(c, 0, TRUSTED), { valid: true, reason: null });
    assert.deepEqual(verifyAccessCredential(c, 1000, TRUSTED), { valid: true, reason: null });
  });

  test("rejects once the slot passes validUntilSlot", () => {
    const r = verifyAccessCredential(issue({ validUntilSlot: 1000 }), 1001, TRUSTED);
    assert.equal(r.valid, false);
    assert.equal(r.reason, "credential expired at slot 1000 (current: 1001)");
  });

  test("rejects an exhausted credential", () => {
    const r = verifyAccessCredential(issue({ callsRemaining: 0 }), 1, TRUSTED);
    assert.equal(r.valid, false);
    assert.match(r.reason, /exhausted/);
  });

  test("rejects a non-numeric current slot instead of skipping the expiry check", () => {
    const c = issue({ validUntilSlot: 10 });
    for (const slot of [NaN, undefined, -1]) {
      const r = verifyAccessCredential(c, slot, TRUSTED);
      assert.equal(r.valid, false, String(slot));
      assert.match(r.reason, /currentSlot/);
    }
  });

  test("any edit to a signed field breaks the signature", () => {
    const c = issue({ tier: AccessTier.BASIC, callsRemaining: 5, validUntilSlot: 100 });
    const otherAgent = nodePubkeyHex(randomBytes(32));
    for (const [field, value] of [
      ["tier", AccessTier.ELITE],
      ["callsRemaining", 500],
      ["validUntilSlot", 10_000_000],
      ["agentPubkey", otherAgent],
    ]) {
      const r = verifyAccessCredential({ ...c, [field]: value }, 1, TRUSTED);
      assert.equal(r.valid, false, field);
      assert.equal(r.reason, "signature verification failed", field);
    }
  });

  test("a flipped signature bit is rejected", () => {
    const c = issue();
    const sig = Buffer.from(c.signature, "hex");
    for (const idx of [0, 31, 32, 63]) {
      const bad = Buffer.from(sig);
      bad[idx] ^= 0x01;
      const r = verifyAccessCredential({ ...c, signature: bad.toString("hex") }, 1, TRUSTED);
      assert.equal(r.valid, false, `byte ${idx}`);
    }
  });

  test("a malleated signature (S + L) is rejected", () => {
    const c = issue();
    const sig = Buffer.from(c.signature, "hex");
    const s = BigInt("0x" + Buffer.from(sig.subarray(32)).reverse().toString("hex"));
    const sPlusL = s + L;
    assert.ok(sPlusL < 2n ** 256n);
    const sBytes = Buffer.from(sPlusL.toString(16).padStart(64, "0"), "hex").reverse();
    const mall = Buffer.concat([sig.subarray(0, 32), sBytes]).toString("hex");
    assert.equal(verifyAccessCredential({ ...c, signature: mall }, 1, TRUSTED).valid, false);
  });

  test("swapping in a different issuer key without re-signing is rejected", () => {
    const c = issue();
    const attackerPub = nodePubkeyHex(randomBytes(32));
    const r = verifyAccessCredential({ ...c, issuedByPubkey: attackerPub }, 1, TRUSTED);
    assert.equal(r.valid, false);
    assert.equal(r.reason, "signature verification failed");
  });

  test("a signature from another issuer over the same fields is rejected", () => {
    const c = issue();
    const other = issue({}, randomBytes(32));
    const r = verifyAccessCredential({ ...c, signature: other.signature }, 1, TRUSTED);
    assert.equal(r.valid, false);
  });

  test("malformed signature or issuer hex is reported, not thrown", () => {
    const c = issue();
    for (const patch of [
      { signature: "zz" },
      { signature: c.signature.slice(0, 126) },
      { signature: "abc" },
      { issuedByPubkey: "not-hex" },
    ]) {
      const r = verifyAccessCredential({ ...c, ...patch }, 1, TRUSTED);
      assert.equal(r.valid, false);
      assert.match(r.reason, /malformed|failed/);
    }
  });

  test("rejects a credential signed by an issuer the verifier does not trust", () => {
    const attackerSeed = randomBytes(32);
    const forged = issueAccessCredential(
      { agentPubkey, tier: AccessTier.ELITE, callsRemaining: 1_000_000, validUntilSlot: 2 ** 40 },
      attackerSeed,
    );
    // The forged credential is internally consistent (valid signature under its own key)...
    assert.ok(nodeVerifyHex(forged.signature, canonical(forged), forged.issuedByPubkey));
    // ...but its issuer is not trusted.
    assert.deepEqual(verifyAccessCredential(forged, 1, TRUSTED), { valid: false, reason: "issuer is not trusted" });
    // Trusting the attacker key explicitly is the only way it passes.
    assert.equal(verifyAccessCredential(forged, 1, [forged.issuedByPubkey]).valid, true);
  });

  test("fails closed when no trusted issuers are configured", () => {
    const c = issue();
    for (const trusted of [[], undefined, null, "not-an-array"]) {
      const r = verifyAccessCredential(c, 1, trusted);
      assert.equal(r.valid, false);
      assert.equal(r.reason, "no trusted issuers configured");
    }
  });

  test("trusted issuer match is case-insensitive hex", () => {
    const c = issue();
    assert.equal(verifyAccessCredential(c, 1, [TRUSTED[0].toUpperCase()]).valid, true);
  });
});

// ---------------------------------------------------------------------------
// AccessCallLedger (verifier-side replay protection)
// ---------------------------------------------------------------------------

describe("AccessCallLedger", () => {
  test("rejects a superseded credential after consumeCall (replay of an older balance)", () => {
    const ledger = new AccessCallLedger();
    const before = issue({ callsRemaining: 2 });
    assert.equal(verifyAccessCredential(before, 1, TRUSTED).valid, true);
    assert.equal(ledger.accept(before).valid, true);
    const after = consumeCall(before, issuerSeed);
    assert.equal(ledger.accept(after).valid, true);
    // The old credential still has a valid signature, but the ledger refuses it.
    assert.equal(verifyAccessCredential(before, 1, TRUSTED).valid, true);
    const r = ledger.accept(before);
    assert.equal(r.valid, false);
    assert.match(r.reason, /replayed/);
  });

  test("presenting the same credential twice is rejected", () => {
    const ledger = new AccessCallLedger();
    const c = issue({ callsRemaining: 5 });
    assert.equal(ledger.accept(c).valid, true);
    assert.equal(ledger.accept(c).valid, false);
  });

  test("balances are tracked per agent, issuer, tier and expiry", () => {
    const ledger = new AccessCallLedger();
    const a = issue({ callsRemaining: 3 });
    const otherAgent = issue({ callsRemaining: 3, agentPubkey: nodePubkeyHex(randomBytes(32)) });
    const otherIssuer = issue({ callsRemaining: 3 }, randomBytes(32));
    const topUp = issue({ callsRemaining: 3, validUntilSlot: a.validUntilSlot + 1 });
    for (const c of [a, otherAgent, otherIssuer, topUp]) assert.equal(ledger.accept(c).valid, true);
    assert.equal(ledger.accept(a).valid, false);
  });

  test("a full consume chain is accepted once per step", () => {
    const ledger = new AccessCallLedger();
    let c = issue({ callsRemaining: 3 });
    const seen = [];
    while (c.callsRemaining > 0) {
      assert.equal(ledger.accept(c).valid, true);
      seen.push(c);
      c = consumeCall(c, issuerSeed);
    }
    for (const old of seen) assert.equal(ledger.accept(old).valid, false);
  });
});

// ---------------------------------------------------------------------------
// consumeCall
// ---------------------------------------------------------------------------

describe("consumeCall", () => {
  test("decrements callsRemaining by one and re-signs; other fields unchanged", () => {
    const c = issue({ callsRemaining: 3 });
    const next = consumeCall(c, issuerSeed);
    assert.equal(next.callsRemaining, 2);
    assert.equal(next.tier, c.tier);
    assert.equal(next.agentPubkey, c.agentPubkey);
    assert.equal(next.validUntilSlot, c.validUntilSlot);
    assert.equal(next.issuedByPubkey, c.issuedByPubkey);
    assert.notEqual(next.signature, c.signature);
    assert.ok(nodeVerifyHex(next.signature, canonical(next), next.issuedByPubkey));
    assert.equal(c.callsRemaining, 3, "input not mutated");
  });

  test("consumes down to exhaustion, then refuses", () => {
    let c = issue({ callsRemaining: 2 });
    c = consumeCall(c, issuerSeed);
    assert.equal(verifyAccessCredential(c, 1, TRUSTED).valid, true);
    c = consumeCall(c, issuerSeed);
    assert.equal(c.callsRemaining, 0);
    assert.match(verifyAccessCredential(c, 1, TRUSTED).reason, /exhausted/);
    assert.throws(() => consumeCall(c, issuerSeed), /already exhausted/);
  });

  test("refuses an issuer key that did not sign the credential", () => {
    assert.throws(() => consumeCall(issue(), randomBytes(32)), /does not match cred.issuedByPubkey/);
  });

  test("refuses to re-sign a tampered credential (no laundering of a raised tier)", () => {
    const c = issue({ tier: AccessTier.BASIC, callsRemaining: 5 });
    const tampered = { ...c, tier: AccessTier.ELITE };
    assert.throws(() => consumeCall(tampered, issuerSeed), /signature/);
    const inflated = { ...c, callsRemaining: 5000 };
    assert.throws(() => consumeCall(inflated, issuerSeed), /signature/);
  });
});

// ---------------------------------------------------------------------------
// buildAccessProofInput
// ---------------------------------------------------------------------------

describe("buildAccessProofInput", () => {
  test("matches an independent recomputation of the documented layout", () => {
    const c = issue({ tier: AccessTier.ELITE, callsRemaining: 77, validUntilSlot: 123_456_789 });
    const p = buildAccessProofInput(c);

    const agentH = field(sha256Hex(Buffer.from(c.agentPubkey, "hex")));
    const callsH = field(sha256Hex(u64be(77)));
    const issuerH = field(sha256Hex(Buffer.from(c.issuedByPubkey, "hex")));
    const sigH = field(sha256Hex(Buffer.from(c.signature, "hex")));
    const root = field(
      sha256Hex(
        Buffer.concat([
          Buffer.from(agentH, "hex"),
          Buffer.from(callsH, "hex"),
          u64be(3),
          u64be(123_456_789),
          Buffer.from(issuerH, "hex"),
          Buffer.from(sigH, "hex"),
        ]),
      ),
    );

    assert.deepEqual(p, {
      agentPubkeyHash: agentH,
      tierValue: 3,
      callsRemainingHash: callsH,
      validUntilSlot: 123_456_789,
      issuerPubkeyHash: issuerH,
      signatureHash: sigH,
      credentialRoot: root,
    });
  });

  test("every hash output is a canonical BN254 field element (< r)", () => {
    for (let i = 0; i < 40; i++) {
      const p = buildAccessProofInput(issue({ callsRemaining: i + 1 }, randomBytes(32)));
      for (const k of ["agentPubkeyHash", "callsRemainingHash", "issuerPubkeyHash", "signatureHash", "credentialRoot"]) {
        assert.match(p[k], /^[0-9a-f]{64}$/, k);
        assert.ok(BigInt("0x" + p[k]) < R, `${k} must be < r`);
      }
    }
  });

  test("is deterministic", () => {
    const c = issue();
    assert.deepEqual(buildAccessProofInput(c), buildAccessProofInput(c));
  });

  test("the root binds every credential field, including the signature", () => {
    const base = issue({ callsRemaining: 10, validUntilSlot: 500 });
    const root = buildAccessProofInput(base).credentialRoot;
    const variants = [
      issue({ callsRemaining: 9, validUntilSlot: 500 }),
      issue({ callsRemaining: 10, validUntilSlot: 501 }),
      issue({ callsRemaining: 10, validUntilSlot: 500, tier: AccessTier.ELITE }),
      issue({ callsRemaining: 10, validUntilSlot: 500, agentPubkey: nodePubkeyHex(randomBytes(32)) }),
      issue({ callsRemaining: 10, validUntilSlot: 500 }, randomBytes(32)),
      { ...base, signature: issue({ callsRemaining: 11 }).signature },
    ];
    const roots = new Set(variants.map((v) => buildAccessProofInput(v).credentialRoot));
    assert.equal(roots.size, variants.length);
    assert.ok(!roots.has(root));
  });

  test("rejects non-hex key material", () => {
    assert.throws(() => buildAccessProofInput({ ...issue(), agentPubkey: "AgentBase58NotHex" }));
  });
});
