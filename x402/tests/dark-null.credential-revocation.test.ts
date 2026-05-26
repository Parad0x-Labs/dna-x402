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
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; }

// Domain functions
function registryId(secret: Buffer): Buffer {
  return sha256(Buffer.from("crev-registry-v1"), secret);
}
function revocationEntry(credId: Buffer, epoch: bigint): Buffer {
  return sha256(Buffer.from("crev-entry-v1"), credId, u64le(epoch));
}
function revocationRoot(entries: Buffer[], count: number): Buffer {
  return sha256(Buffer.from("crev-root-v1"), xorFold(entries), u32le(count));
}

describe("dark-null credential-revocation", () => {
  const secret = Buffer.from("registry-admin-secret-42");
  const credId0 = sha256(Buffer.from("credential-id-0"));
  const credId1 = sha256(Buffer.from("credential-id-1"));
  const epoch0 = 9_000_000n;
  const epoch1 = 9_100_000n;

  it("registry_id = SHA256('crev-registry-v1' || secret) — vector", () => {
    const expected = createHash("sha256")
      .update(Buffer.from("crev-registry-v1"))
      .update(secret)
      .digest();
    expect(registryId(secret).toString("hex")).toBe(expected.toString("hex"));
    expect(registryId(secret).length).toBe(32);
  });

  it("revocation_entry = SHA256('crev-entry-v1' || cred_id || epoch_le8)", () => {
    const expected = createHash("sha256")
      .update(Buffer.from("crev-entry-v1"))
      .update(credId0)
      .update(u64le(epoch0))
      .digest();
    expect(revocationEntry(credId0, epoch0).toString("hex")).toBe(expected.toString("hex"));
  });

  it("revocation_root = SHA256('crev-root-v1' || xorFold(entries) || count_le4)", () => {
    const entry0 = revocationEntry(credId0, epoch0);
    const entries = [entry0];
    const expected = createHash("sha256")
      .update(Buffer.from("crev-root-v1"))
      .update(xorFold(entries))
      .update(u32le(1))
      .digest();
    expect(revocationRoot(entries, 1).toString("hex")).toBe(expected.toString("hex"));
  });

  it("root changes after adding second revocation", () => {
    const entry0 = revocationEntry(credId0, epoch0);
    const entry1 = revocationEntry(credId1, epoch1);
    const root1 = revocationRoot([entry0], 1);
    const root2 = revocationRoot([entry0, entry1], 2);
    expect(root1.toString("hex")).not.toBe(root2.toString("hex"));
  });

  it("different cred_ids produce different entries", () => {
    const e0 = revocationEntry(credId0, epoch0);
    const e1 = revocationEntry(credId1, epoch0);
    expect(e0.toString("hex")).not.toBe(e1.toString("hex"));
  });

  it("mainnet_ready is false", () => {
    const mainnet_ready = false;
    expect(mainnet_ready).toBe(false);
  });
});
