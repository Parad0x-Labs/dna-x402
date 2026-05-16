import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net, { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { X402Config } from "../src/config.js";
import { marketCall, AgentWallet } from "../src/client.js";
import { verifyQuoteSignature } from "../src/market/quotes.js";
import { PaymentVerifier } from "../src/paymentVerifier.js";
import { ReceiptSigner, verifySignedReceipt } from "../src/receipts.js";
import { createX402App } from "../src/server.js";
import { PaymentProof, Quote } from "../src/types.js";
import { installProgrammabilityFixtures } from "../scripts/audit/programmability/fixtures/install.js";
import { makeSignedShop } from "./market.helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const x402Root = path.resolve(repoRoot, "x402");
const polyglotRoot = path.resolve(x402Root, "labs", "polyglot");

class PolyglotVerifier implements PaymentVerifier {
  async verify(_quote: Quote, paymentProof: PaymentProof) {
    if (paymentProof.settlement === "transfer") {
      const ok = /^(python|browser|rust|js)-transfer-[a-f0-9]{32,}$/i.test(paymentProof.txSignature)
        || /^tx-ok-/.test(paymentProof.txSignature);
      return ok
        ? { ok: true, settledOnchain: true, txSignature: paymentProof.txSignature }
        : { ok: false, settledOnchain: false, error: "polyglot transfer proof rejected" };
    }
    if (paymentProof.settlement === "stream") {
      const ok = /^(python|browser|js)-stream-[a-f0-9]{24,}$/i.test(paymentProof.streamId);
      return ok
        ? { ok: true, settledOnchain: false, streamId: paymentProof.streamId }
        : { ok: false, settledOnchain: false, error: "polyglot stream proof rejected" };
    }
    if (paymentProof.settlement === "netting") {
      return { ok: true, settledOnchain: false };
    }
    return { ok: false, settledOnchain: false, error: "unsupported settlement" };
  }
}

const baseConfig: X402Config = {
  port: 0,
  appVersion: "polyglot-test",
  solanaRpcUrl: "https://api.devnet.solana.com",
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  paymentRecipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
  defaultCurrency: "USDC",
  enabledPricingModels: ["flat", "surge", "stream"],
  marketplaceSelection: "cheapest_sla_else_limit_order",
  quoteTtlSeconds: 120,
  feePolicy: {
    baseFeeAtomic: 0n,
    feeBps: 100,
    minFeeAtomic: 0n,
    accrueThresholdAtomic: 100n,
    minSettleAtomic: 0n,
  },
  nettingThresholdAtomic: 1_000_000n,
  nettingIntervalMs: 10_000,
  pauseMarket: false,
  pauseFinalize: false,
  pauseOrders: false,
  disabledShops: [],
  autoDisableReportThreshold: 0,
  unsafeUnverifiedNettingEnabled: true,
  anchoringEnabled: false,
  allowInsecure: true,
};

async function runJsonProcess<T>(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`process timed out\nstdout=${stdout.trim()}\nstderr=${stderr.trim()}`));
    }, options.timeoutMs ?? 30_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const out = stdout.trim();
      const err = stderr.trim();
      if (code !== 0) {
        reject(new Error(`process failed (${code})\nstdout=${out}\nstderr=${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out) as T);
      } catch (error) {
        reject(new Error(`failed to parse process JSON: ${(error as Error).message}\nstdout=${out}\nstderr=${err}`));
      }
    });
  });
}

function findCargoExe(): string {
  const configured = process.env.CARGO_EXE;
  if (configured && fs.existsSync(configured)) {
    return configured;
  }
  const gLocal = path.resolve(repoRoot, ".tools", "rustup", "cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
  if (fs.existsSync(gLocal)) {
    return gLocal;
  }
  return process.platform === "win32" ? "cargo.exe" : "cargo";
}

function rustEnv(): NodeJS.ProcessEnv {
  const cargoHome = path.resolve(repoRoot, ".tools", "rustup", "cargo");
  const rustupHome = path.resolve(repoRoot, ".tools", "rustup", "rustup-home");
  const rustBin = path.resolve(cargoHome, "bin");
  return {
    ...process.env,
    CARGO_HOME: cargoHome,
    RUSTUP_HOME: rustupHome,
    PATH: `${rustBin}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

function jsWallet(agentId: string): AgentWallet {
  return {
    async payTransfer(quote) {
      return {
        settlement: "transfer",
        txSignature: `js-transfer-${Buffer.from(`${agentId}:${quote.quoteId}`).toString("hex").padEnd(64, "0")}`,
        amountAtomic: quote.totalAtomic,
      };
    },
    async payNetted(quote) {
      return {
        settlement: "netting",
        amountAtomic: quote.totalAtomic,
        note: `js-agent:${agentId}`,
      };
    },
    async payStream(quote) {
      return {
        settlement: "stream",
        streamId: `js-stream-${Buffer.from(`${agentId}:${quote.quoteId}`).toString("hex").slice(0, 40).padEnd(40, "0")}`,
        amountAtomic: quote.totalAtomic,
      };
    },
  };
}

async function registerShop(app: ReturnType<typeof createX402App>["app"], params: Parameters<typeof makeSignedShop>[0]) {
  const response = await request(app).post("/market/shops").send(makeSignedShop(params)).expect(201);
  expect(response.body.ok).toBe(true);
}

describe("polyglot programmable agent lab", () => {
  let app: ReturnType<typeof createX402App>["app"];
  let server: net.Server;
  let baseUrl = "";

  beforeAll(async () => {
    const created = createX402App(baseConfig, {
      paymentVerifier: new PolyglotVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });
    app = created.app;
    installProgrammabilityFixtures(app, created.context);

    await registerShop(app, {
      shopId: "browser-agent-alpha",
      name: "Browser Agent Alpha",
      description: "Browser-style seller agent exposing a paid x402 tool.",
      category: "workflow_tool",
      capability: "browser_agent_service",
      endpointId: "browser-agent-alpha-tool",
      path: "/programmability/fixed-price",
      priceAtomic: "1200",
      settlementModes: ["transfer"],
      maxLatencyMs: 700,
    });

    await registerShop(app, {
      shopId: "momentum-strategy-js",
      name: "Momentum Strategy JS",
      description: "Trading signal strategy sold as a paid programmable tool.",
      category: "workflow_tool",
      capability: "trading_signal",
      endpointId: "momentum-signal",
      path: "/programmability/usage-metered?units=3",
      pricingModel: {
        kind: "surge",
        baseAmountAtomic: "1300",
        minMultiplier: 0.8,
        maxMultiplier: 1.4,
      },
      settlementModes: ["transfer", "netting"],
      maxLatencyMs: 600,
    });

    await registerShop(app, {
      shopId: "risk-hedge-rust",
      name: "Risk Hedge Rust",
      description: "Lower-cost risk filter strategy for route-next marketplace policies.",
      category: "workflow_tool",
      capability: "trading_signal",
      endpointId: "risk-filter",
      path: "/programmability/fixed-price",
      priceAtomic: "900",
      settlementModes: ["transfer"],
      maxLatencyMs: 900,
    });

    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 20_000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("lets a raw Python agent buy from the JS x402 seller and move auction/binary-market state", async () => {
    const script = path.resolve(polyglotRoot, "python_agent.py");

    const auction = await runJsonProcess<{
      ok: boolean;
      agentLanguage: string;
      settlement: string;
      fixtureId: string;
      receiptId: string;
      output: { winningBidAtomic: string };
    }>("python", [
      script,
      "--base-url", baseUrl,
      "--resource", "/programmability/english-auction",
      "--agent-id", "python-bidder-1",
      "--settlement", "transfer",
    ], { cwd: repoRoot, timeoutMs: 30_000 });

    expect(auction.ok).toBe(true);
    expect(auction.agentLanguage).toBe("python");
    expect(auction.fixtureId).toBe("english_auction");
    expect(auction.output.winningBidAtomic).toBe("2150");
    expect(auction.receiptId).toMatch(/^[0-9a-f-]{36}$/);

    const prediction = await runJsonProcess<{
      ok: boolean;
      settlement: string;
      fixtureId: string;
      output: { side: string; yesShares: number; noShares: number };
    }>("python", [
      script,
      "--base-url", baseUrl,
      "--resource", "/programmability/prediction-binary?side=yes",
      "--agent-id", "python-prediction-yes",
      "--settlement", "netting",
    ], { cwd: repoRoot, timeoutMs: 30_000 });

    expect(prediction.ok).toBe(true);
    expect(prediction.settlement).toBe("netting");
    expect(prediction.fixtureId).toBe("prediction_market_binary");
    expect(prediction.output).toMatchObject({ side: "yes", yesShares: 1, noShares: 0 });
  }, 30_000);

  it("lets a compiled Rust agent discover a browser-agent shop and pay its x402 endpoint", async () => {
    const cargo = findCargoExe();
    const manifest = path.resolve(polyglotRoot, "rust-agent", "Cargo.toml");
    const result = await runJsonProcess<{
      ok: boolean;
      agentLanguage: string;
      marketQuote: { shopId: string; endpointId: string };
      resource: string;
      fixtureId: string;
      receiptId: string;
    }>(cargo, [
      "run",
      "--quiet",
      "--manifest-path", manifest,
      "--",
      "--base-url", baseUrl,
      "--market-capability", "browser_agent_service",
      "--agent-id", "rust-buyer-1",
    ], { cwd: repoRoot, env: rustEnv(), timeoutMs: 60_000 });

    expect(result.ok).toBe(true);
    expect(result.agentLanguage).toBe("rust");
    expect(result.marketQuote).toMatchObject({
      shopId: "browser-agent-alpha",
      endpointId: "browser-agent-alpha-tool",
    });
    expect(result.resource).toBe("/programmability/fixed-price");
    expect(result.fixtureId).toBe("fixed_price_tool");
    expect(result.receiptId).toMatch(/^[0-9a-f-]{36}$/);
  }, 90_000);

  it("runs a browser-style JS agent through a trading strategy market order and paid execution", async () => {
    const script = path.resolve(polyglotRoot, "browser_agent.mjs");
    const result = await runJsonProcess<{
      ok: boolean;
      agentLanguage: string;
      marketQuote: { shopId: string; endpointId: string; price: string };
      order: { orderId: string; status: string };
      resource: string;
      fixtureId: string;
      receiptId: string;
      output: Record<string, unknown>;
    }>(process.execPath, [
      script,
      "--base-url", baseUrl,
      "--market-capability", "trading_signal",
      "--create-order",
      "--max-price", "5000",
      "--agent-id", "browser-trader-1",
      "--settlement", "transfer",
    ], { cwd: repoRoot, timeoutMs: 30_000 });

    expect(result.ok).toBe(true);
    expect(result.agentLanguage).toBe("browser-js");
    expect(result.order.status).toBe("executed");
    expect(["momentum-strategy-js", "risk-hedge-rust"]).toContain(result.marketQuote.shopId);
    expect(result.fixtureId).toMatch(/fixed_price_tool|usage_metered_tool/);
    expect(result.receiptId).toMatch(/^[0-9a-f-]{36}$/);
  }, 40_000);

  it("proves trading strategy marketplace selection with the TypeScript SDK path too", async () => {
    const result = await marketCall({
      marketBaseUrl: baseUrl,
      resourceBaseUrl: baseUrl,
      wallet: jsWallet("ts-trader-1"),
      marketPolicy: {
        capability: "trading_signal",
        maxPrice: 5000,
        maxLatencyMs: 1200,
        prefer: ["lowest_price", "high_reputation"],
        settlement: {
          allowNetting: false,
        },
        budget: {
          maxPerCall: 5000,
          maxPerDay: 10000,
        },
      },
    });

    expect(result.response.status).toBe(200);
    expect(result.provider.shopId).toBe("risk-hedge-rust");
    expect(result.receipt && verifySignedReceipt(result.receipt)).toBe(true);
    expect(result.selectedQuote.capabilityTags).toContain("trading_signal");
  }, 20_000);

  it("allows safe third-party shop onboarding without admin while blocking public betting/wager listings", async () => {
    const safeShop = makeSignedShop({
      shopId: "third-party-data-agent",
      name: "Third Party Data Agent",
      description: "External data enrichment agent joining through signed manifest only.",
      category: "data_enrichment",
      capability: "external_data_enrichment",
      endpointId: "external-data",
      path: "/programmability/fixed-price",
      priceAtomic: "700",
      settlementModes: ["transfer"],
      maxLatencyMs: 1000,
    });

    await request(app).post("/market/shops").send(safeShop).expect(201);
    const search = await request(app)
      .get("/market/search")
      .query({ capability: "external_data_enrichment", maxPrice: "1000" })
      .expect(200);
    expect(search.body.results).toHaveLength(1);
    expect(search.body.results[0].shopId).toBe("third-party-data-agent");

    const quotes = await request(app)
      .get("/market/quotes")
      .query({ capability: "external_data_enrichment", maxPrice: "1000" })
      .expect(200);
    expect(quotes.body.quotes).toHaveLength(1);
    expect(verifyQuoteSignature(quotes.body.quotes[0], quotes.body.signerPublicKey)).toBe(true);

    const blocked = await request(app).post("/market/shops").send(makeSignedShop({
      shopId: "sports-betting-agent",
      name: "Sports Betting Agent",
      description: "Public betting, wager, and odds automation.",
      category: "workflow_tool",
      capability: "odds_feed",
      endpointId: "wager-endpoint",
      path: "/programmability/prediction-binary",
      priceAtomic: "1000",
      settlementModes: ["transfer"],
      maxLatencyMs: 1000,
    })).expect(422);

    expect(blocked.body).toMatchObject({
      ok: false,
      error: "POLICY_BLOCKED",
      reason: "denylist_match",
    });
  }, 20_000);
});
