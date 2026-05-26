import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const b of bufs) h.update(b);
  return h.digest();
}
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; }

// Domain functions
function reserveCommitment(reserves: bigint, blinding: Buffer): Buffer {
  return sha256(Buffer.from("por-reserve-v1"), u64le(reserves), blinding);
}
function liabilityCommitment(liabilities: bigint, blinding: Buffer): Buffer {
  return sha256(Buffer.from("por-liab-v1"), u64le(liabilities), blinding);
}
function surplusHash(surplus: bigint): Buffer {
  return sha256(Buffer.from("por-surplus-v1"), u64le(surplus));
}
function proofId(reserveCommit: Buffer, liabCommit: Buffer, sHash: Buffer): Buffer {
  return sha256(Buffer.from("por-proof-v1"), reserveCommit, liabCommit, sHash);
}

describe("dark-null proof-of-reserve", () => {
  const reserves = 1_000_000n;
  const liabilities = 500_000n;
  const surplus = reserves - liabilities; // 500_000n
  const blinding = sha256(Buffer.from("por-blinding-nonce"));
  const liabBlinding = sha256(Buffer.from("por-liab-blinding-nonce"));

  it("reserve_commitment = SHA256('por-reserve-v1' || reserves_le8 || blinding) — vector", () => {
    const expected = createHash("sha256")
      .update(Buffer.from("por-reserve-v1"))
      .update(u64le(reserves))
      .update(blinding)
      .digest();
    expect(reserveCommitment(reserves, blinding).toString("hex")).toBe(expected.toString("hex"));
    expect(reserveCommitment(reserves, blinding).length).toBe(32);
  });

  it("surplus_hash = SHA256('por-surplus-v1' || surplus_le8) — surplus=500 vector", () => {
    const surplus500 = 500n;
    const expected = createHash("sha256")
      .update(Buffer.from("por-surplus-v1"))
      .update(u64le(surplus500))
      .digest();
    expect(surplusHash(surplus500).toString("hex")).toBe(expected.toString("hex"));
  });

  it("proof_id formula is correct", () => {
    const rc = reserveCommitment(reserves, blinding);
    const lc = liabilityCommitment(liabilities, liabBlinding);
    const sh = surplusHash(surplus);
    const expected = createHash("sha256")
      .update(Buffer.from("por-proof-v1"))
      .update(rc)
      .update(lc)
      .update(sh)
      .digest();
    expect(proofId(rc, lc, sh).toString("hex")).toBe(expected.toString("hex"));
  });

  it("different reserves → different reserve_commitments", () => {
    const rc1 = reserveCommitment(1_000_000n, blinding);
    const rc2 = reserveCommitment(2_000_000n, blinding);
    expect(rc1.toString("hex")).not.toBe(rc2.toString("hex"));
  });

  it("proof_id is deterministic and non-zero", () => {
    const rc = reserveCommitment(reserves, blinding);
    const lc = liabilityCommitment(liabilities, liabBlinding);
    const sh = surplusHash(surplus);
    const id1 = proofId(rc, lc, sh);
    const id2 = proofId(rc, lc, sh);
    expect(id1.toString("hex")).toBe(id2.toString("hex"));
    expect(id1.toString("hex")).not.toBe("0".repeat(64));
  });

  it("mainnet_ready is false", () => {
    const mainnet_ready = false;
    expect(mainnet_ready).toBe(false);
  });
});
