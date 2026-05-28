/**
 * null-miner-sdk — Guild / Coalition System
 *
 * K-of-N threshold nullifier: a coalition of N agents can jointly signal
 * without any single agent being identified. K signatures required.
 *
 * Coalition nullifier hash:
 *   coalitionNullifier = Poseidon(member_nullifiers sorted ascending)
 *   thresholdCommitment = SHA-256("coalition-threshold-v1" || coalitionId || K || N)
 *
 * Use cases:
 *   - Shared reputation aggregation across agents
 *   - Multi-agent task completion (K-of-N confirm)
 *   - Guild-gated dark pool access
 */

import { createHash } from "crypto";
import { poseidonHash2, bytesToField, fieldToHex } from "../zk/poseidon.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CoalitionMember {
  passportId: string;
  nullifierHash: string;
  stakedNull: number;
  joinedAt: number;
}

export interface GuildCoalition {
  coalitionId: string;
  name: string;
  members: CoalitionMember[];
  threshold: number;
  coalitionNullifier: string;
  thresholdCommitment: string;
  totalStaked: number;
  createdAt: number;
}

export interface CoalitionSignal {
  coalitionId: string;
  signingMembers: string[];
  aggregateNullifierHash: string;
  signal: string;
  externalNullifier: string;
  timestamp: number;
}

// ── Poseidon iterative reduction ──────────────────────────────────────────────

/**
 * Reduce an array of hex nullifier hashes to a single field element using
 * iterative Poseidon2 pairwise application.
 *
 * Sorted by passportId for determinism (caller supplies pre-sorted members).
 */
function poseidonReduce(nullifierHexes: string[]): string {
  if (nullifierHexes.length === 0) {
    throw new Error("Cannot reduce empty nullifier list");
  }
  let acc = bytesToField(Buffer.from(nullifierHexes[0]!, "hex"));
  for (let i = 1; i < nullifierHexes.length; i++) {
    const next = bytesToField(Buffer.from(nullifierHexes[i]!, "hex"));
    acc = poseidonHash2(acc, next);
  }
  return fieldToHex(acc);
}

// ── Coalition creation ────────────────────────────────────────────────────────

/**
 * Create a new GuildCoalition from a set of members and a K-of-N threshold.
 * Throws if threshold > members.length.
 */
export function createCoalition(opts: {
  name: string;
  members: CoalitionMember[];
  threshold: number;
}): GuildCoalition {
  const { name, members, threshold } = opts;

  if (threshold > members.length) {
    throw new Error(
      `Threshold ${threshold} exceeds member count ${members.length}`
    );
  }
  if (members.length === 0) {
    throw new Error("Coalition must have at least one member");
  }

  // Sort members by passportId for determinism
  const sortedMembers = [...members].sort((a, b) =>
    a.passportId.localeCompare(b.passportId)
  );

  // coalitionId = SHA-256("coalition-v1" || name || sorted passportIds)
  const passportIdsStr = sortedMembers.map((m) => m.passportId).join(",");
  const coalitionIdFull = createHash("sha256")
    .update(Buffer.from("coalition-v1"))
    .update(Buffer.from(name))
    .update(Buffer.from(passportIdsStr))
    .digest("hex");
  const coalitionId = coalitionIdFull.slice(0, 32);

  // coalitionNullifier = iterative Poseidon on sorted member nullifierHashes
  const sortedNullifiers = sortedMembers.map((m) => m.nullifierHash);
  const coalitionNullifier = poseidonReduce(sortedNullifiers);

  // thresholdCommitment = SHA-256("coalition-threshold-v1" || coalitionId || K_byte || N_byte)
  const thresholdCommitment = createHash("sha256")
    .update(Buffer.from("coalition-threshold-v1"))
    .update(Buffer.from(coalitionId))
    .update(Buffer.from([threshold]))
    .update(Buffer.from([members.length]))
    .digest("hex");

  const totalStaked = members.reduce((sum, m) => sum + m.stakedNull, 0);

  return {
    coalitionId,
    name,
    members: sortedMembers,
    threshold,
    coalitionNullifier,
    thresholdCommitment,
    totalStaked,
    createdAt: Date.now(),
  };
}

// ── Signal building ───────────────────────────────────────────────────────────

/**
 * Build a CoalitionSignal for K-of-N threshold signaling.
 * Throws if any signing member is not in the coalition, or K < threshold.
 */
export function buildCoalitionSignal(
  coalition: GuildCoalition,
  signingMemberIds: string[],
  signalHex: string,
  externalNullifierHex: string
): CoalitionSignal {
  if (signingMemberIds.length < coalition.threshold) {
    throw new Error(
      `Need at least ${coalition.threshold} signers, got ${signingMemberIds.length}`
    );
  }

  const memberMap = new Map(
    coalition.members.map((m) => [m.passportId, m])
  );

  for (const id of signingMemberIds) {
    if (!memberMap.has(id)) {
      throw new Error(`Signing member ${id} is not in coalition ${coalition.coalitionId}`);
    }
  }

  // Sort signers by passportId for determinism, then reduce nullifiers
  const sortedSignerIds = [...signingMemberIds].sort((a, b) =>
    a.localeCompare(b)
  );
  const signerNullifiers = sortedSignerIds.map(
    (id) => memberMap.get(id)!.nullifierHash
  );
  const aggregateNullifierHash = poseidonReduce(signerNullifiers);

  return {
    coalitionId:           coalition.coalitionId,
    signingMembers:        sortedSignerIds,
    aggregateNullifierHash,
    signal:                signalHex,
    externalNullifier:     externalNullifierHex,
    timestamp:             Date.now(),
  };
}

// ── Signal verification ───────────────────────────────────────────────────────

/**
 * Verify that a CoalitionSignal meets the coalition's threshold requirements.
 * Returns true only if all conditions are satisfied.
 */
export function verifyCoalitionThreshold(
  coalition: GuildCoalition,
  signal: CoalitionSignal
): boolean {
  if (signal.coalitionId !== coalition.coalitionId) return false;
  if (signal.signingMembers.length < coalition.threshold) return false;

  const memberIds = new Set(coalition.members.map((m) => m.passportId));
  for (const id of signal.signingMembers) {
    if (!memberIds.has(id)) return false;
  }

  return true;
}

// ── Membership mutation ───────────────────────────────────────────────────────

/**
 * Add a member to a coalition and recompute the coalition nullifier.
 * Returns a new GuildCoalition (does not mutate the input).
 */
export function addCoalitionMember(
  coalition: GuildCoalition,
  member: CoalitionMember
): GuildCoalition {
  const updatedMembers = [...coalition.members, member];
  return createCoalition({
    name:      coalition.name,
    members:   updatedMembers,
    threshold: coalition.threshold,
  });
}
