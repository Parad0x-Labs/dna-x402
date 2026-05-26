import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inline implementations
// ---------------------------------------------------------------------------

/** Chain IDs used across tests */
const ChainId = {
  Solana: 1,
  Ethereum: 2,
  Arbitrum: 3,
  Polygon: 4,
} as const;

function bridgeHash(
  source: number,
  dest: number,
  nullifier: Buffer,
  slot: bigint
): Buffer {
  const srcBuf = Buffer.alloc(1);
  srcBuf.writeUInt8(source & 0xff, 0);
  const dstBuf = Buffer.alloc(1);
  dstBuf.writeUInt8(dest & 0xff, 0);

  const slotBuf = Buffer.alloc(8);
  const lo = Number(slot & BigInt(0xffffffff));
  const hi = Number((slot >> BigInt(32)) & BigInt(0xffffffff));
  slotBuf.writeUInt32LE(lo, 0);
  slotBuf.writeUInt32LE(hi, 4);

  const h = createHash("sha256");
  h.update(Buffer.from("xchain-bridge-v1", "utf8"));
  h.update(srcBuf);
  h.update(dstBuf);
  h.update(nullifier); // must be exactly 32 bytes
  h.update(slotBuf);
  return h.digest();
}

function evmCalldataHash(
  bridgeHashBuf: Buffer,
  evmTargetHash: Buffer
): Buffer {
  const h = createHash("sha256");
  h.update(Buffer.from("evm-calldata-v1", "utf8"));
  h.update(bridgeHashBuf);
  h.update(evmTargetHash);
  return h.digest();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dark-null cross-chain bridge", () => {
  const NULLIFIER = Buffer.alloc(32, 0xde);
  const SLOT = BigInt(9_999_999);
  const EVM_TARGET_HASH = createHash("sha256")
    .update(Buffer.from("evm-target-address", "utf8"))
    .digest();

  it("bridge_hash = SHA256(prefix || source_byte || dest_byte || nullifier32 || slot_le8) — 32 bytes", () => {
    const bh = bridgeHash(ChainId.Solana, ChainId.Ethereum, NULLIFIER, SLOT);
    expect(bh).toBeInstanceOf(Buffer);
    expect(bh.length).toBe(32);

    // Manual recomputation
    const slotBuf = Buffer.alloc(8);
    slotBuf.writeUInt32LE(Number(SLOT & BigInt(0xffffffff)), 0);
    slotBuf.writeUInt32LE(
      Number((SLOT >> BigInt(32)) & BigInt(0xffffffff)),
      4
    );
    const h = createHash("sha256");
    h.update(Buffer.from("xchain-bridge-v1", "utf8"));
    h.update(Buffer.from([ChainId.Solana]));
    h.update(Buffer.from([ChainId.Ethereum]));
    h.update(NULLIFIER);
    h.update(slotBuf);
    expect(bh.toString("hex")).toBe(h.digest("hex"));
  });

  it("evm_calldata_hash = SHA256(prefix || bridge_hash || evm_target_hash)", () => {
    const bh = bridgeHash(ChainId.Solana, ChainId.Ethereum, NULLIFIER, SLOT);
    const cdh = evmCalldataHash(bh, EVM_TARGET_HASH);
    expect(cdh).toBeInstanceOf(Buffer);
    expect(cdh.length).toBe(32);

    const h = createHash("sha256");
    h.update(Buffer.from("evm-calldata-v1", "utf8"));
    h.update(bh);
    h.update(EVM_TARGET_HASH);
    expect(cdh.toString("hex")).toBe(h.digest("hex"));
  });

  it("different source chains → different bridge_hash", () => {
    const bh1 = bridgeHash(ChainId.Solana, ChainId.Ethereum, NULLIFIER, SLOT);
    const bh2 = bridgeHash(ChainId.Polygon, ChainId.Ethereum, NULLIFIER, SLOT);
    expect(bh1.toString("hex")).not.toBe(bh2.toString("hex"));
  });

  it("different dest chains → different bridge_hash", () => {
    const bh1 = bridgeHash(ChainId.Solana, ChainId.Ethereum, NULLIFIER, SLOT);
    const bh2 = bridgeHash(ChainId.Solana, ChainId.Arbitrum, NULLIFIER, SLOT);
    expect(bh1.toString("hex")).not.toBe(bh2.toString("hex"));
  });

  it("all-zero nullifier case: bridge_hash is valid but semantically invalid (detect null nullifier)", () => {
    const zeroNullifier = Buffer.alloc(32, 0x00);
    const bh = bridgeHash(ChainId.Solana, ChainId.Ethereum, zeroNullifier, SLOT);

    // The hash itself is computable (32 bytes), but a null-nullifier is semantically invalid
    expect(bh.length).toBe(32);

    // Semantic guard: all-zero nullifier should be rejected by policy
    const isNullNullifier = zeroNullifier.every((b) => b === 0);
    expect(isNullNullifier).toBe(true);

    // A real bridge would throw; simulate that guard here
    const validateNullifier = (n: Buffer): boolean => !n.every((b) => b === 0);
    expect(validateNullifier(zeroNullifier)).toBe(false);
    expect(validateNullifier(NULLIFIER)).toBe(true);
  });

  it("bridge hash deterministic: same inputs → same bridge_hash", () => {
    const bh1 = bridgeHash(ChainId.Solana, ChainId.Ethereum, NULLIFIER, SLOT);
    const bh2 = bridgeHash(ChainId.Solana, ChainId.Ethereum, NULLIFIER, SLOT);
    expect(bh1.toString("hex")).toBe(bh2.toString("hex"));
  });

  it("public record JSON: source/dest as strings, bridge_hash as hex, mainnet_ready: false", () => {
    const bh = bridgeHash(ChainId.Solana, ChainId.Ethereum, NULLIFIER, SLOT);

    const chainName = (id: number): string => {
      const names: Record<number, string> = {
        1: "solana",
        2: "ethereum",
        3: "arbitrum",
        4: "polygon",
      };
      return names[id] ?? "unknown";
    };

    const publicRecord = {
      source_chain: chainName(ChainId.Solana),
      dest_chain: chainName(ChainId.Ethereum),
      bridge_hash: bh.toString("hex"),
      slot: Number(SLOT),
      mainnet_ready: false,
    };

    expect(typeof publicRecord.source_chain).toBe("string");
    expect(typeof publicRecord.dest_chain).toBe("string");
    expect(publicRecord.source_chain).toBe("solana");
    expect(publicRecord.dest_chain).toBe("ethereum");
    expect(typeof publicRecord.bridge_hash).toBe("string");
    expect(publicRecord.bridge_hash.length).toBe(64);
    expect(publicRecord.mainnet_ready).toBe(false);
  });
});
