import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { X402Config } from "../src/config.js";
import { createPostgresClientFromEnv, databaseUrlFromEnv } from "../src/db/connection.js";
import { PaymentVerifier } from "../src/paymentVerifier.js";
import { ReceiptSigner } from "../src/receipts.js";
import { createReplayStore, createX402App } from "../src/server.js";
import { PaymentProof, Quote } from "../src/types.js";
import { DurableReplayBackend, PostgresReplayBackend, ReplayStore } from "../src/verifier/replayStore.js";

const liveDatabaseUrl = databaseUrlFromEnv();
const postgresAvailable = Boolean(liveDatabaseUrl);

class AcceptingVerifier implements PaymentVerifier {
  async verify(_quote: Quote, paymentProof: PaymentProof) {
    if (paymentProof.settlement === "transfer") {
      return { ok: true, settledOnchain: true, txSignature: paymentProof.txSignature };
    }
    return { ok: false, settledOnchain: false, error: "unsupported" };
  }
}

const baseConfig: X402Config = {
  port: 0,
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
    feeBps: 0,
    minFeeAtomic: 0n,
    accrueThresholdAtomic: 100n,
    minSettleAtomic: 0n,
  },
  nettingThresholdAtomic: 1000n,
  nettingIntervalMs: 1000,
  pauseMarket: false,
  pauseFinalize: false,
  pauseOrders: false,
  disabledShops: [],
  autoDisableReportThreshold: 0,
  allowInsecure: true,
};

// Shared-map backend: models a store that outlives one ReplayStore instance, to
// check the ReplayStore wiring without a database. The Postgres suite below runs
// the same flow against a real server.
class SharedMapBackend implements DurableReplayBackend {
  readonly kind = "shared-map";
  constructor(private readonly rows: Map<string, number>) {}
  async claim(key: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    const existing = this.rows.get(key);
    if (existing !== undefined && existing > nowMs) return false;
    this.rows.set(key, expiresAtMs);
    return true;
  }
  async has(key: string, nowMs: number): Promise<boolean> {
    const existing = this.rows.get(key);
    return existing !== undefined && existing > nowMs;
  }
}

describe("ReplayStore wiring", () => {
  it("in-memory store claims a key once", async () => {
    const store = new ReplayStore({ env: { NODE_ENV: "test" } });
    expect(store.kind).toBe("memory");
    expect(store.durable).toBe(false);
    expect(await store.claim("k1", 1_000)).toBe(true);
    expect(await store.claim("k1", 1_001)).toBe(false);
    expect(await store.isClaimed("k1", 1_002)).toBe(true);
    expect(store.consume("k2", 1_000)).toBe(true);
    expect(store.consume("k2", 1_000)).toBe(false);
  });

  it("refuses an in-memory store in production", () => {
    expect(() => new ReplayStore({ env: { NODE_ENV: "production" } })).toThrow(/durable replay protection is required in production/);
  });

  it("allows a durable backend in production and refuses the synchronous in-memory API", () => {
    const store = new ReplayStore({ backend: new SharedMapBackend(new Map()), env: { NODE_ENV: "production" } });
    expect(store.durable).toBe(true);
    expect(() => store.consume("k", 1)).toThrow(/in-memory only/);
    expect(() => store.has("k", 1)).toThrow(/in-memory only/);
  });

  it("a claim recorded in the backend is refused by a new store instance (restart)", async () => {
    const rows = new Map<string, number>();
    const first = new ReplayStore({ backend: new SharedMapBackend(rows) });
    expect(await first.claim("proof-1", 10_000)).toBe(true);
    const afterRestart = new ReplayStore({ backend: new SharedMapBackend(rows) });
    expect(await afterRestart.isClaimed("proof-1", 10_001)).toBe(true);
    expect(await afterRestart.claim("proof-1", 10_001)).toBe(false);
  });

  it("server selects the Postgres replay store when a database URL is configured", async () => {
    const store = createReplayStore({ ...baseConfig, databaseUrl: "postgres://user:pass@127.0.0.1:1/none" });
    expect(store.kind).toBe("postgres");
    expect(store.durable).toBe(true);
    await store.close();
    const memory = createReplayStore(baseConfig);
    expect(memory.kind).toBe("memory");
  });

  it("server refuses to start in production without a database URL", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => createReplayStore(baseConfig)).toThrow(/X402_DATABASE_URL or DATABASE_URL/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe.skipIf(!postgresAvailable)("ReplayStore with live Postgres", () => {
  const table = `x402_replay_test_${process.pid}`;
  const opened: ReplayStore[] = [];
  const open = () => {
    const store = new ReplayStore({ backend: new PostgresReplayBackend(createPostgresClientFromEnv(), table) });
    opened.push(store);
    return store;
  };

  afterAll(async () => {
    const db = createPostgresClientFromEnv();
    await db.query(`drop table if exists ${table}`);
    await db.query("drop table if exists x402_payment_replay_keys");
    await db.close();
    for (const store of opened) await store.close().catch(() => undefined);
  });

  it("rejects a replay after a restart (new process state, same database)", async () => {
    const key = `restart-${Date.now()}`;
    const first = open();
    expect(await first.claim(key)).toBe(true);
    await first.close();

    const afterRestart = open();
    expect(afterRestart.size()).toBe(0);
    expect(await afterRestart.isClaimed(key)).toBe(true);
    expect(await afterRestart.claim(key)).toBe(false);
  });

  it("admits exactly one of 20 concurrent claims across two instances", async () => {
    const key = `race-${Date.now()}`;
    const a = open();
    const b = open();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).claim(key)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("lets an expired key be claimed again", async () => {
    const key = `ttl-${Date.now()}`;
    const short = new ReplayStore({ ttlMs: 1_000, backend: new PostgresReplayBackend(createPostgresClientFromEnv(), table) });
    opened.push(short);
    expect(await short.claim(key, 1_000_000)).toBe(true);
    const later = open();
    expect(await later.claim(key, 1_000_500)).toBe(false);
    const muchLater = new ReplayStore({ ttlMs: 1_000, backend: new PostgresReplayBackend(createPostgresClientFromEnv(), table) });
    opened.push(muchLater);
    expect(await muchLater.claim(key, 1_002_000)).toBe(true);
  });

  it("x402 server rejects the same payment proof after a restart", async () => {
    const config: X402Config = { ...baseConfig, databaseUrl: liveDatabaseUrl };
    const txSignature = `restart-sig-${Date.now()}-1234567890123456789012345678`;

    async function payOnce(app: Parameters<typeof request>[0]) {
      const required = await request(app).get("/resource").expect(402);
      const quoteId = required.body.paymentRequirements.quote.quoteId as string;
      const commit = await request(app)
        .post("/commit")
        .send({ quoteId, payerCommitment32B: "0x" + "42".repeat(32) })
        .expect(201);
      return request(app)
        .post("/finalize")
        .send({
          commitId: commit.body.commitId as string,
          paymentProof: { settlement: "transfer", txSignature, amountAtomic: required.body.paymentRequirements.quote.totalAtomic },
        });
    }

    const first = createX402App(config, { paymentVerifier: new AcceptingVerifier(), receiptSigner: ReceiptSigner.generate() });
    opened.push(first.context.replayStore);
    expect(first.context.replayStore.kind).toBe("postgres");
    expect((await payOnce(first.app)).status).toBe(200);
    await first.context.replayStore.close();

    // New process state: fresh quotes, commits and replay cache; same database.
    const restarted = createX402App(config, { paymentVerifier: new AcceptingVerifier(), receiptSigner: ReceiptSigner.generate() });
    opened.push(restarted.context.replayStore);
    expect(restarted.context.replayStore.size()).toBe(0);
    const replay = await payOnce(restarted.app);
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe("X402_REPLAY_DETECTED");
  });
});
