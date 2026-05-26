/**
 * Layer: MPC ceremony data contract
 *
 * TypeScript mirror of the `dark-mpc-ceremony` Rust crate format.
 * Tests party share commitments, ceremony JSON serialisation rules,
 * threshold finalization logic, and determinism of the final key hash.
 *
 * No source imports needed. All ceremony functions are implemented inline
 * using node:crypto SHA-256.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inline implementation — mirrors dark-mpc-ceremony Rust crate
// ---------------------------------------------------------------------------

/**
 * Computes a 32-byte party share commitment.
 * Domain-separated with "mpc-share-v1" so distinct ceremony versions
 * cannot collide.
 */
function partyShareCommitment(partyId: number, epoch: bigint, entropy: Buffer): Buffer {
  const epochBuf = Buffer.alloc(8);
  epochBuf.writeBigUInt64LE(epoch, 0);

  return createHash("sha256")
    .update("mpc-share-v1")
    .update(Buffer.from([partyId & 0xff]))
    .update(epochBuf)
    .update(entropy)
    .digest();
}

interface Contribution {
  partyId: number;
  commitment: Buffer; // 32-byte commitment from partyShareCommitment
}

interface CeremonyState {
  threshold: number;
  nParties: number;
  epoch: bigint;
  contributions: Contribution[];
}

function newCeremony(threshold: number, nParties: number, epoch: bigint): CeremonyState {
  return { threshold, nParties, epoch, contributions: [] };
}

function addContribution(state: CeremonyState, partyId: number, entropy: Buffer): CeremonyState {
  const commitment = partyShareCommitment(partyId, state.epoch, entropy);
  return {
    ...state,
    contributions: [...state.contributions, { partyId, commitment }],
  };
}

function canFinalize(state: CeremonyState): boolean {
  return state.contributions.length >= state.threshold;
}

/**
 * Deterministic final key hash: domain-separated XOR-reduce of sorted
 * commitments, then SHA-256. Sorting by partyId ensures order independence.
 */
function finalKeyHash(state: CeremonyState): string {
  if (!canFinalize(state)) {
    throw new Error("Not enough contributions to finalize");
  }
  const sorted = [...state.contributions].sort((a, b) => a.partyId - b.partyId);
  const xored = Buffer.alloc(32, 0);
  for (const c of sorted) {
    for (let i = 0; i < 32; i++) {
      xored[i] ^= c.commitment[i];
    }
  }
  return createHash("sha256").update("mpc-final-v1").update(xored).digest("hex");
}

/**
 * Serialised ceremony JSON — must NOT expose raw entropy bytes.
 */
function ceremonyToJson(state: CeremonyState): object {
  return {
    threshold: state.threshold,
    n_parties: state.nParties,
    epoch: state.epoch.toString(),
    contribution_count: state.contributions.length,
    // Only commitments (hashes), never raw entropy
    contributions: state.contributions.map((c) => ({
      party_id: c.partyId,
      commitment_hex: c.commitment.toString("hex"),
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dark-null MPC ceremony data contract", () => {
  const TEST_ENTROPY = Buffer.from("test-entropy-secret-do-not-log", "utf8");

  it("party share commitment is 32 bytes (SHA256-based)", () => {
    const commitment = partyShareCommitment(1, 1n, TEST_ENTROPY);
    expect(commitment).toBeInstanceOf(Buffer);
    expect(commitment.length).toBe(32);
  });

  it("different party IDs produce different commitments (same entropy)", () => {
    const c1 = partyShareCommitment(1, 1n, TEST_ENTROPY);
    const c2 = partyShareCommitment(2, 1n, TEST_ENTROPY);
    expect(c1.equals(c2)).toBe(false);
  });

  it("different epochs produce different commitments (same party_id, same entropy)", () => {
    const c1 = partyShareCommitment(1, 1n, TEST_ENTROPY);
    const c2 = partyShareCommitment(1, 2n, TEST_ENTROPY);
    expect(c1.equals(c2)).toBe(false);
  });

  it("ceremony_json contains threshold, n_parties, epoch, contribution_count fields", () => {
    const state = newCeremony(3, 5, 7n);
    const json = JSON.stringify(ceremonyToJson(state));

    expect(json).toContain("threshold");
    expect(json).toContain("n_parties");
    expect(json).toContain("epoch");
    expect(json).toContain("contribution_count");
  });

  it("ceremony_json does NOT contain raw entropy bytes", () => {
    let state = newCeremony(2, 3, 1n);
    state = addContribution(state, 1, TEST_ENTROPY);
    const json = JSON.stringify(ceremonyToJson(state));

    // The literal entropy string must not appear
    expect(json).not.toContain("test-entropy-secret-do-not-log");
    // Hex encoding of the raw entropy must not appear either
    const entropyHex = TEST_ENTROPY.toString("hex");
    expect(json).not.toContain(entropyHex);
  });

  it("threshold 3-of-5: 3 contributions can finalize, 2 cannot", () => {
    let state = newCeremony(3, 5, 1n);

    state = addContribution(state, 1, Buffer.from("entropy1"));
    state = addContribution(state, 2, Buffer.from("entropy2"));
    expect(canFinalize(state)).toBe(false);

    state = addContribution(state, 3, Buffer.from("entropy3"));
    expect(canFinalize(state)).toBe(true);
  });

  it("finalized key is deterministic: same contributions → same final_key_hash", () => {
    function buildState() {
      let s = newCeremony(3, 5, 1n);
      s = addContribution(s, 1, Buffer.from("entropy1"));
      s = addContribution(s, 2, Buffer.from("entropy2"));
      s = addContribution(s, 3, Buffer.from("entropy3"));
      return s;
    }

    const key1 = finalKeyHash(buildState());
    const key2 = finalKeyHash(buildState());
    expect(key1).toBe(key2);
    expect(key1).toHaveLength(64);
    expect(key1).toMatch(/^[0-9a-f]{64}$/);
  });
});
