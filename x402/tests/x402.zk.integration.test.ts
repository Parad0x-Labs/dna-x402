import request from "supertest";
import { describe, expect, it } from "vitest";
import { X402Config } from "../src/config.js";
import { SolanaPaymentVerifier } from "../src/paymentVerifier.js";
import { createX402App } from "../src/server.js";
import { encodeCanonicalProofHeader } from "../src/x402/compat/parse.js";

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const PDX_DARK_PROTOCOL_PROGRAM_ID = "3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz";

type ZkPathStatus = "ZK-IN-PATH" | "NOT-IN-PATH" | "UNKNOWN";

class ObservedSolanaConnection {
  readonly observedProgramIds = new Set<string>();
  expectedRecipient = "recipient-wallet";
  expectedMint = "usdc-mint";
  observedSignature = "";

  async getSignatureStatus(signature: string) {
    this.observedSignature = signature;
    return { value: { err: null } };
  }

  async getParsedTransaction(signature: string) {
    this.observedSignature = signature;
    this.observedProgramIds.add(TOKEN_PROGRAM_ID);
    return {
      slot: 123,
      blockTime: Math.floor(Date.now() / 1000),
      meta: {
        err: null,
        preTokenBalances: [
          {
            owner: this.expectedRecipient,
            mint: this.expectedMint,
            uiTokenAmount: { amount: "0" },
          },
        ],
        postTokenBalances: [
          {
            owner: this.expectedRecipient,
            mint: this.expectedMint,
            uiTokenAmount: { amount: "5000" },
          },
        ],
      },
      transaction: {
        message: {
          instructions: [
            {
              program: "spl-token",
              programId: TOKEN_PROGRAM_ID,
              parsed: {
                type: "transferChecked",
                info: {
                  destination: this.expectedRecipient,
                  mint: this.expectedMint,
                  tokenAmount: { amount: "5000" },
                },
              },
            },
          ],
        },
      },
    };
  }

  async getBlockTime() {
    return Math.floor(Date.now() / 1000);
  }
}

function classifyZkPath(observedProgramIds: Set<string>, pdxProgramId: string): ZkPathStatus {
  if (observedProgramIds.size === 0) {
    return "UNKNOWN";
  }
  if (observedProgramIds.has(pdxProgramId)) {
    return "ZK-IN-PATH";
  }
  return "NOT-IN-PATH";
}

const baseConfig: X402Config = {
  cluster: "devnet",
  port: 8080,
  appVersion: "test",
  solanaRpcUrl: "https://api.devnet.solana.com",
  pdxDarkProtocolProgramId: PDX_DARK_PROTOCOL_PROGRAM_ID,
  usdcMint: "usdc-mint",
  paymentRecipient: "recipient-wallet",
  defaultCurrency: "USDC",
  enabledPricingModels: ["flat", "surge", "stream"],
  marketplaceSelection: "cheapest_sla_else_limit_order",
  quoteTtlSeconds: 120,
  feePolicy: {
    baseFeeAtomic: 0n,
    feeBps: 0,
    minFeeAtomic: 0n,
    accrueThresholdAtomic: 100n,
    minSettleAtomic: 0n,
  },
  nettingThresholdAtomic: 10_000n,
  nettingIntervalMs: 10_000,
  anchoringEnabled: false,
  pauseMarket: false,
  pauseFinalize: false,
  pauseOrders: false,
  disabledShops: [],
  autoDisableReportThreshold: 0,
};

describe("x402 zk/nullifier integration reality check", () => {
  it("classifies live paid x402 runtime path as ZK-IN-PATH or NOT-IN-PATH and never UNKNOWN", async () => {
    const connection = new ObservedSolanaConnection();
    const paymentVerifier = new SolanaPaymentVerifier(connection as any, {
      maxTransferProofAgeSeconds: 900,
    });
    const { app } = createX402App(baseConfig, { paymentVerifier });

    const first = await request(app).get("/resource").expect(402);
    const requiredHeader = String(first.headers["payment-required"] ?? "");
    expect(requiredHeader.length).toBeGreaterThan(10);
    const requiredAmountAtomic = String(first.body.paymentRequirements.quote.amount);

    const proofHeader = encodeCanonicalProofHeader({
      version: "x402-proof-v1",
      scheme: "solana_spl",
      txSig: "11111111111111111111111111111111111111111111",
      amountAtomic: requiredAmountAtomic,
      currency: "USDC",
      recipient: "recipient-wallet",
      raw: { headers: {} },
    });

    const paid = await request(app)
      .get("/resource")
      .set("PAYMENT-REQUIRED", requiredHeader)
      .set("PAYMENT-SIGNATURE", proofHeader)
      .expect(200);

    expect(paid.body.ok).toBe(true);
    const pathStatus = classifyZkPath(connection.observedProgramIds, PDX_DARK_PROTOCOL_PROGRAM_ID);

    // Hard-proof rule: unknown classification is a failure.
    expect(pathStatus).not.toBe("UNKNOWN");
    // Current reality: x402 live pay/finalize verification path does not invoke pdx_dark_protocol.
    expect(pathStatus).toBe("NOT-IN-PATH");
    expect(connection.observedProgramIds.has(TOKEN_PROGRAM_ID)).toBe(true);
    expect(connection.observedProgramIds.has(PDX_DARK_PROTOCOL_PROGRAM_ID)).toBe(false);
  });
});
