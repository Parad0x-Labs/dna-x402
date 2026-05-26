/**
 * Layer: zkVM bridge format
 *
 * TypeScript mirror of the `dark-zkvm-bridge` Rust crate format.
 * Tests the receipt structure, image_id derivation, bridge_hash
 * determinism, tamper detection, JSON serialisation rules, and the
 * hard invariant that mainnet_ready is always false in bridge receipts.
 *
 * No source imports needed. All bridge functions are implemented inline
 * using node:crypto SHA-256.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inline implementation — mirrors dark-zkvm-bridge Rust crate
// ---------------------------------------------------------------------------

const RECEIPT_VERSION = "zkvm-bridge-v1";

interface ZkvmReceipt {
  image_id: string;    // SHA-256 hex of programHash + domain
  journal_hash: string; // SHA-256 hex of publicInputs
  seal_hash: string;   // SHA-256 hex of proofA
}

interface BridgeReceipt {
  bridge_hash: string;     // SHA-256 hex of the bundle (receipt + programHash)
  compatible: boolean;
  receipt_version: string;
  mainnet_ready: false;    // always false — mainnet gate is separate
  receipt: ZkvmReceipt;
  bridge_description: string[]; // exactly 4 entries
}

function createZkvmReceipt(
  proofA: Buffer,
  publicInputs: Buffer,
  programHash: Buffer
): ZkvmReceipt {
  const image_id = createHash("sha256")
    .update("image-id-v1")
    .update(programHash)
    .digest("hex");

  const journal_hash = createHash("sha256")
    .update("journal-v1")
    .update(publicInputs)
    .digest("hex");

  const seal_hash = createHash("sha256")
    .update("seal-v1")
    .update(proofA)
    .digest("hex");

  return { image_id, journal_hash, seal_hash };
}

function computeBridgeHash(receipt: ZkvmReceipt, programHash: Buffer): string {
  return createHash("sha256")
    .update("bridge-hash-v1")
    .update(receipt.image_id)
    .update(receipt.journal_hash)
    .update(receipt.seal_hash)
    .update(programHash)
    .digest("hex");
}

function createBridgeReceipt(
  proofA: Buffer,
  publicInputs: Buffer,
  programHash: Buffer
): BridgeReceipt {
  const receipt = createZkvmReceipt(proofA, publicInputs, programHash);
  const bridge_hash = computeBridgeHash(receipt, programHash);

  return {
    bridge_hash,
    compatible: true,
    receipt_version: RECEIPT_VERSION,
    mainnet_ready: false,
    receipt,
    bridge_description: [
      "dark-zkvm-bridge proof receipt",
      `program_hash: ${programHash.toString("hex")}`,
      `receipt_version: ${RECEIPT_VERSION}`,
      "mainnet gate: NOT cleared — devnet/testnet only",
    ],
  };
}

function verifyBridgeHash(bridge: BridgeReceipt, programHash: Buffer): boolean {
  const expected = computeBridgeHash(bridge.receipt, programHash);
  return expected === bridge.bridge_hash;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROOF_A = Buffer.alloc(64, 0xca);
const PUBLIC_INPUTS = Buffer.from("public-inputs-devnet-fixture");
const PROGRAM_HASH_A = Buffer.alloc(32, 0xaa);
const PROGRAM_HASH_B = Buffer.alloc(32, 0xbb);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("zk zkVM bridge format", () => {
  it("zkvm_receipt has image_id, journal_hash, seal_hash (all 32-byte hex strings)", () => {
    const receipt = createZkvmReceipt(PROOF_A, PUBLIC_INPUTS, PROGRAM_HASH_A);

    for (const field of ["image_id", "journal_hash", "seal_hash"] as const) {
      expect(receipt[field]).toHaveLength(64);
      expect(receipt[field]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("image_id depends on program_hash — different program_hash → different image_id", () => {
    const rA = createZkvmReceipt(PROOF_A, PUBLIC_INPUTS, PROGRAM_HASH_A);
    const rB = createZkvmReceipt(PROOF_A, PUBLIC_INPUTS, PROGRAM_HASH_B);
    expect(rA.image_id).not.toBe(rB.image_id);
    // journal_hash and seal_hash should be identical (same proof / inputs)
    expect(rA.journal_hash).toBe(rB.journal_hash);
    expect(rA.seal_hash).toBe(rB.seal_hash);
  });

  it("bridge_hash is deterministic: same bundle + program_hash → same bridge_hash", () => {
    const b1 = createBridgeReceipt(PROOF_A, PUBLIC_INPUTS, PROGRAM_HASH_A);
    const b2 = createBridgeReceipt(PROOF_A, PUBLIC_INPUTS, PROGRAM_HASH_A);
    expect(b1.bridge_hash).toBe(b2.bridge_hash);
    expect(b1.bridge_hash).toHaveLength(64);
  });

  it("tampered bridge_hash fails verification", () => {
    const bridge = createBridgeReceipt(PROOF_A, PUBLIC_INPUTS, PROGRAM_HASH_A);
    expect(verifyBridgeHash(bridge, PROGRAM_HASH_A)).toBe(true);

    const tampered: BridgeReceipt = {
      ...bridge,
      bridge_hash: bridge.bridge_hash.replace(/^.{4}/, "dead"),
    };
    expect(verifyBridgeHash(tampered, PROGRAM_HASH_A)).toBe(false);
  });

  it("bridge JSON contains bridge_hash, compatible, receipt_version, mainnet_ready", () => {
    const bridge = createBridgeReceipt(PROOF_A, PUBLIC_INPUTS, PROGRAM_HASH_A);
    const json = JSON.stringify(bridge);

    expect(json).toContain("bridge_hash");
    expect(json).toContain("compatible");
    expect(json).toContain("receipt_version");
    expect(json).toContain("mainnet_ready");
  });

  it("mainnet_ready is always false in bridge receipt JSON", () => {
    const bridge = createBridgeReceipt(PROOF_A, PUBLIC_INPUTS, PROGRAM_HASH_A);
    const parsed = JSON.parse(JSON.stringify(bridge)) as BridgeReceipt;
    expect(parsed.mainnet_ready).toBe(false);
  });

  it("bridge_description array has exactly 4 entries", () => {
    const bridge = createBridgeReceipt(PROOF_A, PUBLIC_INPUTS, PROGRAM_HASH_A);
    expect(bridge.bridge_description).toHaveLength(4);
    // Each entry must be a non-empty string
    for (const entry of bridge.bridge_description) {
      expect(typeof entry).toBe("string");
      expect(entry.length).toBeGreaterThan(0);
    }
  });
});
