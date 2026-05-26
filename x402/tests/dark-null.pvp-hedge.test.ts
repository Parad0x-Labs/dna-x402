import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Inline implementation: PvP hedge commitments
// Mirrors the dark-pvp-hedge Rust crate contract.
// ---------------------------------------------------------------------------

function hedgeCommitment(partyId: Buffer, outcomeBytes: Buffer, nonce: Buffer): Buffer {
  return createHash("sha256")
    .update(Buffer.from("hedge-v1", "utf8"))
    .update(partyId)
    .update(outcomeBytes)
    .update(nonce)
    .digest();
}

function matchId(commitA: Buffer, commitB: Buffer, epoch: bigint): Buffer {
  // Sort commitments lexicographically to ensure symmetry (party-order independence).
  const [first, second] = commitA.compare(commitB) <= 0
    ? [commitA, commitB]
    : [commitB, commitA];

  const epochBuf = Buffer.alloc(8);
  epochBuf.writeBigUInt64LE(epoch);

  return createHash("sha256")
    .update(Buffer.from("match-v1", "utf8"))
    .update(first)
    .update(second)
    .update(epochBuf)
    .digest();
}

interface HedgePublicRecord {
  matchId: string;
  epoch: string;
  mainnet_ready: boolean;
}

function makeHedgePublicRecord(
  commitA: Buffer,
  commitB: Buffer,
  epoch: bigint,
): HedgePublicRecord {
  return {
    matchId: matchId(commitA, commitB, epoch).toString("hex"),
    epoch: epoch.toString(),
    mainnet_ready: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const PARTY_A = Buffer.from("party-alice-00000000000000000000000000", "utf8");
const PARTY_B = Buffer.from("party-bob-000000000000000000000000000", "utf8");
const OUTCOME_WIN = Buffer.from(JSON.stringify({ result: "WIN", payout_bps: 10000 }), "utf8");
const OUTCOME_LOSE = Buffer.from(JSON.stringify({ result: "LOSE", payout_bps: 0 }), "utf8");
const NONCE_A = Buffer.from("hedge-nonce-alice-0000000000000000001", "utf8");
const NONCE_B = Buffer.from("hedge-nonce-alice-0000000000000000002", "utf8");
const NONCE_B_PARTY = Buffer.from("hedge-nonce-bob-00000000000000000001", "utf8");
const EPOCH = 1000n;

describe("dark-null PvP hedge contract (ZK contract mirror)", () => {
  it("outcome_commitment = SHA256(hedge-v1 || party_id || outcome_bytes || nonce) — 32 bytes", () => {
    const commit = hedgeCommitment(PARTY_A, OUTCOME_WIN, NONCE_A);
    expect(commit).toBeInstanceOf(Buffer);
    expect(commit.length).toBe(32);

    // Verify the construction manually.
    const expected = createHash("sha256")
      .update(Buffer.from("hedge-v1", "utf8"))
      .update(PARTY_A)
      .update(OUTCOME_WIN)
      .update(NONCE_A)
      .digest();
    expect(commit).toEqual(expected);
  });

  it("different outcome_bytes → different outcome_commitment", () => {
    const commitWin = hedgeCommitment(PARTY_A, OUTCOME_WIN, NONCE_A);
    const commitLose = hedgeCommitment(PARTY_A, OUTCOME_LOSE, NONCE_A);
    expect(commitWin).not.toEqual(commitLose);
  });

  it("match_id = SHA256(match-v1 || commitment_a || commitment_b || epoch_le8) — 32 bytes", () => {
    const cA = hedgeCommitment(PARTY_A, OUTCOME_WIN, NONCE_A);
    const cB = hedgeCommitment(PARTY_B, OUTCOME_LOSE, NONCE_B_PARTY);
    const mid = matchId(cA, cB, EPOCH);

    expect(mid).toBeInstanceOf(Buffer);
    expect(mid.length).toBe(32);

    // Verify manually using sorted order.
    const [first, second] = cA.compare(cB) <= 0 ? [cA, cB] : [cB, cA];
    const epochBuf = Buffer.alloc(8);
    epochBuf.writeBigUInt64LE(EPOCH);
    const expected = createHash("sha256")
      .update(Buffer.from("match-v1", "utf8"))
      .update(first)
      .update(second)
      .update(epochBuf)
      .digest();
    expect(mid).toEqual(expected);
  });

  it("match_id is symmetric: same commitments same epoch → same match_id regardless of party order", () => {
    const cA = hedgeCommitment(PARTY_A, OUTCOME_WIN, NONCE_A);
    const cB = hedgeCommitment(PARTY_B, OUTCOME_LOSE, NONCE_B_PARTY);

    const midAB = matchId(cA, cB, EPOCH);
    const midBA = matchId(cB, cA, EPOCH); // reversed order
    expect(midAB).toEqual(midBA);
  });

  it("correct reveal: recomputed commitment matches → resolution succeeds", () => {
    const storedCommit = hedgeCommitment(PARTY_A, OUTCOME_WIN, NONCE_A);
    // Reveal: party provides (outcome, nonce). Server recomputes.
    const revealedCommit = hedgeCommitment(PARTY_A, OUTCOME_WIN, NONCE_A);
    expect(revealedCommit).toEqual(storedCommit);
  });

  it("wrong nonce in reveal → commitment mismatch → resolution fails", () => {
    const storedCommit = hedgeCommitment(PARTY_A, OUTCOME_WIN, NONCE_A);
    const wrongReveal = hedgeCommitment(PARTY_A, OUTCOME_WIN, NONCE_B); // wrong nonce
    expect(wrongReveal).not.toEqual(storedCommit);
  });

  it("public_record JSON contains match_id and epoch but NOT outcome_bytes", () => {
    const cA = hedgeCommitment(PARTY_A, OUTCOME_WIN, NONCE_A);
    const cB = hedgeCommitment(PARTY_B, OUTCOME_LOSE, NONCE_B_PARTY);
    const record = makeHedgePublicRecord(cA, cB, EPOCH);

    expect(record).toHaveProperty("matchId");
    expect(typeof record.matchId).toBe("string");
    expect(record.matchId.length).toBe(64);
    expect(record).toHaveProperty("epoch", EPOCH.toString());

    const raw = JSON.stringify(record);
    expect(raw).not.toContain(OUTCOME_WIN.toString("utf8"));
    expect(raw).not.toContain(OUTCOME_LOSE.toString("utf8"));
  });
});
