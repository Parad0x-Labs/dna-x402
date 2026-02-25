import request from "supertest";
import { Connection, Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { X402Config } from "../src/config.js";
import { ReceiptSigner } from "../src/receipts.js";
import { createX402App } from "../src/server.js";
import { ReceiptAnchorClient } from "../src/onchain/receiptAnchorClient.js";

const baseConfig: X402Config = {
  port: 8080,
  appVersion: "test",
  solanaRpcUrl: "https://api.devnet.solana.com",
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  paymentRecipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
  defaultCurrency: "USDC",
  enabledPricingModels: ["flat", "surge", "stream"],
  marketplaceSelection: "cheapest_sla_else_limit_order",
  quoteTtlSeconds: 120,
  feePolicy: {
    baseFeeAtomic: 0n,
    feeBps: 30,
    minFeeAtomic: 0n,
    accrueThresholdAtomic: 100n,
    minSettleAtomic: 0n,
  },
  nettingThresholdAtomic: 10_000n,
  nettingIntervalMs: 10_000,
  pauseMarket: false,
  pauseFinalize: false,
  pauseOrders: false,
  disabledShops: [],
  autoDisableReportThreshold: 0,
};

describe("anchoring program guard", () => {
  it("exposes anchor/program mismatch safety in /health", async () => {
    const safeConfig: X402Config = {
      ...baseConfig,
      pdxDarkProtocolProgramId: "3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz",
      receiptAnchorProgramId: "9bPBmDNnKGxF8GTt4SqodNJZ1b9nSjoKia2ML4V5gGCF",
    };
    const unsafeConfig: X402Config = {
      ...baseConfig,
      pdxDarkProtocolProgramId: "3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz",
      receiptAnchorProgramId: "3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz",
    };

    const { app: safeApp } = createX402App(safeConfig, {
      receiptSigner: ReceiptSigner.generate(),
    });
    const safeRes = await request(safeApp).get("/health").expect(200);
    expect(safeRes.body.anchoring.anchorProgramOk).toBe(true);
    expect(safeRes.body.anchoring.anchorProgramId).toBe(safeConfig.receiptAnchorProgramId);
    expect(safeRes.body.anchoring.protocolProgramId).toBe(safeConfig.pdxDarkProtocolProgramId);

    const { app: unsafeApp } = createX402App(unsafeConfig, {
      receiptSigner: ReceiptSigner.generate(),
    });
    const unsafeRes = await request(unsafeApp).get("/health").expect(200);
    expect(unsafeRes.body.anchoring.anchorProgramOk).toBe(false);
  });

  it("fails fast with ANCHOR_PROGRAM_MISCONFIGURED before sending tx", async () => {
    const sendTransaction = vi.fn();
    const getLatestBlockhash = vi.fn();
    const connection = {
      sendTransaction,
      getLatestBlockhash,
      getAddressLookupTable: vi.fn(),
      confirmTransaction: vi.fn(),
      simulateTransaction: vi.fn(),
      getAccountInfo: vi.fn(),
    } as unknown as Connection;

    const sameProgramId = Keypair.generate().publicKey;
    const client = new ReceiptAnchorClient({
      connection,
      payer: Keypair.generate(),
      programId: sameProgramId,
      protocolProgramId: sameProgramId,
    });

    await expect(client.sendSingle({
      anchor32: `0x${"11".repeat(32)}`,
    })).rejects.toMatchObject({
      code: "ANCHOR_PROGRAM_MISCONFIGURED",
    });
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(getLatestBlockhash).not.toHaveBeenCalled();
  });
});

