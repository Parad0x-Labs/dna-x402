import request from "supertest";
import { Connection, Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

// Capture what the verifier asks the SPL transfer check for, without RPC.
const captured: Array<{ expectedMemo?: string }> = [];
vi.mock("../src/verifier/splTransfer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verifier/splTransfer.js")>();
  return {
    ...actual,
    verifySplTransferProof: vi.fn(async (_connection: unknown, input: { txSignature: string; expectedMemo?: string }) => {
      captured.push({ expectedMemo: input.expectedMemo });
      return { ok: true, settledOnchain: true, txSignature: input.txSignature };
    }),
  };
});

const { loadConfig } = await import("../src/config.js");
type X402Config = import("../src/config.js").X402Config;
const { SolanaPaymentVerifier } = await import("../src/paymentVerifier.js");
const { createPaymentVerifier } = await import("../src/sdk/paymentSupport.js");
const { createX402App } = await import("../src/server.js");
const { encodeCanonicalRequiredHeader } = await import("../src/x402/compat/parse.js");
const decodeRequired = (header: string) => JSON.parse(Buffer.from(header, "base64").toString("utf8"));

const quote = {
  quoteId: "q-memo",
  resource: "/resource",
  amountAtomic: "100",
  feeAtomic: "0",
  totalAtomic: "100",
  mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
  expiresAt: "2099-01-01T00:00:00.000Z",
  settlement: ["transfer"],
  memoHash: "quote-memo-hash",
};
const transferProof = { settlement: "transfer" as const, txSignature: "sig" };

afterEach(() => {
  captured.length = 0;
});

afterEach(() => {
  captured.length = 0;
});

describe("quote binding (REQUIRE_PAYMENT_MEMO) is on by default", () => {
  it("config defaults to true; only an explicit 0/false/no/off opts out", () => {
    expect(loadConfig({}).requirePaymentMemo).toBe(true);
    expect(loadConfig({ REQUIRE_PAYMENT_MEMO: "" }).requirePaymentMemo).toBe(true);
    expect(loadConfig({ REQUIRE_PAYMENT_MEMO: "1" }).requirePaymentMemo).toBe(true);
    for (const off of ["0", "false", "no", "off", "FALSE"]) {
      expect(loadConfig({ REQUIRE_PAYMENT_MEMO: off }).requirePaymentMemo).toBe(false);
    }
  });

  it("SolanaPaymentVerifier requires the quote memo unless told otherwise", async () => {
    const connection = new Connection("http://127.0.0.1:1", "confirmed");
    await new SolanaPaymentVerifier(connection).verify(quote, transferProof);
    await new SolanaPaymentVerifier(connection, { requirePaymentMemo: true }).verify(quote, transferProof);
    await new SolanaPaymentVerifier(connection, { requirePaymentMemo: false }).verify(quote, transferProof);
    expect(captured.map((c) => c.expectedMemo)).toEqual(["quote-memo-hash", "quote-memo-hash", undefined]);
  });

  it("SDK payment verifier (seller and paywall) requires the memo by default", async () => {
    await createPaymentVerifier({ rpcUrl: "http://127.0.0.1:1" }).verify(quote, transferProof);
    await createPaymentVerifier({ rpcUrl: "http://127.0.0.1:1", requirePaymentMemo: false }).verify(quote, transferProof);
    expect(captured.map((c) => c.expectedMemo)).toEqual(["quote-memo-hash", undefined]);
  });
});

describe("x402 header-compat payments are bound to a server-issued quote", () => {
  const config: X402Config = {
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
  const acceptAll = {
    async verify(_quote: unknown, proof: { settlement: string; txSignature?: string }) {
      return { ok: true, settledOnchain: true, txSignature: proof.txSignature };
    },
  };
  const proofFor = (sig: string) => Buffer.from(JSON.stringify({ txSig: sig, scheme: "solana_spl" }), "utf8").toString("base64");

  it("refuses requirements that name a different recipient or amount, or an unknown quote", async () => {
    const { app } = createX402App(config, { paymentVerifier: acceptAll as never });
    const issued = await request(app).get("/resource").expect(402);
    const required = decodeRequired(String(issued.header["payment-required"]));
    expect(required.memo).toBe(issued.body.paymentRequirements.quote.memoHash);
    const attacker = Keypair.generate().publicKey.toBase58();

    for (const forged of [
      { ...required, recipient: attacker },
      { ...required, amountAtomic: "1" },
      { ...required, memo: "f".repeat(64) },
      { ...required, memo: undefined },
    ]) {
      const res = await request(app)
        .get("/resource")
        .set("PAYMENT-REQUIRED", encodeCanonicalRequiredHeader(forged))
        .set("X-PAYMENT", proofFor(`forged-${Math.random().toString(36).slice(2)}-1234567890123456789012345678901234`))
        .expect(409);
      expect(res.body.error.code).toBe("X402_REQUIRED_PROOF_MISMATCH");
    }

    // The unmodified server requirements are accepted.
    await request(app)
      .get("/resource")
      .set("PAYMENT-REQUIRED", String(issued.header["payment-required"]))
      .set("X-PAYMENT", proofFor("genuine-sig-123456789012345678901234567890123456"))
      .expect(200);
  });

  it("refuses requirements issued for a different resource", async () => {
    const { app } = createX402App(config, { paymentVerifier: acceptAll as never });
    const inference = await request(app).get("/inference").expect(402);
    const res = await request(app)
      .get("/resource")
      .set("PAYMENT-REQUIRED", String(inference.header["payment-required"]))
      .set("X-PAYMENT", proofFor("cross-resource-sig-1234567890123456789012345678901"))
      .expect(409);
    expect(res.body.error.code).toBe("X402_REQUIRED_PROOF_MISMATCH");
  });
});
