/**
 * Tests for @parad0x_labs/deepfake-gate
 * Run: node --experimental-vm-modules --test tests/deepfake-gate.test.mjs
 *
 * Uses node:test. The live x402 path (DEEPFAKE_GATE_LIVE=1) is exercised
 * against a loopback HTTP server on 127.0.0.1, so no external network is used.
 */

import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";

import {
  DetectionProvider,
  DETECTION_PRICES_USDC,
  buildDetectionRequest,
  detect,
  buildNullLiveDetectionBadge,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

/** Find media bytes whose SHA-256 satisfies a predicate (deterministic search). */
function mediaWhere(pred, tag = "m") {
  for (let i = 0; i < 100_000; i++) {
    const bytes = new TextEncoder().encode(`${tag}-${i}`);
    if (pred(sha256Hex(bytes))) return bytes;
  }
  throw new Error("no matching media found");
}

const isOddFirstByte = (h) => (parseInt(h.slice(0, 2), 16) & 1) === 1;

/** Real Ed25519 signer backed by node:crypto. */
function makeSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const calls = [];
  return {
    publicKey,
    calls,
    sign: async (challenge) => {
      calls.push(challenge);
      return new Uint8Array(edSign(null, Buffer.from(challenge), privateKey));
    },
  };
}

function makeConfig(signer, extra = {}) {
  return {
    facilitatorUrl: "https://facilitator.example/",
    payerPublicKey: "PayerPubkey1111111111111111111111111111111",
    sign: signer.sign,
    ...extra,
  };
}

/** Recompute the canonical x402 challenge exactly as the payer must have signed it. */
function challengeFor({ amount, endpoint, hash, network, nonce, payer }) {
  const canonical = [
    `amount=${amount}`,
    `endpoint=${endpoint}`,
    `hash=${hash}`,
    `network=${network}`,
    `nonce=${nonce}`,
    `payer=${payer}`,
    `scheme=exact`,
  ].join("\t");
  return createHash("sha256").update(canonical).digest();
}

// ---------------------------------------------------------------------------
// buildDetectionRequest
// ---------------------------------------------------------------------------

describe("buildDetectionRequest", () => {
  test("hashes media with SHA-256 and routes to the provider path", () => {
    const media = new TextEncoder().encode("frame-bytes");
    const req = buildDetectionRequest(media, DetectionProvider.HIVE, "https://f.example");
    assert.equal(req.mediaHash, sha256Hex(media));
    assert.equal(req.x402Endpoint, "https://f.example/detect/hive");
    assert.equal(req.estimatedPriceUsdc, 0.01);
  });

  test("strips exactly one trailing slash from the facilitator URL", () => {
    const media = new Uint8Array([1, 2, 3]);
    const a = buildDetectionRequest(media, DetectionProvider.SYNTHID, "https://f.example/");
    const b = buildDetectionRequest(media, DetectionProvider.SYNTHID, "https://f.example");
    assert.equal(a.x402Endpoint, "https://f.example/detect/synthid");
    assert.equal(a.x402Endpoint, b.x402Endpoint);
  });

  test("every provider has a distinct endpoint and its published price", () => {
    const media = new Uint8Array(0);
    const endpoints = new Set();
    for (const p of Object.values(DetectionProvider)) {
      const req = buildDetectionRequest(media, p, "https://f.example");
      assert.equal(req.estimatedPriceUsdc, DETECTION_PRICES_USDC[p]);
      assert.equal(req.x402Endpoint, `https://f.example/detect/${p}`);
      endpoints.add(req.x402Endpoint);
    }
    assert.equal(endpoints.size, 4);
  });

  test("empty media hashes to the SHA-256 of the empty string", () => {
    const req = buildDetectionRequest(new Uint8Array(0), DetectionProvider.MOCK, "https://f");
    assert.equal(req.mediaHash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("a one-bit change in the media changes the hash", () => {
    const a = new Uint8Array(64);
    const b = new Uint8Array(64);
    b[63] = 1;
    const ha = buildDetectionRequest(a, DetectionProvider.MOCK, "https://f").mediaHash;
    const hb = buildDetectionRequest(b, DetectionProvider.MOCK, "https://f").mediaHash;
    assert.notEqual(ha, hb);
  });

  test("rejects an unknown provider instead of building a .../undefined endpoint", () => {
    assert.throws(
      () => buildDetectionRequest(new Uint8Array(1), "deepvision", "https://f.example"),
      /Unknown detection provider/,
    );
    assert.throws(
      () => buildDetectionRequest(new Uint8Array(1), "constructor", "https://f.example"),
      /Unknown detection provider/,
    );
  });

  test("pricing is ordered SynthID < BitMind < Hive and MOCK is free", () => {
    assert.ok(DETECTION_PRICES_USDC.synthid < DETECTION_PRICES_USDC.bitmind);
    assert.ok(DETECTION_PRICES_USDC.bitmind < DETECTION_PRICES_USDC.hive);
    assert.equal(DETECTION_PRICES_USDC.mock, 0);
  });
});

// ---------------------------------------------------------------------------
// detect() — offline paths
// ---------------------------------------------------------------------------

describe("detect (offline)", () => {
  test("MOCK provider never calls the signer and is deterministic on the hash parity", async () => {
    const signer = makeSigner();
    const odd = mediaWhere(isOddFirstByte, "odd");
    const even = mediaWhere((h) => !isOddFirstByte(h), "even");

    const r1 = await detect(odd, DetectionProvider.MOCK, makeConfig(signer));
    const r2 = await detect(even, DetectionProvider.MOCK, makeConfig(signer));

    assert.equal(signer.calls.length, 0, "MOCK must not trigger a payment signature");
    assert.equal(r1.isAiGenerated, true);
    assert.equal(r1.confidence, 87);
    assert.equal(r2.isAiGenerated, false);
    assert.equal(r2.confidence, 12);
    for (const r of [r1, r2]) {
      assert.equal(r.provider, "mock");
      assert.equal(r.priceUsdc, 0);
      assert.equal(r.detectionMethod, "classifier");
      assert.equal(r.receiptHash, undefined);
      assert.match(r.requestId, /^[0-9a-f]{32}$/);
      assert.ok(r.processingMs >= 0);
    }
    assert.equal(r1.mediaHash, sha256Hex(odd));
  });

  test("each call gets a fresh random requestId", async () => {
    const signer = makeSigner();
    const media = new TextEncoder().encode("same-media");
    const a = await detect(media, DetectionProvider.MOCK, makeConfig(signer));
    const b = await detect(media, DetectionProvider.MOCK, makeConfig(signer));
    assert.notEqual(a.requestId, b.requestId);
    assert.equal(a.mediaHash, b.mediaHash);
    assert.equal(a.isAiGenerated, b.isAiGenerated);
  });

  test("paid providers sign exactly one 32-byte challenge per call and report method/price", async () => {
    const media = new TextEncoder().encode("paid-path");
    const expected = {
      synthid: { method: "watermark", base: 60 },
      bitmind: { method: "classifier", base: 70 },
      hive: { method: "hybrid", base: 75 },
    };
    const h = sha256Hex(media);
    const second = parseInt(h.slice(2, 4), 16);
    for (const [p, { method, base }] of Object.entries(expected)) {
      const signer = makeSigner();
      const r = await detect(media, p, makeConfig(signer));
      assert.equal(signer.calls.length, 1, `${p}: one signature`);
      assert.equal(signer.calls[0].length, 32, `${p}: 32-byte challenge`);
      assert.equal(r.provider, p);
      assert.equal(r.detectionMethod, method);
      assert.equal(r.priceUsdc, DETECTION_PRICES_USDC[p]);
      assert.equal(r.isAiGenerated, isOddFirstByte(h));
      assert.equal(r.confidence, Math.min(99, base + (second % 25)));
      assert.ok(r.confidence >= 0 && r.confidence <= 99);
    }
  });

  test("successive payments use a fresh nonce (challenges never repeat)", async () => {
    const signer = makeSigner();
    const media = new TextEncoder().encode("nonce-check");
    await detect(media, DetectionProvider.BITMIND, makeConfig(signer));
    await detect(media, DetectionProvider.BITMIND, makeConfig(signer));
    assert.equal(signer.calls.length, 2);
    assert.notDeepEqual(Buffer.from(signer.calls[0]), Buffer.from(signer.calls[1]));
  });

  test("a failing signer rejects detect() — no unpaid result is returned", async () => {
    const cfg = makeConfig(makeSigner(), {
      sign: async () => {
        throw new Error("wallet rejected");
      },
    });
    await assert.rejects(
      detect(new TextEncoder().encode("x"), DetectionProvider.HIVE, cfg),
      /wallet rejected/,
    );
  });

  test("anchorReceipt=true yields a receipt hash bound to requestId, mediaHash and verdict", async () => {
    const signer = makeSigner();
    const media = new TextEncoder().encode("anchor-me");
    const r = await detect(media, DetectionProvider.SYNTHID, makeConfig(signer, { anchorReceipt: true }));
    const verdict = r.isAiGenerated ? "1" : "0";
    const resultHash = sha256Hex(`${r.requestId}:${r.mediaHash}:${verdict}`);
    // Offline anchor: first 44 hex chars of the result hash plus a 4-char marker.
    assert.equal(r.receiptHash.length, 48);
    assert.equal(r.receiptHash.slice(0, 44), resultHash.slice(0, 44));

    const flipped = sha256Hex(`${r.requestId}:${r.mediaHash}:${verdict === "1" ? "0" : "1"}`);
    assert.notEqual(r.receiptHash.slice(0, 44), flipped.slice(0, 44));
  });

  test("anchorReceipt defaults to off", async () => {
    const r = await detect(new TextEncoder().encode("no-anchor"), DetectionProvider.HIVE, makeConfig(makeSigner()));
    assert.equal(r.receiptHash, undefined);
  });

  test("rejects an unknown provider before any payment is signed", async () => {
    const signer = makeSigner();
    await assert.rejects(
      detect(new TextEncoder().encode("x"), "deepvision", makeConfig(signer)),
      /Unknown detection provider/,
    );
    assert.equal(signer.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// detect() — result cache
// ---------------------------------------------------------------------------

describe("detect cache", () => {
  test("no caching by default: every call pays", async () => {
    const signer = makeSigner();
    const media = randomBytes(32);
    await detect(media, DetectionProvider.HIVE, makeConfig(signer));
    await detect(media, DetectionProvider.HIVE, makeConfig(signer));
    assert.equal(signer.calls.length, 2);
  });

  test("a fresh cache hit returns the stored result without a second payment", async () => {
    const signer = makeSigner();
    const media = randomBytes(32);
    const opts = { cacheMaxAgeMs: 60_000 };
    const a = await detect(media, DetectionProvider.HIVE, makeConfig(signer), opts);
    const b = await detect(media, DetectionProvider.HIVE, makeConfig(signer), opts);
    assert.equal(signer.calls.length, 1);
    assert.equal(b.requestId, a.requestId);
    assert.deepEqual(b, a);
  });

  test("cache is keyed per provider", async () => {
    const signer = makeSigner();
    const media = randomBytes(32);
    const opts = { cacheMaxAgeMs: 60_000 };
    const a = await detect(media, DetectionProvider.HIVE, makeConfig(signer), opts);
    const b = await detect(media, DetectionProvider.BITMIND, makeConfig(signer), opts);
    assert.equal(signer.calls.length, 2);
    assert.notEqual(a.requestId, b.requestId);
    assert.equal(b.provider, "bitmind");
  });

  test("cache is keyed per media hash", async () => {
    const signer = makeSigner();
    const opts = { cacheMaxAgeMs: 60_000 };
    await detect(randomBytes(32), DetectionProvider.SYNTHID, makeConfig(signer), opts);
    await detect(randomBytes(32), DetectionProvider.SYNTHID, makeConfig(signer), opts);
    assert.equal(signer.calls.length, 2);
  });

  test("an expired entry is not served: the caller pays again", async () => {
    const signer = makeSigner();
    const media = randomBytes(32);
    const a = await detect(media, DetectionProvider.HIVE, makeConfig(signer), { cacheMaxAgeMs: 5 });
    await new Promise((r) => setTimeout(r, 25));
    const b = await detect(media, DetectionProvider.HIVE, makeConfig(signer), { cacheMaxAgeMs: 5 });
    assert.equal(signer.calls.length, 2);
    assert.notEqual(a.requestId, b.requestId);
  });

  test("a result produced without caching is not served to a later caching call", async () => {
    const signer = makeSigner();
    const media = randomBytes(32);
    const a = await detect(media, DetectionProvider.HIVE, makeConfig(signer));
    const b = await detect(media, DetectionProvider.HIVE, makeConfig(signer), { cacheMaxAgeMs: 60_000 });
    assert.equal(signer.calls.length, 2);
    assert.notEqual(a.requestId, b.requestId);
  });
});

// ---------------------------------------------------------------------------
// detect() — live x402 path against a loopback facilitator
// ---------------------------------------------------------------------------

describe("detect (live path, loopback facilitator)", () => {
  let server;
  let base;
  let prevEnv;
  const seen = [];
  const behaviour = { detectStatus: 200, anchorStatus: 200, anchorBody: { txSignature: "5igTxSig" } };

  before(async () => {
    prevEnv = process.env.DEEPFAKE_GATE_LIVE;
    process.env.DEEPFAKE_GATE_LIVE = "1";
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.url.startsWith("/receipts/anchor")) {
          res.writeHead(behaviour.anchorStatus, { "content-type": "application/json" });
          res.end(JSON.stringify(behaviour.anchorBody));
          return;
        }
        if (behaviour.detectStatus !== 200) {
          res.writeHead(behaviour.detectStatus);
          res.end("payment required");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ isAiGenerated: true, confidence: 93 }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (prevEnv === undefined) delete process.env.DEEPFAKE_GATE_LIVE;
    else process.env.DEEPFAKE_GATE_LIVE = prevEnv;
    await new Promise((r) => server.close(r));
  });

  test("sends a payment header whose Ed25519 signature verifies over the canonical challenge", async () => {
    seen.length = 0;
    const signer = makeSigner();
    const media = new TextEncoder().encode("live-media");
    const mediaHash = sha256Hex(media);
    const cfg = makeConfig(signer, { facilitatorUrl: base + "/", network: "devnet" });

    const r = await detect(media, DetectionProvider.HIVE, cfg);

    assert.equal(r.isAiGenerated, true, "verdict comes from the server response");
    assert.equal(r.confidence, 93);
    assert.equal(seen.length, 1);
    const req = seen[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, `/detect/hive?hash=${mediaHash}`);
    assert.deepEqual(JSON.parse(req.body), { mediaHash });

    const pay = JSON.parse(req.headers["x-payment"]);
    assert.equal(pay.scheme, "exact");
    assert.equal(pay.asset, "USDC");
    assert.equal(pay.network, "devnet");
    assert.equal(pay.amount, "10000", "0.01 USDC in 6-decimal micro units");
    assert.equal(pay.payer, cfg.payerPublicKey);
    assert.match(pay.nonce, /^[0-9a-f]{64}$/);

    const sig = Buffer.from(pay.signature, "base64");
    assert.equal(sig.length, 64);
    const fields = {
      amount: pay.amount,
      endpoint: `${base}/detect/hive`,
      hash: mediaHash,
      network: pay.network,
      nonce: pay.nonce,
      payer: pay.payer,
    };
    assert.ok(edVerify(null, challengeFor(fields), signer.publicKey, sig), "signature must verify");

    // Tampering with any signed field breaks the signature.
    for (const [k, v] of [
      ["amount", "1"],
      ["endpoint", `${base}/detect/mock`],
      ["hash", sha256Hex("other")],
      ["network", "mainnet-beta"],
      ["nonce", "00".repeat(32)],
      ["payer", "Attacker111"],
    ]) {
      assert.equal(
        edVerify(null, challengeFor({ ...fields, [k]: v }), signer.publicKey, sig),
        false,
        `tampered ${k} must not verify`,
      );
    }

    // A different key cannot have produced this signature.
    const other = makeSigner();
    assert.equal(edVerify(null, challengeFor(fields), other.publicKey, sig), false);
  });

  test("two live calls never reuse a nonce or signature", async () => {
    seen.length = 0;
    const signer = makeSigner();
    const cfg = makeConfig(signer, { facilitatorUrl: base });
    const media = new TextEncoder().encode("replay");
    await detect(media, DetectionProvider.SYNTHID, cfg);
    await detect(media, DetectionProvider.SYNTHID, cfg);
    const [p1, p2] = seen.map((s) => JSON.parse(s.headers["x-payment"]));
    assert.notEqual(p1.nonce, p2.nonce);
    assert.notEqual(p1.signature, p2.signature);
    assert.equal(p1.network, "mainnet-beta", "network defaults to mainnet-beta");
  });

  test("endpointOverride is used for the detection call and is what gets signed", async () => {
    seen.length = 0;
    const signer = makeSigner();
    const override = `${base}/custom/route`;
    const media = new TextEncoder().encode("override");
    const cfg = makeConfig(signer, { facilitatorUrl: "http://127.0.0.1:1" });
    await detect(media, DetectionProvider.BITMIND, cfg, { endpointOverride: override });
    assert.equal(seen[0].url, `/custom/route?hash=${sha256Hex(media)}`);
    const pay = JSON.parse(seen[0].headers["x-payment"]);
    const ok = edVerify(
      null,
      challengeFor({
        amount: "5000",
        endpoint: override,
        hash: sha256Hex(media),
        network: "mainnet-beta",
        nonce: pay.nonce,
        payer: pay.payer,
      }),
      signer.publicKey,
      Buffer.from(pay.signature, "base64"),
    );
    assert.ok(ok);
  });

  test("a non-2xx detection response rejects with the HTTP status", async () => {
    behaviour.detectStatus = 402;
    try {
      await assert.rejects(
        detect(new TextEncoder().encode("unpaid"), DetectionProvider.HIVE, makeConfig(makeSigner(), { facilitatorUrl: base })),
        /HTTP 402: payment required/,
      );
    } finally {
      behaviour.detectStatus = 200;
    }
  });

  test("anchorReceipt posts the result hash and returns the facilitator tx signature", async () => {
    seen.length = 0;
    const media = new TextEncoder().encode("anchor-live");
    const cfg = makeConfig(makeSigner(), { facilitatorUrl: base, anchorReceipt: true, network: "devnet" });
    const r = await detect(media, DetectionProvider.HIVE, cfg);
    assert.equal(r.receiptHash, "5igTxSig");
    const anchorReq = seen.find((s) => s.url === "/receipts/anchor");
    assert.ok(anchorReq, "anchor endpoint was called");
    const body = JSON.parse(anchorReq.body);
    assert.equal(body.requestId, r.requestId);
    assert.equal(body.network, "devnet");
    assert.equal(body.payer, cfg.payerPublicKey);
    assert.equal(body.resultHash, sha256Hex(`${r.requestId}:${r.mediaHash}:1`));
  });

  test("a failed anchor is best-effort: result still returned without receiptHash", async () => {
    behaviour.anchorStatus = 500;
    try {
      const cfg = makeConfig(makeSigner(), { facilitatorUrl: base, anchorReceipt: true });
      const r = await detect(new TextEncoder().encode("anchor-fail"), DetectionProvider.HIVE, cfg);
      assert.equal(r.isAiGenerated, true);
      assert.equal(r.receiptHash, undefined);
    } finally {
      behaviour.anchorStatus = 200;
    }
  });
});

// ---------------------------------------------------------------------------
// buildNullLiveDetectionBadge
// ---------------------------------------------------------------------------

describe("buildNullLiveDetectionBadge", () => {
  const det = (over = {}) => ({
    requestId: "r",
    provider: "hive",
    mediaHash: "h",
    isAiGenerated: false,
    confidence: 90,
    detectionMethod: "hybrid",
    processingMs: 1,
    priceUsdc: 0.01,
    receiptHash: "detReceipt",
    ...over,
  });

  test("fresh hardware attestation (level >= 2) + authentic → hardware badge, NullLive anchor preferred", () => {
    for (const level of [2, 3]) {
      const b = buildNullLiveDetectionBadge(det(), { status: "verified", level, anchorTx: "liveTx" });
      assert.deepEqual(b, {
        verified: true,
        level: "hardware",
        badgeText: "Hardware-Verified Live Content",
        anchorTx: "liveTx",
      });
    }
  });

  test("hardware badge falls back to the detection receipt when NullLive has no anchorTx", () => {
    const b = buildNullLiveDetectionBadge(det(), { status: "verified", level: 2 });
    assert.equal(b.level, "hardware");
    assert.equal(b.anchorTx, "detReceipt");
  });

  test("AppSigned (level 1) never earns the hardware badge", () => {
    const b = buildNullLiveDetectionBadge(det(), { status: "verified", level: 1, anchorTx: "liveTx" });
    assert.equal(b.level, "ai-detector");
    assert.equal(b.verified, true);
    assert.equal(b.anchorTx, "detReceipt", "detector receipt preferred for ai-detector badge");
  });

  test("stale, dark and ended attestations degrade to the AI-detector layer", () => {
    for (const status of ["stale", "dark", "ended"]) {
      const b = buildNullLiveDetectionBadge(det({ confidence: 80 }), { status, level: 3 });
      assert.equal(b.level, "ai-detector", status);
      assert.equal(b.badgeText, "AI Detector: Authentic (80% confidence)");
    }
  });

  test("AI-generated content is never verified, even with fresh hardware attestation", () => {
    const b = buildNullLiveDetectionBadge(
      det({ isAiGenerated: true, confidence: 97 }),
      { status: "verified", level: 3, anchorTx: "liveTx" },
    );
    assert.deepEqual(b, {
      verified: false,
      level: "unverified",
      badgeText: "AI-Generated (97% confidence)",
      anchorTx: "detReceipt",
    });
  });

  test("confidence threshold for the AI-detector badge is exactly 70", () => {
    const at = buildNullLiveDetectionBadge(det({ confidence: 70 }), { status: "dark", level: 1 });
    const below = buildNullLiveDetectionBadge(det({ confidence: 69 }), { status: "dark", level: 1 });
    assert.equal(at.level, "ai-detector");
    assert.equal(at.verified, true);
    assert.equal(below.level, "unverified");
    assert.equal(below.verified, false);
    assert.equal(below.badgeText, "Unverified (69% confidence)");
  });

  test("unverified badge uses NullLive anchor only when there is no detection receipt", () => {
    const b = buildNullLiveDetectionBadge(
      det({ confidence: 10, receiptHash: undefined }),
      { status: "dark", level: 1, anchorTx: "liveTx" },
    );
    assert.equal(b.anchorTx, "liveTx");
  });

  test("end-to-end with MOCK detection: AI verdict blocks the hardware badge", async () => {
    const odd = mediaWhere(isOddFirstByte, "e2e");
    const r = await detect(odd, DetectionProvider.MOCK, makeConfig(makeSigner()));
    const b = buildNullLiveDetectionBadge(r, { status: "verified", level: 3 });
    assert.equal(b.verified, false);
    assert.equal(b.badgeText, "AI-Generated (87% confidence)");
  });
});
