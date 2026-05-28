/**
 * NULL Miner SDK — Agent Passport
 *
 * Thin TypeScript wrapper around the dark-agent-passport Rust logic.
 * Manages ZK identity for the mining agent — no wallet address ever exposed.
 *
 * The passport ID is derived from the spend key commitment — stable across
 * sessions, anonymous, cannot be Sybil-attacked without the underlying receipts.
 *
 * ZK upgrade (v0.1.0):
 *   - semaphoreIdentity()          — BN254 Poseidon-based group membership
 *   - poseidonIdentityCommitment() — BN254 field commitment string
 *   - stealthKeys()                — X25519 + Ed25519 DKSAP key pair
 */

import { createHash } from "crypto";
import type { PassportConfig, PassportAttestation, ReputationTier } from "./types.js";
import { ReputationTier as Tier } from "./types.js";
import { deriveIdentityFromKey }       from "../zk/semaphore.js";
import type { SemaphoreIdentity }      from "../zk/semaphore.js";
import { fieldToHex }                  from "../zk/poseidon.js";
import { bytesToField }                from "../zk/poseidon.js";
import { deriveStealthKeyPair }        from "../privacy/stealth.js";
import type { StealthKeyPair }         from "../privacy/stealth.js";

// ── Constants (mirrors dark-agent-passport Rust constants) ────────────────────

const DOMAIN_PASSPORT_ID    = "dark-passport-id-v1";
const DOMAIN_REP_ROOT       = "dark-passport-rep-root-v1";
const DOMAIN_ATTESTATION    = "dark-passport-attest-v1";
const DOMAIN_NULLIFIER_SEED = "null-miner-nullifier-v1";
const DOMAIN_REPLAY_KEY     = "null-miner-replay-v1";
const DOMAIN_RECEIPT_CMT    = "null-miner-receipt-commitment-v1";
const DOMAIN_SCOPED_PASSPORT = "null-miner-scoped-passport-v1";

const MAX_SCORE = 1000;
const SCORE_BASE_CAP      = 500;
const SCORE_DIVERSITY_CAP = 200;
const SCORE_LONGEVITY_CAP = 200;
const SCORE_VOLUME_BONUS  = 100;
const VOLUME_THRESHOLD_LAMPORTS = 10_000_000n; // 10M lamports ≈ $1.60 at $160/SOL

// ── Passport class ────────────────────────────────────────────────────────────

export class AgentPassport {
  private readonly spendKey: Buffer;
  public readonly passportId: string;

  private receiptCount: number   = 0;
  private programCount: number   = 0;
  private totalLamports: bigint  = 0n;
  private epochSpan: number      = 0;
  private createdEpoch: number;

  constructor(config: PassportConfig) {
    if (!config.spendKey || config.spendKey.length !== 64) {
      throw new Error("spendKey must be a 32-byte hex string (64 chars)");
    }
    this.spendKey     = Buffer.from(config.spendKey, "hex");
    this.createdEpoch = config.epoch ?? 0;
    this.passportId   = this.derivePassportId();
  }

  // ── Identity ───────────────────────────────────────────────────────────────

  private derivePassportId(): string {
    // H(DOMAIN_PASSPORT_ID || spend_key_commitment)
    const commitment = sha256(Buffer.concat([
      Buffer.from(DOMAIN_PASSPORT_ID),
      this.spendKey,
    ]));
    return commitment.toString("hex");
  }

  // ── Nullifier / Replay Protection ─────────────────────────────────────────

  /**
   * Derive a nullifier seed for a task.
   * Used by the dark-nullifier-banks to prevent double-claim.
   * H(DOMAIN_NULLIFIER || spend_key || task_id_bytes)
   *
   * The seed is deterministic per (spend_key, task_id) and never reused for
   * different tasks. The nullifier banks on-chain derive the actual shard nullifier
   * from this seed — this SDK never submits the seed directly.
   */
  nullifierSeed(taskId: string): string {
    const h = sha256(Buffer.concat([
      Buffer.from(DOMAIN_NULLIFIER_SEED),
      this.spendKey,
      Buffer.from(taskId, "hex"),
    ]));
    return h.toString("hex");
  }

  /**
   * Derive a one-time replay key for claiming a task.
   * H(DOMAIN_REPLAY || spend_key || task_id_bytes)
   *
   * Two agents with the same spend key produce the same replay key for the
   * same task — the escrow/nullifier program rejects the second submission.
   * This makes Sybil attacks on a single identity impossible.
   */
  replayKey(taskId: string): string {
    const h = sha256(Buffer.concat([
      Buffer.from(DOMAIN_REPLAY_KEY),
      this.spendKey,
      Buffer.from(taskId, "hex"),
    ]));
    return h.toString("hex");
  }

  /**
   * Produce a task receipt commitment.
   * H(DOMAIN_RECEIPT || passport_id || task_id || proof_hash)
   *
   * This is the value committed on-chain by the dark-compressed-receipts program.
   * It proves: (a) this passport completed this task, (b) with this proof,
   * without revealing the spend key.
   */
  taskReceiptCommitment(taskId: string, proofHash: string): string {
    const h = sha256(Buffer.concat([
      Buffer.from(DOMAIN_RECEIPT_CMT),
      Buffer.from(this.passportId, "hex"),
      Buffer.from(taskId, "hex"),
      Buffer.from(proofHash, "hex"),
    ]));
    return h.toString("hex");
  }

  /**
   * Derive a platform-scoped passport ID.
   * H(DOMAIN_SCOPED || spend_key || platform_id_bytes)
   *
   * Different platforms get different opaque agent identities from the same
   * spend key — cross-platform correlation is not possible.
   */
  scopedPassportId(platformId: string): string {
    const h = sha256(Buffer.concat([
      Buffer.from(DOMAIN_SCOPED_PASSPORT),
      this.spendKey,
      Buffer.from(platformId),
    ]));
    return h.toString("hex");
  }

  /** Derive a one-time stealth address for a specific task payment. */
  deriveStealthAddress(taskId: string): string {
    const h = sha256(Buffer.concat([
      Buffer.from("dark-stealth-v1"),
      this.spendKey,
      Buffer.from(taskId, "hex"),
    ]));
    return h.toString("hex");
  }

  // ── ZK Identity (BN254 Poseidon + Semaphore) ────────────────────────────────

  /**
   * Derive the Semaphore ZK identity for this passport.
   *
   * identityCommitment = Poseidon2([nullifier_field, trapdoor_field])
   *
   * The identityCommitment is the Merkle leaf submitted to programs/dark_semaphore
   * (AddMember instruction). The nullifier and trapdoor are deterministic from
   * the spend key and are never exposed.
   *
   * @example
   * const id = passport.semaphoreIdentity();
   * // id.identityCommitment → submit to dark_semaphore AddMember
   * // id.nullifier          → derive nullifier hashes (context-specific)
   */
  semaphoreIdentity(): SemaphoreIdentity {
    return deriveIdentityFromKey(this.spendKey);
  }

  /**
   * BN254 Poseidon identity commitment as a 64-char hex string.
   * Poseidon2([nullifier_field, trapdoor_field]) — BN254 scalar field element.
   * Cheaper to verify in ZK circuits than SHA-256 (~240 vs ~28K constraints).
   */
  poseidonIdentityCommitment(): string {
    const id = this.semaphoreIdentity();
    return fieldToHex(bytesToField(id.identityCommitment));
  }

  // ── Stealth Keys (DKSAP: X25519 + Ed25519) ─────────────────────────────────

  /**
   * Derive the DKSAP stealth key pair for this passport.
   *
   * scanPriv/scanPub:   X25519 — for ECDH scanning (safe to delegate)
   * spendPriv/spendPub: Ed25519 — for spending (keep secret)
   *
   * Both keys are deterministic from the spend key via HKDF.
   *
   * @example
   * const keys = passport.stealthKeys();
   * // Publish: keys.scanPub + keys.spendPub (recipient's stealth meta-address)
   * // Use:     generateStealthAddress(keys.scanPub, keys.spendPub) (sender side)
   * //          checkStealthAddress(keys, ephemeralPub, stealthPub) (recipient scan)
   * //          recoverStealthSpendKey(keys, ephemeralPub) (recipient spend)
   */
  stealthKeys(): StealthKeyPair {
    return deriveStealthKeyPair(this.spendKey);
  }

  // ── Reputation ─────────────────────────────────────────────────────────────

  /** Record a completed task receipt to build reputation. */
  recordReceipt(opts: {
    receiptHash: string;
    programId: string;
    amountLamports: bigint;
    epoch: number;
  }): void {
    this.receiptCount++;
    this.totalLamports += opts.amountLamports;
    this.epochSpan = Math.max(this.epochSpan, opts.epoch - this.createdEpoch);
    // Track unique programs (simplified — full impl uses a set)
    this.programCount = Math.min(this.programCount + 1, 5);
  }

  get reputationScore(): number {
    const base      = Math.min(SCORE_BASE_CAP,      this.receiptCount * 5);
    const diversity = Math.min(SCORE_DIVERSITY_CAP, this.programCount * 40);
    const longevity = Math.min(SCORE_LONGEVITY_CAP, Math.floor(this.epochSpan / 10));
    const volume    = this.totalLamports >= VOLUME_THRESHOLD_LAMPORTS ? SCORE_VOLUME_BONUS : 0;
    return Math.min(MAX_SCORE, base + diversity + longevity + volume);
  }

  get tier(): ReputationTier {
    const score = this.reputationScore;
    if (score >= 800) return Tier.Elite;
    if (score >= 500) return Tier.Gold;
    if (score >= 200) return Tier.Silver;
    return Tier.Bronze;
  }

  // ── Attestation ────────────────────────────────────────────────────────────

  /**
   * Generate a ZK attestation proving reputation without revealing payment history.
   * Phase 1: SHA-256 stub.
   * Phase 2: Groth16 (planned).
   */
  attest(claimedScore: number): PassportAttestation {
    if (claimedScore > this.reputationScore) {
      throw new Error(`Cannot attest score ${claimedScore} > actual ${this.reputationScore}`);
    }

    const repRoot = sha256(Buffer.concat([
      Buffer.from(DOMAIN_REP_ROOT),
      Buffer.from(this.passportId, "hex"),
      u64le(BigInt(this.receiptCount)),
      u64le(BigInt(this.programCount)),
      u64le(this.totalLamports),
    ]));

    const proofBlob = sha256(Buffer.concat([
      Buffer.from(DOMAIN_ATTESTATION),
      Buffer.from(this.passportId, "hex"),
      repRoot,
      u64le(BigInt(claimedScore)),
    ]));

    return {
      passportId: this.passportId,
      reputationScore: this.reputationScore,
      tier: this.tier,
      proofBlob: proofBlob.toString("hex"),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

function u64le(n: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n);
  return buf;
}
