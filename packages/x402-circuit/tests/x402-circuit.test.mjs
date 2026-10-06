/**
 * Tests for @parad0x_labs/x402-circuit
 * Run: node --experimental-strip-types --test tests/x402-circuit.test.mjs
 *
 * Covers the pure layers: circuit-input builder, snarkjs → AccessProof encoding,
 * the 352-byte dark_bn254_gate payload, and the off-chain shape check.
 * verifyAccessProof() is only exercised up to its pre-RPC shape gate.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import {
  buildAccessProofInput,
  encodeAccessProof,
  serializeAccessProof,
  checkAccessProofShape,
  verifyAccessProof,
  bytesToHex,
  hexToBytes,
} from "../src/index.ts";

const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex32 = (n) => n.toString(16).padStart(64, "0");

/** Independent re-implementation of the documented SHA-256 Poseidon stand-in. */
function refHash(a, b) {
  const buf = Buffer.alloc(65);
  buf[0] = 0xd0;
  Buffer.from(hex32(a), "hex").copy(buf, 1);
  Buffer.from(hex32(b), "hex").copy(buf, 33);
  return BigInt("0x" + createHash("sha256").update(buf).digest("hex")) % R;
}
const toField = (bytes) => (bytes.length ? BigInt("0x" + Buffer.from(bytes).toString("hex")) % R : 0n);

/** A snarkjs-shaped proof with recognisable coordinates. */
function fakeSnarkjsProof() {
  return {
    pi_a: ["11", "12", "1"],
    pi_b: [["21", "22"], ["23", "24"], ["1", "0"]],
    pi_c: ["31", "32", "1"],
    protocol: "groth16",
    curve: "bn128",
  };
}

function validAccessProof() {
  const input = buildAccessProofInput(randomBytes(32), randomBytes(32), 1000, 500, 123456);
  return encodeAccessProof(fakeSnarkjsProof(), [input.commitment, input.threshold, input.nullifier]);
}

// ---------------------------------------------------------------------------
// buildAccessProofInput
// ---------------------------------------------------------------------------

describe("buildAccessProofInput", () => {
  const secret = Buffer.from("01".repeat(32), "hex");
  const agent = Buffer.from("02".repeat(32), "hex");

  test("computes commitment = H(secret, agent) and nullifier = H(secret, nonce)", () => {
    const inp = buildAccessProofInput(secret, agent, 1000, 500, 42);
    const s = toField(secret);
    const a = toField(agent);
    assert.equal(inp.secret, s.toString());
    assert.equal(inp.agent_id, a.toString());
    assert.equal(inp.commitment, refHash(s, a).toString());
    assert.equal(inp.nullifier, refHash(s, 42n).toString());
    assert.equal(inp.balance, "1000");
    assert.equal(inp.threshold, "500");
    assert.equal(inp.nonce, "42");
  });

  test("all values are decimal strings (circom input.json convention)", () => {
    const inp = buildAccessProofInput(secret, agent, 1n, 1n, 1n);
    for (const [k, v] of Object.entries(inp)) assert.match(v, /^\d+$/, k);
  });

  test("is deterministic, and hex-string inputs equal byte inputs", () => {
    const a = buildAccessProofInput(secret, agent, 10, 5, 7);
    const b = buildAccessProofInput(secret.toString("hex"), agent.toString("hex"), 10n, 5n, 7n);
    assert.deepEqual(a, b);
  });

  test("a new nonce yields a fresh nullifier but the same commitment", () => {
    const a = buildAccessProofInput(secret, agent, 10, 5, 1);
    const b = buildAccessProofInput(secret, agent, 10, 5, 2);
    assert.equal(a.commitment, b.commitment);
    assert.notEqual(a.nullifier, b.nullifier);
  });

  test("re-using a nonce reproduces the nullifier (replays are detectable)", () => {
    const a = buildAccessProofInput(secret, agent, 10, 5, 99);
    const b = buildAccessProofInput(secret, agent, 999, 1, 99);
    assert.equal(a.nullifier, b.nullifier);
  });

  test("a different secret changes both commitment and nullifier", () => {
    const other = Buffer.from("03".repeat(32), "hex");
    const a = buildAccessProofInput(secret, agent, 10, 5, 1);
    const b = buildAccessProofInput(other, agent, 10, 5, 1);
    assert.notEqual(a.commitment, b.commitment);
    assert.notEqual(a.nullifier, b.nullifier);
  });

  test("a different agent changes the commitment only", () => {
    const a = buildAccessProofInput(secret, agent, 10, 5, 1);
    const b = buildAccessProofInput(secret, Buffer.from("04".repeat(32), "hex"), 10, 5, 1);
    assert.notEqual(a.commitment, b.commitment);
    assert.equal(a.nullifier, b.nullifier);
  });

  test("every output is a canonical BN254 field element", () => {
    const max = Buffer.alloc(32, 0xff);
    const inp = buildAccessProofInput(max, max, 2n ** 64n - 1n, 0, R + 5n);
    for (const k of ["commitment", "nullifier", "secret", "agent_id", "nonce"]) {
      assert.ok(BigInt(inp[k]) < R, `${k} < r`);
    }
    assert.equal(inp.secret, ((2n ** 256n - 1n) % R).toString());
    assert.equal(inp.nonce, "5", "nonce is reduced mod r");
  });

  test("negative nonces wrap into the field", () => {
    assert.equal(buildAccessProofInput(secret, agent, 1, 1, -1).nonce, (R - 1n).toString());
  });

  test("balance and threshold must be in [0, 2^64)", () => {
    assert.doesNotThrow(() => buildAccessProofInput(secret, agent, 0, 0, 1));
    assert.doesNotThrow(() => buildAccessProofInput(secret, agent, 2n ** 64n - 1n, 2n ** 64n - 1n, 1));
    assert.throws(() => buildAccessProofInput(secret, agent, -1, 0, 1), /balance must be in/);
    assert.throws(() => buildAccessProofInput(secret, agent, 2n ** 64n, 0, 1), /balance must be in/);
    assert.throws(() => buildAccessProofInput(secret, agent, 0, -1, 1), /threshold must be in/);
    assert.throws(() => buildAccessProofInput(secret, agent, 0, 2n ** 64n, 1), /threshold must be in/);
  });

  test("non-integer numeric inputs are rejected", () => {
    assert.throws(() => buildAccessProofInput(secret, agent, 1.5, 1, 1), RangeError);
    assert.throws(() => buildAccessProofInput(secret, agent, 1, 1, 0.1), RangeError);
  });

  test("malformed hex secrets are rejected", () => {
    assert.throws(() => buildAccessProofInput("zz".repeat(32), agent, 1, 1, 1));
    assert.throws(() => buildAccessProofInput("abc", agent, 1, 1, 1));
  });
});

// ---------------------------------------------------------------------------
// encodeAccessProof
// ---------------------------------------------------------------------------

describe("encodeAccessProof", () => {
  test("lays out A || B || C with G2 coordinates imaginary-first", () => {
    const ap = encodeAccessProof(fakeSnarkjsProof(), ["5", "6", "7"]);
    assert.equal(ap.proof.length, 512);
    const word = (i) => BigInt("0x" + ap.proof.slice(i * 64, (i + 1) * 64));
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 6, 7].map(word),
      [11n, 12n, 22n, 21n, 24n, 23n, 31n, 32n],
    );
  });

  test("encodes public inputs as 64-char big-endian hex and keeps the decimals", () => {
    const ap = encodeAccessProof(fakeSnarkjsProof(), ["255", "1", (R - 1n).toString()]);
    assert.equal(ap.commitment, hex32(255n));
    assert.equal(ap.threshold, hex32(1n));
    assert.equal(ap.nullifier, hex32(R - 1n));
    assert.deepEqual(ap.publicInputs, ["255", "1", (R - 1n).toString()]);
  });

  test("extra public signals are dropped; fewer than three are rejected", () => {
    const ap = encodeAccessProof(fakeSnarkjsProof(), ["1", "2", "3", "4"]);
    assert.deepEqual(ap.publicInputs, ["1", "2", "3"]);
    assert.throws(() => encodeAccessProof(fakeSnarkjsProof(), ["1", "2"]), /Expected 3 public inputs/);
    assert.throws(() => encodeAccessProof(fakeSnarkjsProof(), []), /got 0/);
  });

  test("non-numeric coordinates are rejected", () => {
    const bad = fakeSnarkjsProof();
    bad.pi_a = ["not-a-number", "1", "1"];
    assert.throws(() => encodeAccessProof(bad, ["1", "2", "3"]), SyntaxError);
  });
});

// ---------------------------------------------------------------------------
// serializeAccessProof
// ---------------------------------------------------------------------------

describe("serializeAccessProof", () => {
  test("produces the 352-byte dark_bn254_gate payload: proof | commitment | threshold | nullifier", () => {
    const ap = validAccessProof();
    const bytes = serializeAccessProof(ap);
    assert.equal(bytes.length, 352);
    assert.equal(bytesToHex(bytes.subarray(0, 256)), ap.proof);
    assert.equal(bytesToHex(bytes.subarray(256, 288)), ap.commitment);
    assert.equal(bytesToHex(bytes.subarray(288, 320)), ap.threshold);
    assert.equal(bytesToHex(bytes.subarray(320, 352)), ap.nullifier);
  });

  test("left-pads short field hex to 32 bytes", () => {
    const ap = { ...validAccessProof(), commitment: "ab", threshold: "1", nullifier: "0102" };
    const bytes = serializeAccessProof(ap);
    assert.equal(bytesToHex(bytes.subarray(256, 288)), hex32(0xabn));
    assert.equal(bytesToHex(bytes.subarray(288, 320)), hex32(1n));
    assert.equal(bytesToHex(bytes.subarray(320, 352)), hex32(0x0102n));
  });

  test("rejects a proof that is not exactly 256 bytes", () => {
    const ap = validAccessProof();
    assert.throws(() => serializeAccessProof({ ...ap, proof: ap.proof.slice(0, 510) }), /proof must be 256 bytes, got 255/);
    assert.throws(() => serializeAccessProof({ ...ap, proof: ap.proof + "00" }), /got 257/);
  });

  test("rejects a public input wider than 32 bytes instead of overwriting the next slot", () => {
    const ap = validAccessProof();
    assert.throws(() => serializeAccessProof({ ...ap, commitment: "00" + ap.commitment }), /commitment must be 32 bytes/);
    assert.throws(() => serializeAccessProof({ ...ap, threshold: "ff" + ap.threshold }), /threshold must be 32 bytes/);
    assert.throws(() => serializeAccessProof({ ...ap, nullifier: "01" + ap.nullifier }), /nullifier must be 32 bytes/);
  });
});

// ---------------------------------------------------------------------------
// checkAccessProofShape
// ---------------------------------------------------------------------------

describe("checkAccessProofShape", () => {
  test("accepts a well-formed proof built from the input builder", () => {
    assert.deepEqual(checkAccessProofShape(validAccessProof()), { valid: true, reason: null });
  });

  test("rejects a proof of the wrong hex length", () => {
    const ap = validAccessProof();
    const r = checkAccessProofShape({ ...ap, proof: ap.proof.slice(2) });
    assert.equal(r.valid, false);
    assert.match(r.reason, /512 hex chars.*got 510/);
  });

  test("rejects zero commitment or zero nullifier", () => {
    const ap = validAccessProof();
    for (const field of ["commitment", "nullifier"]) {
      for (const zero of ["0".repeat(64), "0", ""]) {
        const r = checkAccessProofShape({ ...ap, [field]: zero });
        assert.equal(r.valid, false);
        assert.match(r.reason, /zero/);
      }
    }
  });

  test("rejects any public input >= the BN254 scalar field order", () => {
    const ap = validAccessProof();
    for (const field of ["commitment", "threshold", "nullifier"]) {
      const r = checkAccessProofShape({ ...ap, [field]: hex32(R) });
      assert.equal(r.valid, false);
      assert.equal(r.reason, `${field} >= BN254 scalar field order`);
    }
  });

  test("accepts r - 1 when the public inputs agree", () => {
    const ap = encodeAccessProof(fakeSnarkjsProof(), [(R - 1n).toString(), "0", (R - 1n).toString()]);
    assert.equal(checkAccessProofShape(ap).valid, true);
  });

  test("rejects fewer than three public inputs", () => {
    const ap = validAccessProof();
    const r = checkAccessProofShape({ ...ap, publicInputs: ap.publicInputs.slice(0, 2) });
    assert.equal(r.valid, false);
    assert.match(r.reason, /expected 3 public inputs, got 2/);
  });

  test("rejects an all-zero proof body", () => {
    const ap = validAccessProof();
    const r = checkAccessProofShape({ ...ap, proof: "0".repeat(512) });
    assert.equal(r.valid, false);
    assert.match(r.reason, /all zero/);
  });

  test("non-hex content is reported as a parse error, never thrown", () => {
    const ap = validAccessProof();
    const r1 = checkAccessProofShape({ ...ap, proof: "zz".repeat(256) });
    assert.equal(r1.valid, false);
    assert.match(r1.reason, /parse error/);
  });

  test("rejects a public input wider than 64 hex chars even if its value is in range", () => {
    const ap = validAccessProof();
    const r = checkAccessProofShape({ ...ap, commitment: "00" + ap.commitment });
    assert.equal(r.valid, false);
    assert.match(r.reason, /commitment must be 1-64 hex chars/);
  });

  test("rejects a swapped nullifier that no longer matches the public inputs (tamper)", () => {
    const ap = validAccessProof();
    const swapped = { ...ap, nullifier: hex32(BigInt("0x" + ap.nullifier) ^ 1n) };
    const r = checkAccessProofShape(swapped);
    assert.equal(r.valid, false);
    assert.match(r.reason, /nullifier does not match publicInputs\[2\]/);
  });

  test("rejects a lowered threshold that disagrees with the public inputs (tamper)", () => {
    const ap = validAccessProof();
    const r = checkAccessProofShape({ ...ap, threshold: hex32(0n) });
    assert.equal(r.valid, false);
    assert.match(r.reason, /threshold does not match publicInputs\[1\]/);
  });

  test("rejects a public-inputs array that was edited after encoding (tamper)", () => {
    const ap = validAccessProof();
    const r = checkAccessProofShape({ ...ap, publicInputs: [ap.publicInputs[0], ap.publicInputs[1], "12345"] });
    assert.equal(r.valid, false);
    assert.match(r.reason, /nullifier does not match/);
  });
});

// ---------------------------------------------------------------------------
// verifyAccessProof — pre-RPC gate only
// ---------------------------------------------------------------------------

describe("verifyAccessProof (shape gate, no RPC)", () => {
  test("throws on a malformed proof before any Solana connection is attempted", async () => {
    const ap = { ...validAccessProof(), proof: "00" };
    await assert.rejects(
      verifyAccessProof(ap, "11111111111111111111111111111111", "http://127.0.0.1:1", new Uint8Array(64)),
      /AccessProof shape invalid: proof must be 512 hex chars/,
    );
  });

  test("throws on a tampered public input before any Solana connection is attempted", async () => {
    const ap = validAccessProof();
    await assert.rejects(
      verifyAccessProof({ ...ap, commitment: hex32(R) }, "11111111111111111111111111111111", "http://127.0.0.1:1", new Uint8Array(64)),
      /commitment >= BN254 scalar field order/,
    );
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe("round trip", () => {
  test("input → snarkjs public signals → AccessProof → instruction bytes", () => {
    const inp = buildAccessProofInput(randomBytes(32), randomBytes(20), 5_000, 1_000, 300_000_000);
    const ap = encodeAccessProof(fakeSnarkjsProof(), [inp.commitment, inp.threshold, inp.nullifier]);
    assert.equal(checkAccessProofShape(ap).valid, true);
    const ix = serializeAccessProof(ap);
    assert.equal(BigInt("0x" + bytesToHex(ix.subarray(256, 288))), BigInt(inp.commitment));
    assert.equal(BigInt("0x" + bytesToHex(ix.subarray(288, 320))), 1000n);
    assert.equal(BigInt("0x" + bytesToHex(ix.subarray(320, 352))), BigInt(inp.nullifier));
    assert.deepEqual(hexToBytes(ap.proof), ix.subarray(0, 256));
  });
});
