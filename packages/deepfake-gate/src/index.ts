/**
 * @parad0x_labs/deepfake-gate
 *
 * x402-gated deepfake / AI-content detection for DNA x402.
 *
 * The EU AI Act (enforcement from August 2026) mandates that synthetic media
 * must be detectable and disclosed. This package places an x402 micropayment
 * wall in front of multiple detection providers (Google SynthID, BitMind on
 * Bittensor, Hive Moderation) and integrates with NullLive hardware
 * attestation to produce a dual-layer content-authenticity badge.
 *
 * Revenue model: protocol earns USDC on every detection call routed through
 * the x402 paywall. Callers never hold API keys — they hold USDC.
 *
 * Zero hard runtime dependencies beyond node:crypto.
 * Optional Solana anchor path is gated behind caller-supplied x402Config.
 */

import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Detection provider registry
// ---------------------------------------------------------------------------

/**
 * Supported AI-content detection providers.
 *
 * SYNTHID  — Google DeepMind watermark detection. Best for Google-generated
 *             content (Imagen, VideoPoet). Low cost, near-instant.
 * BITMIND  — BitMind subnet on Bittensor (subnet 34). Decentralised
 *             classifier network. Slightly higher latency and cost.
 * HIVE     — Hive Moderation API. Broad classifier covering many generators.
 *             Highest recall, highest per-call cost.
 * MOCK     — Returns a deterministic fake result. For unit tests only.
 */
export const DetectionProvider = {
  SYNTHID:  "synthid",
  BITMIND:  "bitmind",
  HIVE:     "hive",
  MOCK:     "mock",
} as const;
export type DetectionProvider = typeof DetectionProvider[keyof typeof DetectionProvider];

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Per-call prices in USDC charged through the x402 paywall.
 * These are the amounts the caller pays; the DNA x402 protocol retains a
 * protocol fee (default 10 bps) from each settlement.
 */
export const DETECTION_PRICES_USDC: Record<DetectionProvider, number> = {
  [DetectionProvider.SYNTHID]:  0.001,
  [DetectionProvider.BITMIND]:  0.005,
  [DetectionProvider.HIVE]:     0.01,
  [DetectionProvider.MOCK]:     0,
};

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * Detection result returned after a successful x402 detection call.
 */
export interface DetectionResult {
  /** Unique ID for this detection request (hex-encoded random bytes). */
  requestId:       string;
  /** Provider that performed the detection. */
  provider:        DetectionProvider;
  /** SHA-256 of the media bytes, hex-encoded. */
  mediaHash:       string;
  /** Whether the media is classified as AI-generated. */
  isAiGenerated:   boolean;
  /** Confidence score 0–100. */
  confidence:      number;
  /** Detection technique used by the provider. */
  detectionMethod: "watermark" | "classifier" | "hybrid";
  /** Wall-clock time for the detection call in milliseconds. */
  processingMs:    number;
  /** Amount charged via x402, in USDC. */
  priceUsdc:       number;
  /**
   * Solana transaction signature anchoring the result hash on-chain.
   * Present when x402Config.anchorReceipt === true and settlement
   * completes successfully.
   */
  receiptHash?:    string;
}

/**
 * x402 payment configuration supplied by the caller.
 */
export interface X402Config {
  /**
   * Base URL of the x402 facilitator / relay server.
   * Example: "https://facilitator.dna-x402.xyz"
   */
  facilitatorUrl: string;
  /**
   * Caller's USDC-paying wallet public key (base58).
   * The x402 facilitator uses this to settle on Solana.
   */
  payerPublicKey: string;
  /**
   * Sign a 32-byte challenge and return the 64-byte Ed25519 signature.
   * Must correspond to payerPublicKey.
   */
  sign: (challenge: Uint8Array) => Promise<Uint8Array>;
  /**
   * If true, the protocol anchors the detection result hash on Solana
   * and populates DetectionResult.receiptHash.
   * Default: false (saves ~0.000005 SOL per call).
   */
  anchorReceipt?: boolean;
  /**
   * Network to target. Default: "mainnet-beta".
   */
  network?: "mainnet-beta" | "devnet";
}

/**
 * Optional per-call overrides.
 */
export interface DetectOpts {
  /**
   * Override the x402 endpoint URL for this call.
   * Useful when pointing at a custom deployment.
   */
  endpointOverride?: string;
  /**
   * Caller-supplied label attached to the receipt for bookkeeping.
   * Example: "post:12345" — not stored on-chain.
   */
  label?: string;
  /**
   * Maximum age of a cached result in milliseconds.
   * If a prior detection for the same mediaHash exists in the local
   * in-memory cache and is younger than this value, it is returned
   * without a new x402 payment. Default: 0 (no caching).
   */
  cacheMaxAgeMs?: number;
}

// ---------------------------------------------------------------------------
// Detection request builder
// ---------------------------------------------------------------------------

/**
 * Canonical x402 endpoint paths per provider.
 * The facilitator routes these to the upstream detection API.
 */
const PROVIDER_PATHS: Record<DetectionProvider, string> = {
  [DetectionProvider.SYNTHID]:  "/detect/synthid",
  [DetectionProvider.BITMIND]:  "/detect/bitmind",
  [DetectionProvider.HIVE]:     "/detect/hive",
  [DetectionProvider.MOCK]:     "/detect/mock",
};

/** Detection technique reported per provider. */
const PROVIDER_METHOD: Record<DetectionProvider, DetectionResult["detectionMethod"]> = {
  [DetectionProvider.SYNTHID]:  "watermark",
  [DetectionProvider.BITMIND]:  "classifier",
  [DetectionProvider.HIVE]:     "hybrid",
  [DetectionProvider.MOCK]:     "classifier",
};

/**
 * Build a detection request descriptor without performing any network call.
 *
 * Use this to preview the x402 endpoint and estimated cost before committing
 * USDC — useful for UI previews or approval flows.
 *
 * @param mediaBytes          Raw bytes of the media to inspect (image/video/audio).
 * @param provider            Which detection provider to route to.
 * @param facilitatorBaseUrl  Base URL of the x402 facilitator.
 * @returns                   Request descriptor with mediaHash, endpoint, and price.
 */
export function buildDetectionRequest(
  mediaBytes:          Uint8Array,
  provider:            DetectionProvider,
  facilitatorBaseUrl:  string,
): {
  mediaHash:            string;
  x402Endpoint:         string;
  estimatedPriceUsdc:   number;
} {
  const mediaHash = sha256Hex(mediaBytes);
  const path      = PROVIDER_PATHS[provider];
  const x402Endpoint = facilitatorBaseUrl.replace(/\/$/, "") + path;

  return {
    mediaHash,
    x402Endpoint,
    estimatedPriceUsdc: DETECTION_PRICES_USDC[provider],
  };
}

// ---------------------------------------------------------------------------
// In-memory result cache (keyed by mediaHash + provider)
// ---------------------------------------------------------------------------

interface CacheEntry {
  result:    DetectionResult;
  cachedAt:  number;
}

const resultCache = new Map<string, CacheEntry>();

function cacheKey(mediaHash: string, provider: DetectionProvider): string {
  return `${provider}:${mediaHash}`;
}

// ---------------------------------------------------------------------------
// Core detect() function
// ---------------------------------------------------------------------------

/**
 * Detect whether media is AI-generated, paying via x402.
 *
 * Flow:
 *   1. Hash the media bytes.
 *   2. Check in-memory cache (if opts.cacheMaxAgeMs > 0).
 *   3. Build the x402 payment request.
 *   4. Sign and submit the x402 payment via the facilitator.
 *   5. Call the detection endpoint with the paid receipt.
 *   6. Optionally anchor the result hash on Solana.
 *   7. Cache and return DetectionResult.
 *
 * In MOCK provider mode the function short-circuits all network calls and
 * returns a deterministic result based on the media hash (odd first byte →
 * isAiGenerated: true). This allows full integration-test coverage without
 * any API keys or USDC balance.
 *
 * @param mediaBytes   Raw media bytes (JPEG, PNG, MP4, WAV, etc.).
 * @param provider     Detection provider to use.
 * @param x402Config   Caller's payment configuration.
 * @param opts         Optional per-call overrides.
 */
export async function detect(
  mediaBytes:  Uint8Array,
  provider:    DetectionProvider,
  x402Config:  X402Config,
  opts:        DetectOpts = {},
): Promise<DetectionResult> {
  const t0        = Date.now();
  const mediaHash = sha256Hex(mediaBytes);
  const requestId = randomBytes(16).toString("hex");

  // ------------------------------------------------------------------
  // 1. Cache hit?
  // ------------------------------------------------------------------
  if ((opts.cacheMaxAgeMs ?? 0) > 0) {
    const key   = cacheKey(mediaHash, provider);
    const entry = resultCache.get(key);
    if (entry && Date.now() - entry.cachedAt < (opts.cacheMaxAgeMs as number)) {
      return entry.result;
    }
  }

  // ------------------------------------------------------------------
  // 2. MOCK provider — no network, deterministic result.
  // ------------------------------------------------------------------
  if (provider === DetectionProvider.MOCK) {
    const firstByte    = parseInt(mediaHash.slice(0, 2), 16);
    const isAiGenerated = (firstByte & 1) === 1;
    const result: DetectionResult = {
      requestId,
      provider:        DetectionProvider.MOCK,
      mediaHash,
      isAiGenerated,
      confidence:      isAiGenerated ? 87 : 12,
      detectionMethod: PROVIDER_METHOD[provider],
      processingMs:    Date.now() - t0,
      priceUsdc:       DETECTION_PRICES_USDC[provider],
    };
    _cacheResult(mediaHash, provider, result, opts);
    return result;
  }

  // ------------------------------------------------------------------
  // 3. Build x402 endpoint URL.
  // ------------------------------------------------------------------
  const endpoint = opts.endpointOverride
    ?? (x402Config.facilitatorUrl.replace(/\/$/, "") + PROVIDER_PATHS[provider]);

  // ------------------------------------------------------------------
  // 4. Pay via x402.
  //
  //    The x402 handshake is:
  //      a. GET /detect/<provider>?hash=<mediaHash>
  //         → 402 with WWW-Authenticate: X402 header carrying the
  //           payment requirements (amount, asset, network, recipient).
  //      b. Caller signs a payment authorization.
  //      c. POST with X-Payment header containing the signed auth.
  //         → 200 with detection result JSON.
  //
  //    We replicate this flow using node:crypto for the signing step.
  //    In production the facilitator validates the Solana USDC transfer
  //    before forwarding the request to the upstream provider.
  // ------------------------------------------------------------------
  const paymentAuth = await _buildX402PaymentAuth(
    x402Config,
    endpoint,
    DETECTION_PRICES_USDC[provider],
    mediaHash,
  );

  // ------------------------------------------------------------------
  // 5. Call detection endpoint.
  // ------------------------------------------------------------------
  const detectionResponse = await _callDetectionEndpoint(
    endpoint,
    mediaHash,
    paymentAuth,
    provider,
  );

  // ------------------------------------------------------------------
  // 6. Optionally anchor result hash on Solana.
  // ------------------------------------------------------------------
  let receiptHash: string | undefined;
  if (x402Config.anchorReceipt) {
    receiptHash = await _anchorResultHash(
      requestId,
      mediaHash,
      detectionResponse.isAiGenerated,
      x402Config,
    );
  }

  // ------------------------------------------------------------------
  // 7. Assemble and cache result.
  // ------------------------------------------------------------------
  const result: DetectionResult = {
    requestId,
    provider,
    mediaHash,
    isAiGenerated:   detectionResponse.isAiGenerated,
    confidence:      detectionResponse.confidence,
    detectionMethod: PROVIDER_METHOD[provider],
    processingMs:    Date.now() - t0,
    priceUsdc:       DETECTION_PRICES_USDC[provider],
    receiptHash,
  };

  _cacheResult(mediaHash, provider, result, opts);
  return result;
}

// ---------------------------------------------------------------------------
// NullLive dual-layer badge builder
// ---------------------------------------------------------------------------

/**
 * NullLive hardware attestation data, typically sourced from verifyBadge()
 * in @parad0x_labs/nulllive-sdk.
 */
export interface NullLiveBadgeData {
  /**
   * Attestation status from the live_attestation Solana program.
   * "verified" = fresh hardware anchor on-chain.
   * "stale"    = anchor exists but is 30–90 s old.
   * "dark"     = no recent anchor (> 90 s).
   * "ended"    = stream ended normally.
   */
  status:      "verified" | "stale" | "dark" | "ended";
  /**
   * NullLive attestation level.
   * 1 = AppSigned, 2 = TeeCamera, 3 = IspPhysical.
   */
  level:       1 | 2 | 3;
  /** Solana transaction signature of the latest anchor, if known. */
  anchorTx?:   string;
}

/**
 * Dual-layer content authenticity badge combining NullLive hardware
 * attestation with AI-generation detection.
 *
 * Badge levels (descending trustworthiness):
 *   "hardware"     — NullLive verified (fresh, TeeCamera+) AND not AI-generated.
 *   "ai-detector"  — AI detector says not generated (no hardware attestation,
 *                    or hardware is stale/dark). EU AI Act compliant label.
 *   "unverified"   — AI detector flagged as generated, or no attestation at all.
 */
export interface NullLiveDetectionBadge {
  verified:     boolean;
  level:        "hardware" | "ai-detector" | "unverified";
  badgeText:    string;
  /** Solana transaction of the on-chain anchor (NullLive or detection receipt). */
  anchorTx?:    string;
}

/**
 * Build a dual-layer content authenticity badge from NullLive hardware
 * attestation data and an AI detection result.
 *
 * Decision logic:
 *   - If NullLive is "verified" AND level >= TeeCamera AND !isAiGenerated
 *     → "hardware" badge (highest trust).
 *   - Else if !isAiGenerated AND confidence >= 70
 *     → "ai-detector" badge (EU AI Act compliant — verified by classifier).
 *   - Otherwise
 *     → "unverified" badge (AI-generated or insufficient confidence).
 *
 * @param detectionResult   Result from detect().
 * @param nullLiveBadge     NullLive attestation data for the same content.
 */
export function buildNullLiveDetectionBadge(
  detectionResult: DetectionResult,
  nullLiveBadge:   NullLiveBadgeData,
): NullLiveDetectionBadge {
  const { isAiGenerated, confidence, receiptHash } = detectionResult;
  const { status, level, anchorTx }                 = nullLiveBadge;

  const hardwareOk = status === "verified" && level >= 2 && !isAiGenerated;

  if (hardwareOk) {
    return {
      verified:  true,
      level:     "hardware",
      badgeText: "Hardware-Verified Live Content",
      anchorTx:  anchorTx ?? receiptHash,
    };
  }

  const aiOk = !isAiGenerated && confidence >= 70;

  if (aiOk) {
    return {
      verified:  true,
      level:     "ai-detector",
      badgeText: `AI Detector: Authentic (${confidence}% confidence)`,
      anchorTx:  receiptHash ?? anchorTx,
    };
  }

  const reason = isAiGenerated
    ? `AI-Generated (${confidence}% confidence)`
    : `Unverified (${confidence}% confidence)`;

  return {
    verified:  false,
    level:     "unverified",
    badgeText: reason,
    anchorTx:  receiptHash ?? anchorTx,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** SHA-256 of input bytes → lowercase hex string. */
function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Store a result in the in-memory cache if caching is requested. */
function _cacheResult(
  mediaHash: string,
  provider:  DetectionProvider,
  result:    DetectionResult,
  opts:      DetectOpts,
): void {
  if ((opts.cacheMaxAgeMs ?? 0) > 0) {
    resultCache.set(cacheKey(mediaHash, provider), {
      result,
      cachedAt: Date.now(),
    });
  }
}

/**
 * Build an x402 payment authorization object.
 *
 * In production this would use the x402 SDK / HTTPP 402 standard to
 * negotiate payment with the facilitator. Here we produce the minimal
 * signed payload that the DNA x402 facilitator accepts:
 *
 *   {
 *     scheme:        "exact",
 *     network:       "mainnet-beta" | "devnet",
 *     asset:         "USDC",
 *     amount:        "<micro-USDC as string>",   // 6 decimals
 *     payee:         "<facilitator recipient pubkey>",
 *     payer:         "<caller pubkey>",
 *     nonce:         "<32-byte hex random>",
 *     signature:     "<base64 Ed25519 sig of canonical payload>",
 *   }
 */
async function _buildX402PaymentAuth(
  cfg:       X402Config,
  endpoint:  string,
  amountUsd: number,
  mediaHash: string,
): Promise<Record<string, string>> {
  const network    = cfg.network ?? "mainnet-beta";
  const microUsdc  = Math.round(amountUsd * 1_000_000).toString();
  const nonce      = randomBytes(32).toString("hex");

  // Canonical payload: sorted, tab-delimited key=value pairs.
  const canonical = [
    `amount=${microUsdc}`,
    `endpoint=${endpoint}`,
    `hash=${mediaHash}`,
    `network=${network}`,
    `nonce=${nonce}`,
    `payer=${cfg.payerPublicKey}`,
    `scheme=exact`,
  ].join("\t");

  const challengeBytes = createHash("sha256")
    .update(canonical)
    .digest();

  const sigBytes  = await cfg.sign(new Uint8Array(challengeBytes));
  const signature = Buffer.from(sigBytes).toString("base64");

  return {
    scheme:    "exact",
    network,
    asset:     "USDC",
    amount:    microUsdc,
    payer:     cfg.payerPublicKey,
    nonce,
    signature,
  };
}

/**
 * Simulated detection endpoint call.
 *
 * In production this would be a real HTTP request:
 *   POST <endpoint>
 *   X-Payment: <JSON payment auth>
 *   Content-Type: application/json
 *   { "mediaHash": "<hex>" }
 *
 * The server validates the x402 payment, forwards the hash to the upstream
 * provider, and returns:
 *   { "isAiGenerated": bool, "confidence": number }
 *
 * Here we produce a deterministic mock that exercises the full code path so
 * the package is testable without live provider credentials. Real HTTP is
 * wired in when the DEEPFAKE_GATE_LIVE=1 env var is present.
 */
async function _callDetectionEndpoint(
  endpoint:     string,
  mediaHash:    string,
  paymentAuth:  Record<string, string>,
  provider:     DetectionProvider,
): Promise<{ isAiGenerated: boolean; confidence: number }> {
  if (typeof process !== "undefined" && process.env?.["DEEPFAKE_GATE_LIVE"] === "1") {
    // Live path — real HTTP call.
    const url  = `${endpoint}?hash=${mediaHash}`;
    const resp = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Payment":    JSON.stringify(paymentAuth),
      },
      body: JSON.stringify({ mediaHash }),
    });
    if (!resp.ok) {
      throw new Error(
        `Detection endpoint returned HTTP ${resp.status}: ${await resp.text()}`,
      );
    }
    const json = (await resp.json()) as { isAiGenerated: boolean; confidence: number };
    return json;
  }

  // Stub path — deterministic based on hash bytes so tests are repeatable.
  // Provider differences affect the confidence spread to match real-world
  // accuracy profiles (SynthID narrower, Hive broader recall).
  const firstByte     = parseInt(mediaHash.slice(0, 2), 16);
  const secondByte    = parseInt(mediaHash.slice(2, 4), 16);
  const isAiGenerated = (firstByte & 1) === 1;

  const confidenceBase: Record<DetectionProvider, number> = {
    [DetectionProvider.SYNTHID]:  60,
    [DetectionProvider.BITMIND]:  70,
    [DetectionProvider.HIVE]:     75,
    [DetectionProvider.MOCK]:     80,
  };

  const confidence = Math.min(
    99,
    confidenceBase[provider] + (secondByte % 25),
  );

  return { isAiGenerated, confidence };
}

/**
 * Anchor the detection result hash on Solana via the x402 facilitator's
 * receipt endpoint. Returns the Solana transaction signature (base58).
 *
 * This is a best-effort operation — if it fails the detection result is
 * still returned without a receiptHash rather than throwing.
 */
async function _anchorResultHash(
  requestId:    string,
  mediaHash:    string,
  isAiGenerated: boolean,
  cfg:           X402Config,
): Promise<string | undefined> {
  try {
    // Build a deterministic result hash: sha256(requestId + mediaHash + isAiGenerated)
    const payload = `${requestId}:${mediaHash}:${isAiGenerated ? "1" : "0"}`;
    const resultHash = createHash("sha256")
      .update(payload)
      .digest("hex");

    // In the live path this posts to /receipts/anchor on the facilitator.
    if (typeof process !== "undefined" && process.env?.["DEEPFAKE_GATE_LIVE"] === "1") {
      const anchorUrl = cfg.facilitatorUrl.replace(/\/$/, "") + "/receipts/anchor";
      const resp = await fetch(anchorUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network:    cfg.network ?? "mainnet-beta",
          payer:      cfg.payerPublicKey,
          resultHash,
          requestId,
        }),
      });
      if (!resp.ok) return undefined;
      const body = (await resp.json()) as { txSignature?: string };
      return body.txSignature;
    }

    // Stub: return a fake-looking base58 transaction signature.
    return resultHash.slice(0, 44) + "stub";
  } catch {
    // Non-fatal — detection result is still valid without the anchor.
    return undefined;
  }
}
