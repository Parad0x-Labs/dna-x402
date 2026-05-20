import bs58 from "bs58";
import nacl from "tweetnacl";
import request from "supertest";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { X402Config } from "../src/config.js";
import { PaymentVerifier } from "../src/paymentVerifier.js";
import { ReceiptSigner } from "../src/receipts.js";
import { createX402App } from "../src/server.js";
import { PaymentProof, Quote } from "../src/types.js";

class NullDepositVerifier implements PaymentVerifier {
  constructor(
    private readonly expectedMint: string,
    private readonly expectedRecipient: string,
  ) {}

  async verify(quote: Quote, proof: PaymentProof) {
    if (proof.settlement !== "transfer") {
      return { ok: false, settledOnchain: false, errorCode: "PAYMENT_INVALID" as const, error: "transfer required" };
    }
    if (quote.mint !== this.expectedMint) {
      return { ok: false, settledOnchain: false, errorCode: "WRONG_MINT" as const, error: "wrong mint" };
    }
    if (quote.recipient !== this.expectedRecipient) {
      return { ok: false, settledOnchain: false, errorCode: "WRONG_RECIPIENT" as const, error: "wrong recipient" };
    }
    if (proof.txSignature.startsWith("tx-ok-null-deposit-")) {
      return { ok: true, settledOnchain: true, txSignature: proof.txSignature };
    }
    return { ok: false, settledOnchain: false, errorCode: "INVALID_PROOF" as const, error: "bad proof" };
  }
}

const nullMint = Keypair.generate().publicKey.toBase58();
const nullVault = Keypair.generate().publicKey.toBase58();

const baseConfig: X402Config = {
  port: 8080,
  appVersion: "tip-ledger-test",
  solanaRpcUrl: "https://api.devnet.solana.com",
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  paymentRecipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
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
  pauseMarket: false,
  pauseFinalize: false,
  pauseOrders: false,
  disabledShops: [],
  autoDisableReportThreshold: 0,
  adminSecret: "tip-ledger-admin-secret-123456",
  allowInsecure: false,
  nullTips: {
    tokenMint: nullMint,
    vaultAddress: nullVault,
    tokenSymbol: "NULL",
    decimals: 6,
    sessionSecret: "tip-ledger-session-secret-123456",
    maxSendAtomic: "1000000000",
    maxWithdrawAtomic: "1000000000",
  },
};

function signMessage(keypair: Keypair, message: string): string {
  return bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey));
}

async function sessionToken(app: ReturnType<typeof makeApp>["app"], keypair: Keypair): Promise<string> {
  const ownerWallet = keypair.publicKey.toBase58();
  const challenge = await request(app)
    .post("/api/tips/session/challenge")
    .send({ ownerWallet })
    .expect(201);
  const verified = await request(app)
    .post("/api/tips/session/verify")
    .send({
      ownerWallet,
      challengeId: challenge.body.challenge.challengeId,
      signature: signMessage(keypair, challenge.body.challenge.message),
    })
    .expect(200);
  return verified.body.token as string;
}

function makeApp() {
  return createX402App(baseConfig, {
    receiptSigner: ReceiptSigner.generate(),
    paymentVerifier: new NullDepositVerifier(nullMint, nullVault),
  });
}

describe("NULL tip ledger", () => {
  it("requires signed wallet sessions before exposing balances or sends", async () => {
    const { app } = makeApp();
    await request(app).get("/api/tips/balance").expect(401);

    const wallet = Keypair.generate();
    const token = await sessionToken(app, wallet);
    const balance = await request(app)
      .get("/api/tips/balance")
      .set("authorization", `Bearer ${token}`)
      .expect(200);
    expect(balance.body.account.ownerWallet).toBe(wallet.publicKey.toBase58());
    expect(balance.body.account.balanceAtomic).toBe("0");
  });

  it("credits NULL deposits only after proof verification and blocks replay", async () => {
    const { app } = makeApp();
    const wallet = Keypair.generate();
    const token = await sessionToken(app, wallet);

    const intent = await request(app)
      .post("/api/tips/deposit-intent")
      .set("authorization", `Bearer ${token}`)
      .send({ amountAtomic: "2500000" })
      .expect(201);
    expect(intent.body.instructions.vaultAddress).toBe(nullVault);

    const confirmed = await request(app)
      .post("/api/tips/deposit-confirm")
      .set("authorization", `Bearer ${token}`)
      .send({
        depositIntentId: intent.body.intent.intentId,
        txSignature: "tx-ok-null-deposit-123456789012345678901234",
        amountAtomic: "2500000",
      })
      .expect(200);
    expect(confirmed.body.account.balanceAtomic).toBe("2500000");

    const repeated = await request(app)
      .post("/api/tips/deposit-confirm")
      .set("authorization", `Bearer ${token}`)
      .send({
        depositIntentId: intent.body.intent.intentId,
        txSignature: "tx-ok-null-deposit-123456789012345678901234",
        amountAtomic: "2500000",
      })
      .expect(200);
    expect(repeated.body.account.balanceAtomic).toBe("2500000");

    const secondIntent = await request(app)
      .post("/api/tips/deposit-intent")
      .set("authorization", `Bearer ${token}`)
      .send({ amountAtomic: "1" })
      .expect(201);
    await request(app)
      .post("/api/tips/deposit-confirm")
      .set("authorization", `Bearer ${token}`)
      .send({
        depositIntentId: secondIntent.body.intent.intentId,
        txSignature: "tx-ok-null-deposit-123456789012345678901234",
        amountAtomic: "1",
      })
      .expect(409);
  });

  it("posts sender/recipient ledger rows without trusting a client-selected sender", async () => {
    const { app } = makeApp();
    const sender = Keypair.generate();
    const recipient = Keypair.generate();
    const recipientNotEnrolled = Keypair.generate();
    const attacker = Keypair.generate();
    const senderToken = await sessionToken(app, sender);
    const attackerToken = await sessionToken(app, attacker);
    const recipientToken = await sessionToken(app, recipient);
    await request(app)
      .get("/api/tips/balance")
      .set("authorization", `Bearer ${recipientToken}`)
      .expect(200);

    await request(app)
      .post("/api/admin/tips/adjust")
      .set("x-admin-token", baseConfig.adminSecret!)
      .send({
        ownerWallet: sender.publicKey.toBase58(),
        direction: "credit",
        amountAtomic: "1000000",
        reason: "seed sender tip balance for test",
      })
      .expect(200);

    await request(app)
      .post("/api/tips/send")
      .set("authorization", `Bearer ${attackerToken}`)
      .send({
        fromOwnerWallet: sender.publicKey.toBase58(),
        toOwnerWallet: recipient.publicKey.toBase58(),
        amountAtomic: "1000",
      })
      .expect(402)
      .expect((res) => {
        expect(res.body.error).toBe("TIP_INSUFFICIENT_BALANCE");
      });

    await request(app)
      .post("/api/tips/send")
      .set("authorization", `Bearer ${senderToken}`)
      .send({
        toOwnerWallet: recipientNotEnrolled.publicKey.toBase58(),
        amountAtomic: "1000",
        memo: "should-fail-before-recipient-enrolls",
      })
      .expect(404)
      .expect((res) => {
        expect(res.body.error).toBe("TIP_RECIPIENT_NOT_ENROLLED");
      });

    const sent = await request(app)
      .post("/api/tips/send")
      .set("authorization", `Bearer ${senderToken}`)
      .send({
        fromOwnerWallet: attacker.publicKey.toBase58(),
        toOwnerWallet: recipient.publicKey.toBase58(),
        amountAtomic: "1000",
        memo: "first NULL tip",
      })
      .expect(201);
    expect(sent.body.sender.ownerWallet).toBe(sender.publicKey.toBase58());
    expect(sent.body.sender.balanceAtomic).toBe("999000");
    expect(sent.body.recipient.balanceAtomic).toBe("1000");
    expect(sent.body.ledger).toHaveLength(2);

    const ledger = await request(app)
      .get("/api/tips/ledger")
      .set("authorization", `Bearer ${senderToken}`)
      .expect(200);
    expect(ledger.body.ledger.some((item: { eventType: string }) => item.eventType === "tip_sent")).toBe(true);
  });

  it("exposes recipient tip-account readiness for chat gift-icon gating", async () => {
    const { app } = makeApp();
    const wallet = Keypair.generate();
    const ownerWallet = wallet.publicKey.toBase58();

    await request(app)
      .get("/api/tips/account-status")
      .query({ wallet: ownerWallet })
      .expect(200)
      .expect((res) => {
        expect(res.body.hasTipAccount).toBe(false);
        expect(res.body.canReceiveTips).toBe(false);
      });

    await request(app)
      .get(`/api/tips/account/${ownerWallet}/status`)
      .expect(200)
      .expect((res) => {
        expect(res.body.hasTipAccount).toBe(false);
      });

    await sessionToken(app, wallet);

    await request(app)
      .get("/api/tips/account-status")
      .query({ ownerWallet })
      .expect(200)
      .expect((res) => {
        expect(res.body.hasTipAccount).toBe(true);
        expect(res.body.canReceiveTips).toBe(true);
      });

    await request(app)
      .get(`/api/tips/account/${ownerWallet}/status`)
      .expect(200)
      .expect((res) => {
        expect(res.body.hasTipAccount).toBe(true);
      });
  });

  it("locks withdrawal requests and pauses withdrawals on reconciliation mismatch", async () => {
    const { app } = makeApp();
    const wallet = Keypair.generate();
    const token = await sessionToken(app, wallet);

    await request(app)
      .post("/api/admin/tips/adjust")
      .set("x-admin-token", baseConfig.adminSecret!)
      .send({
        ownerWallet: wallet.publicKey.toBase58(),
        direction: "credit",
        amountAtomic: "100000",
        reason: "seed withdrawal balance",
      })
      .expect(200);

    const withdrawal = await request(app)
      .post("/api/tips/withdraw")
      .set("authorization", `Bearer ${token}`)
      .send({
        recipientWallet: wallet.publicKey.toBase58(),
        amountAtomic: "25000",
      })
      .expect(202);
    expect(withdrawal.body.account.balanceAtomic).toBe("75000");
    expect(withdrawal.body.account.pendingWithdrawalAtomic).toBe("25000");

    const mismatch = await request(app)
      .post("/api/admin/tips/reconcile")
      .set("x-admin-token", baseConfig.adminSecret!)
      .send({ vaultBalanceAtomic: "99999" })
      .expect(200);
    expect(mismatch.body.ok).toBe(false);
    expect(mismatch.body.withdrawalsPaused).toBe(true);

    await request(app)
      .post("/api/tips/withdraw")
      .set("authorization", `Bearer ${token}`)
      .send({
        recipientWallet: wallet.publicKey.toBase58(),
        amountAtomic: "1",
      })
      .expect(503)
      .expect((res) => {
        expect(res.body.error).toBe("TIP_WITHDRAWALS_PAUSED");
      });
  });

  it("rejects private-key shaped payloads on tip mutation routes", async () => {
    const { app } = makeApp();
    const wallet = Keypair.generate();
    const token = await sessionToken(app, wallet);

    await request(app)
      .post("/api/tips/deposit-intent")
      .set("authorization", `Bearer ${token}`)
      .send({ amountAtomic: "1", privateKey: "never-send-this" })
      .expect(400)
      .expect((res) => {
        expect(res.body.error).toBe("PRIVATE_KEY_FORBIDDEN");
      });
  });
});
