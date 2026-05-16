import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { X402Config, loadConfig, validateRuntimeGateConfig } from "../src/config.js";
import {
  alertmanagerWebhookPayloadSchema,
  formatTelegramAlertMessage,
  formatTelegramStatusDigest,
  isTelegramUpdateAllowed,
  redactTelegramChatId,
  redactTelegramToken,
  relayAlertmanagerToTelegram,
  sendTelegramStatusDigest,
} from "../src/monitoring/telegramAlert.js";
import { createX402App } from "../src/server.js";

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
    feeBps: 50,
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

const alertPayload = alertmanagerWebhookPayloadSchema.parse({
  receiver: "telegram-ops",
  status: "firing",
  alerts: [{
    status: "firing",
    labels: {
      alertname: "X402EmergencyPauseActive",
      severity: "critical",
      environment: "staging",
    },
    annotations: {
      summary: "Emergency pause is active.",
    },
    startsAt: "2026-05-15T12:00:00.000Z",
  }],
});

describe("Telegram ops alert route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("requires full Telegram alert config when enabled", () => {
    const config = loadConfig({
      X402_ALERT_TELEGRAM_ENABLED: "1",
      X402_ALERT_TELEGRAM_BOT_TOKEN: "123456:test-token",
      X402_ALERT_TELEGRAM_CHAT_ID: "-1001234567890",
    });

    expect(validateRuntimeGateConfig(config)).toEqual(expect.arrayContaining([
      "X402_ALERT_TELEGRAM_RELAY_SECRET must be set and at least 24 characters when Telegram alerts are enabled.",
    ]));
  });

  it("requires user and chat allowlists before Telegram commands can be enabled", () => {
    const unsafe = loadConfig({
      X402_ALERT_TELEGRAM_ENABLED: "1",
      X402_ALERT_TELEGRAM_BOT_TOKEN: "123456:test-token",
      X402_ALERT_TELEGRAM_CHAT_ID: "-1001234567890",
      X402_ALERT_TELEGRAM_RELAY_SECRET: "telegram-relay-secret-1234567890",
      X402_ALERT_TELEGRAM_COMMANDS_ENABLED: "1",
    });

    expect(validateRuntimeGateConfig(unsafe)).toEqual(expect.arrayContaining([
      "X402_ALERT_TELEGRAM_ALLOWED_USER_IDS or X402_ALERT_TELEGRAM_ALLOWED_ADMIN_IDS is required when Telegram commands are enabled.",
      "X402_ALERT_TELEGRAM_ALLOWED_CHAT_IDS is required when Telegram commands are enabled.",
    ]));
  });

  it("allows only owner or trusted admin Telegram users in allowed chats", () => {
    const access = {
      commandsEnabled: true,
      allowedUserIds: ["111"],
      allowedAdminIds: ["222"],
      allowedChatIds: ["-100"],
    };

    expect(isTelegramUpdateAllowed({
      message: { from: { id: 111 }, chat: { id: -100 } },
    }, access)).toMatchObject({ ok: true, role: "owner" });
    expect(isTelegramUpdateAllowed({
      message: { from: { id: 222 }, chat: { id: -100 } },
    }, access)).toMatchObject({ ok: true, role: "admin" });
    expect(isTelegramUpdateAllowed({
      message: { from: { id: 333 }, chat: { id: -100 } },
    }, access)).toMatchObject({ ok: false, reason: "user_not_allowed" });
    expect(isTelegramUpdateAllowed({
      message: { from: { id: 111 }, chat: { id: -200 } },
    }, access)).toMatchObject({ ok: false, reason: "chat_not_allowed" });
    expect(isTelegramUpdateAllowed({
      message: { from: { id: 111 }, chat: { id: -100 } },
    }, { ...access, commandsEnabled: false })).toMatchObject({ ok: false, reason: "commands_disabled" });
  });

  it("redacts tokens and chat IDs from delivery results", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: {
        message_id: 777,
      },
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const result = await relayAlertmanagerToTelegram({
      config: {
        botToken: "123456:super-secret-token",
        chatId: "-1001234567890",
        parseMode: "HTML",
        environment: "staging",
      },
      payload: alertPayload,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("super-secret-token");
    expect(JSON.stringify(result)).not.toContain("-1001234567890");
    expect(result.delivered[0]?.chatIdRedacted).toBe(redactTelegramChatId("-1001234567890"));
    expect(redactTelegramToken("123456:super-secret-token")).toMatch(/^REDACTED:/);
  });

  it("escapes alert text before HTML formatting", () => {
    const message = formatTelegramAlertMessage({
      alert: {
        labels: { alertname: "X402PiiBlock", severity: "critical" },
        annotations: { summary: "<script>alert('x')</script>" },
        startsAt: "2026-05-15T12:00:00.000Z",
      },
      environment: "staging",
    });

    expect(message).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(message).not.toContain("<script>");
  });

  it("formats and sends status digest without leaking Telegram secrets", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: {
        message_id: 778,
      },
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const metrics = {
      online: true,
      environment: "staging",
      period: "30m" as const,
      metricsUrl: "http://127.0.0.1:8080/metrics",
      quotesCreated: 10,
      commitsCreated: 8,
      finalizeSuccess: 7,
      finalizeRejected: 1,
      receiptsIssued: 7,
      volumeAtomic: 500000,
      feeAccruals: 2,
      feeAccruedAtomic: 500,
      agentsObserved: 3,
      webhookReplayRejected: 1,
      piiBlocks: 1,
      emergencyPauseActive: 0,
      adminActions: 2,
      dbErrors: 0,
      verifierErrors: 1,
      settlementUnavailable: 0,
    };
    const message = formatTelegramStatusDigest(metrics);
    const result = await sendTelegramStatusDigest({
      config: {
        botToken: "123456:super-secret-token",
        chatId: "-1001234567890",
        parseMode: "HTML",
      },
      metrics,
      fetchImpl,
    });

    expect(message).toContain("DNA x402 Engine Status");
    expect(message).toContain("Agents observed:</b> 3");
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("super-secret-token");
    expect(JSON.stringify(result)).not.toContain("-1001234567890");
  });

  it("returns 404 when the internal Telegram route is disabled", async () => {
    const { app } = createX402App(baseConfig);
    await request(app).post("/internal/alerts/telegram").send(alertPayload).expect(404);
  });

  it("exposes digest-ready volume, fee, and agent metrics", async () => {
    const { app, context } = createX402App(baseConfig);
    context.observedAgentIds.add("agent-1");
    context.realChainFeeAccruals.push({
      id: "fee-1",
      quoteId: "quote-1",
      commitId: "commit-1",
      receiptId: "receipt-1",
      resource: "/resource",
      payerCommitment32B: "0x" + "11".repeat(32),
      amountAtomic: "50000",
      platformFeeBps: 10,
      platformFeeAtomic: "50",
      platformRecipient: "treasury",
      settlement: "transfer",
      createdAt: "2026-05-15T12:00:00.000Z",
      collected: false,
      status: "ACCRUED_NOT_COLLECTED",
      note: "test",
    });
    context.auditLog.record({
      kind: "PAYMENT_VERIFIED",
      amountAtomic: "50000",
    });

    const response = await request(app).get("/metrics").expect(200);
    expect(response.text).toContain("x402_volume_atomic_total 50000");
    expect(response.text).toContain("x402_agents_observed_total 1");
    expect(response.text).toContain("x402_real_chain_fee_accruals_total 1");
    expect(response.text).toContain("x402_real_chain_fee_accrued_atomic_total 50");
  });

  it("requires the relay shared secret when enabled", async () => {
    const { app } = createX402App({
      ...baseConfig,
      telegramAlerts: {
        enabled: true,
        botToken: "123456:test-token",
        chatId: "-1001234567890",
        parseMode: "HTML",
        relaySecret: "telegram-relay-secret-1234567890",
      },
    });

    await request(app).post("/internal/alerts/telegram").send(alertPayload).expect(403);
  });

  it("rejects PII before Telegram immutable alert log delivery", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { app } = createX402App({
      ...baseConfig,
      telegramAlerts: {
        enabled: true,
        botToken: "123456:test-token",
        chatId: "-1001234567890",
        parseMode: "HTML",
        relaySecret: "telegram-relay-secret-1234567890",
      },
    });
    const piiPayload = alertmanagerWebhookPayloadSchema.parse({
      receiver: "telegram-ops",
      status: "firing",
      alerts: [{
        status: "firing",
        labels: { alertname: "X402PiiBlock", severity: "critical" },
        annotations: { summary: "Contact owner@example.com" },
        startsAt: "2026-05-15T12:00:00.000Z",
      }],
    });

    await request(app)
      .post("/internal/alerts/telegram")
      .set("x-alert-relay-secret", "telegram-relay-secret-1234567890")
      .send(piiPayload)
      .expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
