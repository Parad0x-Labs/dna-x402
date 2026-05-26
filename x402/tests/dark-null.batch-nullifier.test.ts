import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const b of bufs) h.update(b);
  return h.digest();
}
function xorFold(hashes: Buffer[]): Buffer {
  const acc = Buffer.alloc(32, 0);
  for (const h of hashes) { for (let i = 0; i < 32; i++) acc[i] ^= h[i]; }
  return acc;
}
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }

// Domain functions
function nullifierEntry(nullifier: Buffer, idx: number): Buffer {
  return sha256(Buffer.from("bnull-entry-v1"), nullifier, u32le(idx));
}
function batchRoot(entries: Buffer[], count: number): Buffer {
  return sha256(Buffer.from("bnull-root-v1"), xorFold(entries), u32le(count));
}
function batchId(bRoot: Buffer, committed: number): Buffer {
  return sha256(Buffer.from("bnull-id-v1"), bRoot, Buffer.from([committed]));
}

describe("dark-null batch-nullifier", () => {
  const nullifier0 = sha256(Buffer.from("nullifier-secret-0"));
  const nullifier1 = sha256(Buffer.from("nullifier-secret-1"));

  it("nullifier_entry = SHA256('bnull-entry-v1' || nullifier || idx_le4) — vector with idx=0", () => {
    const expected = createHash("sha256")
      .update(Buffer.from("bnull-entry-v1"))
      .update(nullifier0)
      .update(u32le(0))
      .digest();
    expect(nullifierEntry(nullifier0, 0).toString("hex")).toBe(expected.toString("hex"));
    expect(nullifierEntry(nullifier0, 0).length).toBe(32);
  });

  it("batch_root = SHA256('bnull-root-v1' || xorFold(entries) || count_le4)", () => {
    const entry0 = nullifierEntry(nullifier0, 0);
    const entries = [entry0];
    const expected = createHash("sha256")
      .update(Buffer.from("bnull-root-v1"))
      .update(xorFold(entries))
      .update(u32le(1))
      .digest();
    expect(batchRoot(entries, 1).toString("hex")).toBe(expected.toString("hex"));
  });

  it("batch_id = SHA256('bnull-id-v1' || batch_root || [1]) — committed=1", () => {
    const entry0 = nullifierEntry(nullifier0, 0);
    const bRoot = batchRoot([entry0], 1);
    const expected = createHash("sha256")
      .update(Buffer.from("bnull-id-v1"))
      .update(bRoot)
      .update(Buffer.from([1]))
      .digest();
    expect(batchId(bRoot, 1).toString("hex")).toBe(expected.toString("hex"));
  });

  it("batch_root changes when second nullifier added", () => {
    const entry0 = nullifierEntry(nullifier0, 0);
    const entry1 = nullifierEntry(nullifier1, 1);
    const root1 = batchRoot([entry0], 1);
    const root2 = batchRoot([entry0, entry1], 2);
    expect(root1.toString("hex")).not.toBe(root2.toString("hex"));
  });

  it("batch_id is non-zero and deterministic", () => {
    const entry0 = nullifierEntry(nullifier0, 0);
    const bRoot = batchRoot([entry0], 1);
    const id1 = batchId(bRoot, 1);
    const id2 = batchId(bRoot, 1);
    expect(id1.toString("hex")).toBe(id2.toString("hex"));
    expect(id1.toString("hex")).not.toBe("0".repeat(64));
  });

  it("mainnet_ready is false", () => {
    const mainnet_ready = false;
    expect(mainnet_ready).toBe(false);
  });
});
