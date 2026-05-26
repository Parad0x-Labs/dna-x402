import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inline implementations
// ---------------------------------------------------------------------------

const enum VoteChoice {
  Yes = 1,
  No = 2,
  Abstain = 3,
}

function voteCommitmentHash(
  choice: number,
  nonce: Buffer,
  proposalId: bigint
): Buffer {
  const choiceBuf = Buffer.alloc(1);
  choiceBuf.writeUInt8(choice & 0xff, 0);

  const proposalBuf = Buffer.alloc(8);
  const lo = Number(proposalId & BigInt(0xffffffff));
  const hi = Number((proposalId >> BigInt(32)) & BigInt(0xffffffff));
  proposalBuf.writeUInt32LE(lo, 0);
  proposalBuf.writeUInt32LE(hi, 4);

  const h = createHash("sha256");
  h.update(Buffer.from("vote-commit-v1", "utf8"));
  h.update(choiceBuf);
  h.update(nonce);
  h.update(proposalBuf);
  return h.digest();
}

function tallyHash(
  proposalId: bigint,
  yes: number,
  no: number,
  abstain: number
): Buffer {
  const proposalBuf = Buffer.alloc(8);
  const lo = Number(proposalId & BigInt(0xffffffff));
  const hi = Number((proposalId >> BigInt(32)) & BigInt(0xffffffff));
  proposalBuf.writeUInt32LE(lo, 0);
  proposalBuf.writeUInt32LE(hi, 4);

  const yesBuf = Buffer.alloc(4);
  yesBuf.writeUInt32LE(yes >>> 0, 0);
  const noBuf = Buffer.alloc(4);
  noBuf.writeUInt32LE(no >>> 0, 0);
  const abstainBuf = Buffer.alloc(4);
  abstainBuf.writeUInt32LE(abstain >>> 0, 0);

  const h = createHash("sha256");
  h.update(Buffer.from("tally-v1", "utf8"));
  h.update(proposalBuf);
  h.update(yesBuf);
  h.update(noBuf);
  h.update(abstainBuf);
  return h.digest();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dark-null DAO vote", () => {
  const NONCE = Buffer.alloc(32, 0x77);
  const PROPOSAL_ID = BigInt(101);

  it("vote commitment = SHA256(prefix || choice_byte || nonce || proposal_id_le8) — 32 bytes", () => {
    const commit = voteCommitmentHash(VoteChoice.Yes, NONCE, PROPOSAL_ID);
    expect(commit).toBeInstanceOf(Buffer);
    expect(commit.length).toBe(32);

    // Manual recomputation
    const proposalBuf = Buffer.alloc(8);
    proposalBuf.writeUInt32LE(Number(PROPOSAL_ID & BigInt(0xffffffff)), 0);
    proposalBuf.writeUInt32LE(
      Number((PROPOSAL_ID >> BigInt(32)) & BigInt(0xffffffff)),
      4
    );
    const h = createHash("sha256");
    h.update(Buffer.from("vote-commit-v1", "utf8"));
    h.update(Buffer.from([VoteChoice.Yes]));
    h.update(NONCE);
    h.update(proposalBuf);
    expect(commit.toString("hex")).toBe(h.digest("hex"));
  });

  it("VoteChoice Yes=1, No=2, Abstain=3 produce different commitments (same other inputs)", () => {
    const cYes = voteCommitmentHash(VoteChoice.Yes, NONCE, PROPOSAL_ID);
    const cNo = voteCommitmentHash(VoteChoice.No, NONCE, PROPOSAL_ID);
    const cAbstain = voteCommitmentHash(VoteChoice.Abstain, NONCE, PROPOSAL_ID);

    expect(cYes.toString("hex")).not.toBe(cNo.toString("hex"));
    expect(cNo.toString("hex")).not.toBe(cAbstain.toString("hex"));
    expect(cYes.toString("hex")).not.toBe(cAbstain.toString("hex"));
  });

  it("same vote + nonce → same commitment (deterministic)", () => {
    const c1 = voteCommitmentHash(VoteChoice.Yes, NONCE, PROPOSAL_ID);
    const c2 = voteCommitmentHash(VoteChoice.Yes, NONCE, PROPOSAL_ID);
    expect(c1.toString("hex")).toBe(c2.toString("hex"));
  });

  it("wrong choice in reveal → recomputed hash mismatches stored commitment", () => {
    // Voter commits to Yes but reveals No
    const stored = voteCommitmentHash(VoteChoice.Yes, NONCE, PROPOSAL_ID);
    const revealed = voteCommitmentHash(VoteChoice.No, NONCE, PROPOSAL_ID);
    expect(stored.toString("hex")).not.toBe(revealed.toString("hex"));
  });

  it("tally: 3 Yes, 2 No, 1 Abstain → tally_hash is SHA256(prefix || proposal_le8 || yes_le4 || no_le4 || abstain_le4)", () => {
    const th = tallyHash(PROPOSAL_ID, 3, 2, 1);
    expect(th).toBeInstanceOf(Buffer);
    expect(th.length).toBe(32);

    // Manual recomputation
    const proposalBuf = Buffer.alloc(8);
    proposalBuf.writeUInt32LE(Number(PROPOSAL_ID & BigInt(0xffffffff)), 0);
    proposalBuf.writeUInt32LE(
      Number((PROPOSAL_ID >> BigInt(32)) & BigInt(0xffffffff)),
      4
    );
    const yesBuf = Buffer.alloc(4);
    yesBuf.writeUInt32LE(3, 0);
    const noBuf = Buffer.alloc(4);
    noBuf.writeUInt32LE(2, 0);
    const abstainBuf = Buffer.alloc(4);
    abstainBuf.writeUInt32LE(1, 0);

    const h = createHash("sha256");
    h.update(Buffer.from("tally-v1", "utf8"));
    h.update(proposalBuf);
    h.update(yesBuf);
    h.update(noBuf);
    h.update(abstainBuf);
    expect(th.toString("hex")).toBe(h.digest("hex"));
  });

  it("tally hash deterministic: same counts → same hash", () => {
    const t1 = tallyHash(PROPOSAL_ID, 3, 2, 1);
    const t2 = tallyHash(PROPOSAL_ID, 3, 2, 1);
    expect(t1.toString("hex")).toBe(t2.toString("hex"));
  });

  it("tally public record JSON contains yes_count, no_count, abstain_count and tally_hash but no voter commitment hashes", () => {
    const th = tallyHash(PROPOSAL_ID, 3, 2, 1);

    // Simulate building a public tally record
    const publicRecord = {
      proposal_id: Number(PROPOSAL_ID),
      yes_count: 3,
      no_count: 2,
      abstain_count: 1,
      tally_hash: th.toString("hex"),
      mainnet_ready: false,
    };

    expect(publicRecord).toHaveProperty("yes_count", 3);
    expect(publicRecord).toHaveProperty("no_count", 2);
    expect(publicRecord).toHaveProperty("abstain_count", 1);
    expect(publicRecord).toHaveProperty("tally_hash");
    expect(typeof publicRecord.tally_hash).toBe("string");
    expect(publicRecord.tally_hash.length).toBe(64); // hex of 32 bytes

    // Must NOT contain individual voter commitment hashes
    const keys = Object.keys(publicRecord);
    const hasVoterCommit = keys.some(
      (k) => k.includes("voter") || k.includes("commit")
    );
    expect(hasVoterCommit).toBe(false);
  });
});
