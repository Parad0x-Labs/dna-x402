import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { X402Config } from "../src/config.js";
import { createX402App } from "../src/server.js";
import * as buildV0 from "../src/tx/buildV0.js";

describe("receipt anchoring has no default program and fails loudly", () => {
  it("buildV0 exports no default anchor program id", () => {
    expect("DEFAULT_ANCHOR_PROGRAM_ID" in buildV0).toBe(false);
  });

  it("deriveBucketPda and the instruction builders refuse without a program id", () => {
    const payer = Keypair.generate();
    expect(() => buildV0.deriveBucketPda({ nowMs: 0 })).toThrow(/RECEIPT_ANCHOR_UNAVAILABLE/);
    const programId = Keypair.generate().publicKey;
    const { bucketPda } = buildV0.deriveBucketPda({ nowMs: 0, programId });
    expect(() => buildV0.buildAnchorInstruction({ payer: payer.publicKey, bucketPda, anchor32: `0x${"11".repeat(32)}` }))
      .toThrow(/RECEIPT_ANCHOR_UNAVAILABLE/);
    expect(() => buildV0.buildAnchorBatchInstruction({ payer: payer.publicKey, bucketPda, anchors: [`0x${"11".repeat(32)}`] }))
      .toThrow(/RECEIPT_ANCHOR_UNAVAILABLE/);
    const ix = buildV0.buildAnchorInstruction({ payer: payer.publicKey, bucketPda, anchor32: `0x${"11".repeat(32)}`, programId });
    expect(ix.programId.equals(programId)).toBe(true);
  });

  const baseConfig: X402Config = {
    port: 0,
    appVersion: "test",
    solanaRpcUrl: "http://127.0.0.1:1",
    usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    paymentRecipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
    defaultCurrency: "USDC",
    enabledPricingModels: ["flat"],
    marketplaceSelection: "cheapest_sla_else_limit_order",
    quoteTtlSeconds: 120,
    feePolicy: { baseFeeAtomic: 0n, feeBps: 0, minFeeAtomic: 0n, accrueThresholdAtomic: 100n, minSettleAtomic: 0n },
    nettingThresholdAtomic: 1000n,
    nettingIntervalMs: 1000,
    pauseMarket: false,
    pauseFinalize: false,
    pauseOrders: false,
    disabledShops: [],
    autoDisableReportThreshold: 0,
    allowInsecure: true,
  };

  it("server refuses to start when anchoring is enabled without a program id or keypair", () => {
    expect(() => createX402App({ ...baseConfig, anchoringEnabled: true })).toThrow(
      /RECEIPT_ANCHOR_UNAVAILABLE: ANCHORING_ENABLED is set but RECEIPT_ANCHOR_PROGRAM_ID and ANCHORING_KEYPAIR_PATH is missing/,
    );
    expect(() => createX402App({ ...baseConfig, anchoringEnabled: true, anchoringKeypairPath: "/nonexistent.json" })).toThrow(
      /RECEIPT_ANCHOR_UNAVAILABLE: .*RECEIPT_ANCHOR_PROGRAM_ID is missing/,
    );
  });

  it("server refuses to start when the anchor client cannot be built", () => {
    const missing = path.join(os.tmpdir(), `no-such-keypair-${process.pid}.json`);
    expect(fs.existsSync(missing)).toBe(false);
    expect(() => createX402App({
      ...baseConfig,
      anchoringEnabled: true,
      receiptAnchorProgramId: Keypair.generate().publicKey.toBase58(),
      anchoringKeypairPath: missing,
    })).toThrow(/RECEIPT_ANCHOR_UNAVAILABLE: ANCHORING_ENABLED is set but the anchor client could not be built/);
  });

  it("server starts with anchoring off by default and reports it disabled", () => {
    const { context } = createX402App(baseConfig);
    expect(context.anchoringQueue).toBeUndefined();
  });
});
