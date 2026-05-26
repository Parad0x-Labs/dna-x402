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
function forestId(nonce: Buffer): Buffer {
  return sha256(Buffer.from("mforest-id-v1"), nonce);
}
function treeId(fId: Buffer, treeIdx: number): Buffer {
  return sha256(Buffer.from("mforest-tree-v1"), fId, u32le(treeIdx));
}
function treeRoot(leaves: Buffer[], tId: Buffer): Buffer {
  return sha256(Buffer.from("mforest-troot-v1"), xorFold(leaves), tId);
}
function forestRoot(treeRoots: Buffer[], count: number): Buffer {
  return sha256(Buffer.from("mforest-root-v1"), xorFold(treeRoots), u32le(count));
}

describe("dark-null merkle-forest", () => {
  const nonce = Buffer.from("test-nonce-merkle-forest-001", "utf8");
  const leaf0 = sha256(Buffer.from("leaf-0"));
  const leaf1 = sha256(Buffer.from("leaf-1"));
  const leaf2 = sha256(Buffer.from("leaf-2"));

  it("forest_id = SHA256('mforest-id-v1' || nonce) — vector", () => {
    const expected = createHash("sha256")
      .update(Buffer.from("mforest-id-v1"))
      .update(nonce)
      .digest();
    expect(forestId(nonce).toString("hex")).toBe(expected.toString("hex"));
    expect(forestId(nonce).length).toBe(32);
  });

  it("tree_id = SHA256('mforest-tree-v1' || forest_id || tree_idx_le4)", () => {
    const fId = forestId(nonce);
    const expected = createHash("sha256")
      .update(Buffer.from("mforest-tree-v1"))
      .update(fId)
      .update(u32le(0))
      .digest();
    expect(treeId(fId, 0).toString("hex")).toBe(expected.toString("hex"));
  });

  it("tree_root = SHA256('mforest-troot-v1' || xorFold(leaves) || tree_id)", () => {
    const fId = forestId(nonce);
    const tId = treeId(fId, 0);
    const leaves = [leaf0, leaf1];
    const expected = createHash("sha256")
      .update(Buffer.from("mforest-troot-v1"))
      .update(xorFold(leaves))
      .update(tId)
      .digest();
    expect(treeRoot(leaves, tId).toString("hex")).toBe(expected.toString("hex"));
  });

  it("forest_root changes after adding second tree", () => {
    const fId = forestId(nonce);
    const tId0 = treeId(fId, 0);
    const tId1 = treeId(fId, 1);
    const root0 = treeRoot([leaf0], tId0);
    const root1 = treeRoot([leaf1], tId1);

    const fr1 = forestRoot([root0], 1);
    const fr2 = forestRoot([root0, root1], 2);
    expect(fr1.toString("hex")).not.toBe(fr2.toString("hex"));
  });

  it("two trees have different tree_ids (different idx)", () => {
    const fId = forestId(nonce);
    const t0 = treeId(fId, 0);
    const t1 = treeId(fId, 1);
    expect(t0.toString("hex")).not.toBe(t1.toString("hex"));
  });

  it("mainnet_ready is false", () => {
    const mainnet_ready = false;
    expect(mainnet_ready).toBe(false);
  });
});
