/**
 * null-miner-sdk — Spectre Passport v2
 *
 * Tiered agent identity with ZK reputation proofs and NULL staking.
 *
 * Tier system:
 *   Tier 0 — Device-only (random identity, no binding)
 *   Tier 1 — Passkey-vault (P-256/WebAuthn, device biometric)
 *   Tier 2 — MetaMask-auth (ETH wallet binding, Sybil resistance)
 *   Tier 3 — ZK-reputation (nullifier count proof, ≥10 tasks)
 *   Tier 4 — Guild-member (coalition participation, NULL stake)
 *
 * Reputation is based on nullifier count in the dark_semaphore tree.
 * Higher tier = access to higher-value tasks + dark pool priority.
 */

import { createHash } from "crypto";

// ── Tier enum ─────────────────────────────────────────────────────────────────

export enum PassportTier {
  Device      = 0,
  Passkey     = 1,
  MetaMask    = 2,
  ZKReputation = 3,
  Guild       = 4,
}

// ── Configuration & Attestation types ─────────────────────────────────────────

export interface PassportV2Config {
  spendKey: Uint8Array;
  tier: PassportTier;
  nullifierCount?: number;
  stakedNull?: number;
  guildId?: string;
  ethAddress?: string;
  platformId: string;
}

export interface PassportV2Attestation {
  passportId: string;
  tier: PassportTier;
  tierName: string;
  reputationScore: number;
  nullifierCount: number;
  stakedNull: number;
  guildId?: string;
  ethAddress?: string;
  reputationProofHash: string;
  eligibleTaskKinds: string[];
  priorityMultiplier: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TIER_NAMES: Record<PassportTier, string> = {
  [PassportTier.Device]:       "Device",
  [PassportTier.Passkey]:      "Passkey",
  [PassportTier.MetaMask]:     "MetaMask",
  [PassportTier.ZKReputation]: "ZKReputation",
  [PassportTier.Guild]:        "Guild",
};

const TIER_PRIORITY: Record<PassportTier, number> = {
  [PassportTier.Device]:       1.0,
  [PassportTier.Passkey]:      1.2,
  [PassportTier.MetaMask]:     1.5,
  [PassportTier.ZKReputation]: 2.0,
  [PassportTier.Guild]:        3.0,
};

const TIER_BONUS: Record<PassportTier, number> = {
  [PassportTier.Device]:       0,
  [PassportTier.Passkey]:      50,
  [PassportTier.MetaMask]:     100,
  [PassportTier.ZKReputation]: 150,
  [PassportTier.Guild]:        200,
};

const TIER_MIN_NULLIFIERS: Record<PassportTier, number> = {
  [PassportTier.Device]:       0,
  [PassportTier.Passkey]:      0,
  [PassportTier.MetaMask]:     0,
  [PassportTier.ZKReputation]: 10,
  [PassportTier.Guild]:        25,
};

const TIER_TASK_KINDS: Record<PassportTier, string[]> = {
  [PassportTier.Device]:  ["residential_relay", "app_store_snapshot"],
  [PassportTier.Passkey]: ["residential_relay", "app_store_snapshot", "location_attestation"],
  [PassportTier.MetaMask]: [
    "residential_relay",
    "app_store_snapshot",
    "location_attestation",
    "sensor_sample",
  ],
  [PassportTier.ZKReputation]: [
    "residential_relay",
    "app_store_snapshot",
    "location_attestation",
    "sensor_sample",
    "protocol_maintenance",
  ],
  [PassportTier.Guild]: [
    "residential_relay",
    "app_store_snapshot",
    "location_attestation",
    "sensor_sample",
    "protocol_maintenance",
    "dark_pool_priority",
    "enterprise_task",
  ],
};

// ── AgentPassportV2 ───────────────────────────────────────────────────────────

export class AgentPassportV2 {
  private readonly config: PassportV2Config;

  constructor(config: PassportV2Config) {
    if (!config.spendKey || config.spendKey.length !== 32) {
      throw new Error("spendKey must be exactly 32 bytes");
    }
    this.config = { ...config };
  }

  /** Stable anonymous ID: SHA-256("spectre-passport-v2" || hex(spendKey)) */
  get passportId(): string {
    return computePassportId(this.config.spendKey);
  }

  get tier(): PassportTier {
    return this.config.tier;
  }

  /** Attestation snapshot of the current passport state. */
  attest(): PassportV2Attestation {
    const tier = this.config.tier;
    return {
      passportId:          this.passportId,
      tier,
      tierName:            TIER_NAMES[tier],
      reputationScore:     this.computeReputationScore(),
      nullifierCount:      this.config.nullifierCount ?? 0,
      stakedNull:          this.config.stakedNull ?? 0,
      guildId:             this.config.guildId,
      ethAddress:          this.config.ethAddress,
      reputationProofHash: this.buildReputationProofHash(),
      eligibleTaskKinds:   [...TIER_TASK_KINDS[tier]],
      priorityMultiplier:  TIER_PRIORITY[tier],
    };
  }

  /**
   * Check if this passport can access a task of the given kind.
   * Optionally enforce a minimum tier level.
   */
  canAccessTask(kind: string, minTier?: PassportTier): boolean {
    const tier = this.config.tier;
    if (minTier !== undefined && tier < minTier) return false;
    return TIER_TASK_KINDS[tier].includes(kind);
  }

  /**
   * Reputation score (0–1000):
   *   Base: min(nullifierCount * 10, 500)
   *   Tier bonus: 0 / 50 / 100 / 150 / 200
   *   NULL staking bonus: min(stakedNull / 100, 150)
   */
  computeReputationScore(): number {
    const nullCount  = this.config.nullifierCount ?? 0;
    const staked     = this.config.stakedNull     ?? 0;
    const tier       = this.config.tier;

    const base          = Math.min(nullCount * 10, 500);
    const tierBonus     = TIER_BONUS[tier];
    const stakingBonus  = Math.min(staked / 100, 150);

    return Math.min(Math.floor(base + tierBonus + stakingBonus), 1000);
  }

  /** Minimum nullifier count (completed tasks) required to reach a given tier. */
  requiresNullifierCount(tier: PassportTier): number {
    return TIER_MIN_NULLIFIERS[tier];
  }

  /** SHA-256("reputation-proof-v2" || passportId || nullifierCount || tier) as 64-char hex. */
  buildReputationProofHash(): string {
    const nullCount = this.config.nullifierCount ?? 0;
    const tier      = this.config.tier;
    const pid       = this.passportId;

    const h = createHash("sha256")
      .update(Buffer.from("reputation-proof-v2"))
      .update(Buffer.from(pid, "hex"))
      .update(Buffer.from(String(nullCount)))
      .update(Buffer.from(String(tier)))
      .digest("hex");
    return h;
  }
}

// ── Standalone helpers ────────────────────────────────────────────────────────

/**
 * Compute the passport ID for a given spend key.
 * SHA-256("spectre-passport-v2" || hex(spendKey)) as 64-char hex.
 */
export function computePassportId(spendKey: Uint8Array): string {
  const spendKeyHex = Buffer.from(spendKey).toString("hex");
  return createHash("sha256")
    .update(Buffer.from("spectre-passport-v2"))
    .update(Buffer.from(spendKeyHex))
    .digest("hex");
}

/**
 * Upgrade (or downgrade) a passport to a new tier.
 * Returns a new AgentPassportV2 with the same spend key but the given tier.
 */
export function upgradePassportTier(
  passport: AgentPassportV2,
  newTier: PassportTier
): AgentPassportV2 {
  // Re-read observable state via attest()
  const attestation = passport.attest();
  return new AgentPassportV2({
    // We need the raw spend key — access it via the passportId derivation path.
    // Since passportId is derived from spendKey, we pass a reconstructed config.
    // The spend key is not externally accessible; callers must provide the original config.
    // We expose it through the internal config copy held on the instance.
    // To avoid reflecting private internals, we use a symbol accessor below.
    spendKey:       (passport as AgentPassportV2)["config"].spendKey,
    tier:           newTier,
    nullifierCount: attestation.nullifierCount,
    stakedNull:     attestation.stakedNull,
    guildId:        attestation.guildId,
    ethAddress:     attestation.ethAddress,
    platformId:     (passport as AgentPassportV2)["config"].platformId,
  });
}
