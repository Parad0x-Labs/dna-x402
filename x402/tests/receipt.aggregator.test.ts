/**
 * Layer: Epoch receipt aggregation data contract
 *
 * TypeScript mirror of the `dark-receipt-aggregator` Rust crate format.
 * Tests epoch initialisation, per-layer receipt tracking, deterministic
 * epoch_root derivation, and summary JSON serialisation.
 *
 * No source imports needed. All aggregation functions are implemented inline
 * using node:crypto SHA-256.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inline implementation — mirrors dark-receipt-aggregator Rust crate
// ---------------------------------------------------------------------------

type ReceiptLayer = "flywheel" | "zk_proof" | "compute" | "compliance" | "payment";

const ALL_LAYERS: ReceiptLayer[] = ["flywheel", "zk_proof", "compute", "compliance", "payment"];

function zeroLayerCounts(): Record<ReceiptLayer, number> {
  return { flywheel: 0, zk_proof: 0, compute: 0, compliance: 0, payment: 0 };
}

class EpochAggregator {
  epoch: bigint;
  entryCount: number;
  layerCounts: Record<ReceiptLayer, number>;
  /** Accumulated XOR of all receipt hashes added so far */
  xorAcc: Buffer;
  /** Always false until the protocol is production-ready */
  mainnet_ready: false;

  constructor(epoch: bigint) {
    this.epoch        = epoch;
    this.entryCount   = 0;
    this.layerCounts  = zeroLayerCounts();
    this.xorAcc       = Buffer.alloc(32, 0);
    this.mainnet_ready = false;
  }

  addReceipt(layer: ReceiptLayer, receiptHash: Buffer): void {
    this.entryCount++;
    this.layerCounts[layer]++;
    // XOR-accumulate the 32-byte receipt hash
    for (let i = 0; i < 32; i++) {
      this.xorAcc[i] ^= receiptHash[i];
    }
  }

  /**
   * Deterministic epoch root:
   * SHA256("epoch-root-v1" || epoch_le8 || xorAcc)
   */
  finalize(): Buffer {
    const epochBuf = Buffer.alloc(8);
    epochBuf.writeBigUInt64LE(this.epoch, 0);
    return createHash("sha256")
      .update("epoch-root-v1")
      .update(epochBuf)
      .update(this.xorAcc)
      .digest();
  }

  summaryJson(): string {
    return JSON.stringify({
      epoch:         this.epoch.toString(),
      epoch_root:    this.finalize().toString("hex"),
      entry_count:   this.entryCount,
      layer_counts:  this.layerCounts,
      mainnet_ready: this.mainnet_ready,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeReceiptHash(seed: string): Buffer {
  return createHash("sha256").update(`receipt-seed:${seed}`).digest();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("epoch receipt aggregation data contract", () => {
  it("new epoch has entry_count = 0", () => {
    const agg = new EpochAggregator(1n);
    expect(agg.entryCount).toBe(0);
  });

  it("adding a receipt increments entry_count", () => {
    const agg = new EpochAggregator(1n);
    agg.addReceipt("payment", fakeReceiptHash("p1"));
    expect(agg.entryCount).toBe(1);
    agg.addReceipt("compute", fakeReceiptHash("c1"));
    expect(agg.entryCount).toBe(2);
  });

  it("layer counts tracked per type (flywheel, zk_proof, compute, compliance, payment)", () => {
    const agg = new EpochAggregator(2n);
    agg.addReceipt("flywheel",   fakeReceiptHash("fw1"));
    agg.addReceipt("flywheel",   fakeReceiptHash("fw2"));
    agg.addReceipt("zk_proof",   fakeReceiptHash("zk1"));
    agg.addReceipt("compute",    fakeReceiptHash("co1"));
    agg.addReceipt("compliance", fakeReceiptHash("cl1"));
    agg.addReceipt("payment",    fakeReceiptHash("pa1"));
    agg.addReceipt("payment",    fakeReceiptHash("pa2"));
    agg.addReceipt("payment",    fakeReceiptHash("pa3"));

    expect(agg.layerCounts.flywheel).toBe(2);
    expect(agg.layerCounts.zk_proof).toBe(1);
    expect(agg.layerCounts.compute).toBe(1);
    expect(agg.layerCounts.compliance).toBe(1);
    expect(agg.layerCounts.payment).toBe(3);
  });

  it("epoch_root is 32 bytes (64-char hex)", () => {
    const agg = new EpochAggregator(3n);
    agg.addReceipt("payment", fakeReceiptHash("x"));
    const root = agg.finalize();
    expect(root).toBeInstanceOf(Buffer);
    expect(root.length).toBe(32);
    expect(root.toString("hex")).toHaveLength(64);
    expect(root.toString("hex")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("epoch_root is deterministic: same receipts same epoch → same root", () => {
    function buildAgg(): EpochAggregator {
      const agg = new EpochAggregator(5n);
      agg.addReceipt("payment",  fakeReceiptHash("p1"));
      agg.addReceipt("compute",  fakeReceiptHash("c1"));
      agg.addReceipt("zk_proof", fakeReceiptHash("z1"));
      return agg;
    }
    const root1 = buildAgg().finalize().toString("hex");
    const root2 = buildAgg().finalize().toString("hex");
    expect(root1).toBe(root2);
  });

  it("different epoch number → different epoch_root (even same receipt hashes)", () => {
    const hash = fakeReceiptHash("shared");

    const agg1 = new EpochAggregator(10n);
    agg1.addReceipt("payment", hash);

    const agg2 = new EpochAggregator(11n);
    agg2.addReceipt("payment", hash);

    expect(agg1.finalize().equals(agg2.finalize())).toBe(false);
  });

  it("epoch_summary_json contains epoch, epoch_root, entry_count, layer_counts, mainnet_ready", () => {
    const agg = new EpochAggregator(99n);
    agg.addReceipt("compliance", fakeReceiptHash("cl"));
    const json = agg.summaryJson();
    const parsed = JSON.parse(json);

    expect(parsed).toHaveProperty("epoch");
    expect(parsed).toHaveProperty("epoch_root");
    expect(parsed).toHaveProperty("entry_count");
    expect(parsed).toHaveProperty("layer_counts");
    expect(parsed).toHaveProperty("mainnet_ready");

    expect(parsed.epoch).toBe("99");
    expect(parsed.entry_count).toBe(1);
    expect(parsed.mainnet_ready).toBe(false);

    // epoch_root must be a 64-char hex string
    expect(parsed.epoch_root).toHaveLength(64);
    expect(parsed.epoch_root).toMatch(/^[0-9a-f]{64}$/);
  });
});
