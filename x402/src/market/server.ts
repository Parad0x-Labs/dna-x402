import express from "express";
import cors from "cors";
import { z } from "zod";
import { ReceiptSigner } from "../receipts.js";
import { createMarketEvent, validateMarketEvent } from "./events.js";
import { computeEndpointBadges, computeShopBadges } from "./badges.js";
import { MarketAnalytics, parseWindow } from "./analytics.js";
import { MarketEventBus } from "./eventBus.js";
import { HeartbeatIndex } from "./heartbeat.js";
import { BundleExecutor } from "./bundleExecutor.js";
import { BundleRegistry, validateSignedBundleManifest } from "./bundles.js";
import { validateManifest, validateSignedManifest, ManifestValidationError } from "./manifest.js";
import { importMcpTools } from "./import/mcp.js";
import { importOpenApiSpec } from "./import/openapi.js";
import { MarketOrders } from "./orders.js";
import { QuoteBook } from "./quotes.js";
import { ReputationEngine } from "./reputation.js";
import { MarketRegistry } from "./registry.js";
import { MarketStorage } from "./storage.js";
import { MarketEvent, MarketOrder, MarketOrderInput, SignedShopManifest } from "./types.js";

interface CreateMarketDeps {
  now?: () => Date;
  signer?: ReceiptSigner;
  registry?: MarketRegistry;
  bundles?: BundleRegistry;
  bundleExecutor?: BundleExecutor;
  heartbeat?: HeartbeatIndex;
  quoteBook?: QuoteBook;
  orders?: MarketOrders;
  storage?: MarketStorage;
  eventBus?: MarketEventBus;
  analytics?: MarketAnalytics;
  reputation?: ReputationEngine;
  snapshotPath?: string;
  orderPollIntervalMs?: number;
  pauseMarket?: boolean;
  pauseOrders?: boolean;
}

export interface MarketContext {
  registry: MarketRegistry;
  bundles: BundleRegistry;
  bundleExecutor: BundleExecutor;
  heartbeat: HeartbeatIndex;
  quoteBook: QuoteBook;
  orders: MarketOrders;
  storage: MarketStorage;
  eventBus: MarketEventBus;
  analytics: MarketAnalytics;
  reputation: ReputationEngine;
  signerPublicKey: string;
  orderPollTimer?: NodeJS.Timeout;
  pauseMarket: boolean;
  pauseOrders: boolean;
  recordEvent: (event: Omit<MarketEvent, "ts">) => MarketEvent;
}

const searchQuerySchema = z.object({
  capability: z.string().min(1).optional(),
  maxPrice: z.string().regex(/^\d+$/).optional(),
  maxLatencyMs: z.coerce.number().int().positive().optional(),
});

const quotesQuerySchema = searchQuerySchema.extend({
  limit: z.coerce.number().int().positive().max(50).optional(),
  mint: z.string().min(1).optional(),
});

const heartbeatBodySchema = z.object({
  shopId: z.string().min(1),
  inflight: z.number().int().nonnegative(),
  queueDepth: z.number().int().nonnegative(),
  p95LatencyMs: z.number().int().positive(),
  errorRate: z.number().min(0).max(1).default(0),
});

const orderBodySchema = z.object({
  capability: z.string().min(1),
  maxPrice: z.string().regex(/^\d+$/),
  maxLatencyMs: z.number().int().positive().optional(),
  expiresAt: z.string().datetime(),
  preferSettlement: z.enum(["transfer", "stream", "netting"]).optional(),
  callbackUrl: z.string().url().optional(),
});

const orderIdSchema = z.object({
  id: z.string().uuid(),
});

const marketWindowSchema = z.object({
  window: z.enum(["1h", "24h", "7d"]).default("24h"),
  verificationTier: z.enum(["FAST", "VERIFIED"]).default("FAST"),
  ownerPubkey: z.string().min(32).optional(),
});

const priceHistorySchema = z.object({
  endpointId: z.string().min(1),
  window: z.enum(["1h", "24h", "7d"]).default("7d"),
});

const reputationQuerySchema = z.object({
  shopId: z.string().min(1),
  endpointId: z.string().min(1).optional(),
});

const devIngestSchema = z.object({
  events: z.array(z.unknown()).min(1),
});

const openApiImportBodySchema = z.object({
  spec: z.unknown(),
  defaults: z.object({
    priceAtomic: z.string().regex(/^\d+$/).optional(),
    maxLatencyMs: z.number().int().positive().optional(),
  }).optional(),
});

const mcpImportBodySchema = z.object({
  serverName: z.string().min(1),
  tools: z.array(z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    tags: z.array(z.string().min(1)).optional(),
  })).min(1),
});

function toIssueList(error: unknown): string[] | undefined {
  if (error instanceof ManifestValidationError) {
    return error.issues;
  }
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "input";
      return `${path}: ${issue.message}`;
    });
  }
  return undefined;
}

export function createMarketRouter(deps: CreateMarketDeps = {}): { router: express.Router; context: MarketContext } {
  const now = deps.now ?? (() => new Date());
  const signer = deps.signer ?? ReceiptSigner.generate();
  const registry = deps.registry ?? new MarketRegistry();
  const bundles = deps.bundles ?? new BundleRegistry();
  const heartbeat = deps.heartbeat ?? new HeartbeatIndex();
  const storage = deps.storage ?? new MarketStorage({ snapshotPath: deps.snapshotPath });
  const eventBus = deps.eventBus ?? new MarketEventBus();
  const reputation = deps.reputation ?? new ReputationEngine((shopId) => {
    const live = heartbeat.get(shopId);
    if (!live) {
      return 0.9;
    }
    const uptime = 1 - Math.min(0.9, live.load * 0.5);
    return Math.max(0.05, Math.min(1, uptime));
  });
  const quoteBook = deps.quoteBook ?? new QuoteBook(
    registry,
    heartbeat,
    signer,
    (shopId) => reputation.scoreForSeller(storage.all(), shopId).sellerScore / 100,
  );
  const orders = deps.orders ?? new MarketOrders(quoteBook, now);
  const analytics = deps.analytics ?? new MarketAnalytics(storage, registry, quoteBook, now);
  const pauseMarket = deps.pauseMarket ?? false;
  const pauseOrders = deps.pauseOrders ?? false;
  const bundleExecutor = deps.bundleExecutor ?? new BundleExecutor(bundles, quoteBook, {
    now,
    recordEvent: (event) => recordEvent(event),
  });

  const rateLimitWindowMs = 60_000;
  const rateLimitMax = 30;
  const rateLimiter = new Map<string, number[]>();

  eventBus.on((event) => {
    const checked = validateMarketEvent(event);
    storage.append(checked);
  });

  function recordEvent(event: Omit<MarketEvent, "ts">): MarketEvent {
    const created = createMarketEvent(event, now());
    const checked = validateMarketEvent(created);
    eventBus.emit(checked);
    return checked;
  }

  function allowRateLimit(key: string, maxPerWindow = rateLimitMax): boolean {
    const nowMs = now().getTime();
    const bucket = rateLimiter.get(key) ?? [];
    const filtered = bucket.filter((ts) => nowMs - ts <= rateLimitWindowMs);
    if (filtered.length >= maxPerWindow) {
      rateLimiter.set(key, filtered);
      return false;
    }
    filtered.push(nowMs);
    rateLimiter.set(key, filtered);
    return true;
  }

  async function notifyOrderCallback(order: MarketOrder): Promise<void> {
    if (!order.callbackUrl || !order.chosenQuote) {
      return;
    }
    try {
      await fetch(order.callbackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          orderId: order.orderId,
          status: order.status,
          chosenQuote: order.chosenQuote,
          updatedAt: order.updatedAt,
        }),
      });
    } catch {
      // Ignore callback failures; order state is already persisted.
    }
  }

  function handleExecutedOrders(executed: MarketOrder[]): void {
    for (const order of executed) {
      void notifyOrderCallback(order);
    }
  }

  const router = express.Router();
  router.use(cors());
  router.use(express.json());
  router.use((req, res, next) => {
    if (!pauseMarket) {
      next();
      return;
    }
    res.status(503).json({
      ok: false,
      error: "market_paused",
      message: "Market routes are paused by server policy (PAUSE_MARKET).",
      path: req.path,
    });
  });

  router.post("/shops", (req, res) => {
    try {
      const signed = validateSignedManifest(req.body);
      const ipKey = `shop-ip:${req.ip ?? "unknown"}`;
      const ownerKey = `shop-owner:${signed.manifest.ownerPubkey}`;
      if (!allowRateLimit(ipKey, 20) || !allowRateLimit(ownerKey, 10)) {
        res.status(429).json({ ok: false, error: "rate_limited" });
        return;
      }
      validateManifest(signed.manifest);
      registry.register(signed);
      res.status(201).json({
        ok: true,
        shopId: signed.manifest.shopId,
      });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: (error as Error).message,
        issues: toIssueList(error),
      });
    }
  });

  router.get("/shops", (_req, res) => {
    res.json({ shops: registry.list() });
  });

  router.get("/shops/:shopId", (req, res) => {
    const signed = registry.getSigned(req.params.shopId);
    if (!signed) {
      res.status(404).json({ error: "shop not found" });
      return;
    }

    const events24h = storage.inWindow(parseWindow("24h"), now());
    const topSelling24h = analytics.topSelling("24h", "FAST");
    const topSellerKeys = new Set(topSelling24h.map((row) => row.key));
    const badgesByEndpoint = computeShopBadges({
      shopId: signed.manifest.shopId,
      endpoints: signed.manifest.endpoints,
      events: events24h,
      heartbeat: heartbeat.get(signed.manifest.shopId),
      topSellerKeys,
    });

    const endpoints = signed.manifest.endpoints.map((endpoint) => ({
      ...endpoint,
      badges: badgesByEndpoint[endpoint.endpointId] ?? [],
      category: signed.manifest.category,
      examples: endpoint.examples ?? [],
    }));

    res.json({
      shop: {
        ...signed.manifest,
        endpoints,
      },
      signature: {
        manifestHash: signed.manifestHash,
        signature: signed.signature,
        ownerPubkey: signed.manifest.ownerPubkey,
      },
      publishedAt: signed.publishedAt,
    });
  });

  router.get("/search", (req, res) => {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const result = registry.search({
      capability: parsed.data.capability,
      maxPriceAtomic: parsed.data.maxPrice,
      maxLatencyMs: parsed.data.maxLatencyMs,
    });

    const events24h = storage.inWindow(parseWindow("24h"), now());
    const topSelling24h = analytics.topSelling("24h", "FAST");
    const topSellerKeys = new Set(topSelling24h.map((row) => row.key));
    const withBadges = result.map((item) => ({
      ...item,
      category: item.category,
      examples: item.endpoint.examples ?? [],
      badges: computeEndpointBadges({
        shopId: item.shopId,
        endpoint: item.endpoint,
        events: events24h,
        heartbeat: heartbeat.get(item.shopId),
        topSellerKeys,
      }),
    }));

    res.json({ results: withBadges });
  });

  router.post("/heartbeat", (req, res) => {
    const parsed = heartbeatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const heartbeatKey = `heartbeat:${parsed.data.shopId}:${req.ip ?? "unknown"}`;
    if (!allowRateLimit(heartbeatKey, 120)) {
      res.status(429).json({ ok: false, error: "rate_limited" });
      return;
    }

    const snapshot = heartbeat.upsert({
      shopId: parsed.data.shopId,
      inflight: parsed.data.inflight,
      queueDepth: parsed.data.queueDepth,
      p95LatencyMs: parsed.data.p95LatencyMs,
      errorRate: parsed.data.errorRate,
    }, now());

    res.json({ ok: true, heartbeat: snapshot });
  });

  router.get("/quotes", (req, res) => {
    const parsed = quotesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const quotes = quoteBook.list({
      capability: parsed.data.capability,
      maxPriceAtomic: parsed.data.maxPrice,
      maxLatencyMs: parsed.data.maxLatencyMs,
      limit: parsed.data.limit,
      mint: parsed.data.mint,
    });

    for (const quote of quotes) {
      recordEvent({
        type: "QUOTE_ISSUED",
        shopId: quote.shopId,
        endpointId: quote.endpointId,
        capabilityTags: quote.capabilityTags,
        priceAmount: quote.price,
        mint: quote.mint,
      });
    }

    res.json({
      signerPublicKey: signer.signerPublicKey,
      quotes,
    });
  });

  router.post("/import/openapi", (req, res) => {
    const parsed = openApiImportBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const imported = importOpenApiSpec(parsed.data.spec, {
      pricingModel: {
        kind: "flat",
        amountAtomic: parsed.data.defaults?.priceAtomic ?? "1000",
      },
      defaultLatencyMs: parsed.data.defaults?.maxLatencyMs ?? 1500,
    });

    res.json(imported);
  });

  router.post("/import/mcp", (req, res) => {
    const parsed = mcpImportBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    res.json({
      serverName: parsed.data.serverName,
      endpoints: importMcpTools(parsed.data),
    });
  });

  router.post("/bundles", (req, res) => {
    try {
      const signed = validateSignedBundleManifest(req.body);
      if (!allowRateLimit(`bundle-ip:${req.ip ?? "unknown"}`, 20) || !allowRateLimit(`bundle-owner:${signed.manifest.ownerPubkey}`, 10)) {
        res.status(429).json({ ok: false, error: "rate_limited" });
        return;
      }
      const bundle = bundles.register(signed);
      const breakdown = bundles.costBreakdown(quoteBook, bundle.bundleId);
      res.status(201).json({ ok: true, bundle, breakdown });
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message, issues: toIssueList(error) });
    }
  });

  router.get("/bundles", (_req, res) => {
    const listed = bundles.list().map((bundle) => ({
      ...bundle,
      breakdown: bundles.costBreakdown(quoteBook, bundle.bundleId),
    }));
    res.json({ bundles: listed });
  });

  router.get("/bundles/:id", (req, res) => {
    const bundle = bundles.get(req.params.id);
    if (!bundle) {
      res.status(404).json({ error: "bundle not found" });
      return;
    }
    res.json({
      bundle,
      signature: bundles.getSigned(req.params.id),
      breakdown: bundles.costBreakdown(quoteBook, bundle.bundleId),
    });
  });

  router.post("/bundles/:id/run", async (req, res) => {
    try {
      const result = await bundleExecutor.run(req.params.id, req.body ?? {});
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
    }
  });

  router.post("/orders", (req, res) => {
    if (pauseOrders) {
      res.status(503).json({ ok: false, error: "orders_paused", message: "Order routes are paused (PAUSE_ORDERS)." });
      return;
    }
    const parsed = orderBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const orderInput: MarketOrderInput = {
      capability: parsed.data.capability,
      maxPrice: parsed.data.maxPrice,
      maxLatencyMs: parsed.data.maxLatencyMs,
      expiresAt: parsed.data.expiresAt,
      preferSettlement: parsed.data.preferSettlement,
      callbackUrl: parsed.data.callbackUrl,
    };

    const order = orders.create(orderInput);
    res.status(201).json(order);
  });

  router.get("/orders", (_req, res) => {
    if (pauseOrders) {
      res.status(503).json({ ok: false, error: "orders_paused", message: "Order routes are paused (PAUSE_ORDERS)." });
      return;
    }
    res.json({ orders: orders.list() });
  });

  router.get("/orders/:id", (req, res) => {
    if (pauseOrders) {
      res.status(503).json({ ok: false, error: "orders_paused", message: "Order routes are paused (PAUSE_ORDERS)." });
      return;
    }
    const parsed = orderIdSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const order = orders.get(parsed.data.id);
    if (!order) {
      res.status(404).json({ error: "order not found" });
      return;
    }

    res.json(order);
  });

  router.post("/orders/:id/cancel", (req, res) => {
    if (pauseOrders) {
      res.status(503).json({ ok: false, error: "orders_paused", message: "Order routes are paused (PAUSE_ORDERS)." });
      return;
    }
    const parsed = orderIdSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const order = orders.cancel(parsed.data.id);
    if (!order) {
      res.status(404).json({ error: "order not found" });
      return;
    }

    res.json(order);
  });

  router.post("/orders/poll", (_req, res) => {
    if (pauseOrders) {
      res.status(503).json({ ok: false, error: "orders_paused", message: "Order routes are paused (PAUSE_ORDERS)." });
      return;
    }
    const executed = orders.poll();
    handleExecutedOrders(executed);
    res.json({ executed });
  });

  router.get("/top-selling", (req, res) => {
    const parsed = marketWindowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    res.json({
      window: parsed.data.window,
      verificationTier: parsed.data.verificationTier,
      results: analytics.topSelling(parsed.data.window, parsed.data.verificationTier),
    });
  });

  router.get("/top-revenue", (req, res) => {
    const parsed = marketWindowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    res.json({
      window: parsed.data.window,
      verificationTier: parsed.data.verificationTier,
      ownerPubkey: parsed.data.ownerPubkey,
      results: analytics.topRevenue(parsed.data.window, parsed.data.verificationTier, parsed.data.ownerPubkey),
    });
  });

  router.get("/trending", (req, res) => {
    const parsed = marketWindowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    res.json({
      window: parsed.data.window,
      verificationTier: parsed.data.verificationTier,
      results: analytics.trending(parsed.data.window, parsed.data.verificationTier),
    });
  });

  router.get("/on-sale", (req, res) => {
    const parsed = marketWindowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    res.json({
      window: parsed.data.window,
      results: analytics.onSale(parsed.data.window),
    });
  });

  router.get("/price-history", (req, res) => {
    const parsed = priceHistorySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    res.json({
      endpointId: parsed.data.endpointId,
      window: parsed.data.window,
      history: analytics.priceHistory(parsed.data.endpointId, parsed.data.window),
    });
  });

  router.get("/snapshot", (_req, res) => {
    res.json(analytics.snapshot());
  });

  router.post("/dev/events", (req, res) => {
    if (process.env.MARKET_ALLOW_DEV_INGEST !== "1") {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const parsed = devIngestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const ingested: MarketEvent[] = [];
    for (const candidate of parsed.data.events) {
      if (candidate && typeof candidate === "object" && "ts" in candidate) {
        const checked = validateMarketEvent(candidate);
        eventBus.emit(checked);
        ingested.push(checked);
        continue;
      }
      ingested.push(recordEvent(candidate as Omit<MarketEvent, "ts">));
    }

    res.json({ ok: true, count: ingested.length });
  });

  router.get("/reputation", (req, res) => {
    const parsed = reputationQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const events = storage.inWindow(parseWindow("24h"), now());
    if (parsed.data.endpointId) {
      res.json({
        window: "24h",
        shopId: parsed.data.shopId,
        endpointId: parsed.data.endpointId,
        score: reputation.scoreForEndpoint(events, parsed.data.shopId, parsed.data.endpointId),
      });
      return;
    }

    res.json({
      window: "24h",
      shopId: parsed.data.shopId,
      score: reputation.scoreForSeller(events, parsed.data.shopId),
    });
  });

  const pollMs = deps.orderPollIntervalMs ?? 5_000;
  const orderPollTimer = pauseOrders ? undefined : setInterval(() => {
    const executed = orders.poll();
    handleExecutedOrders(executed);
  }, Math.max(1_000, pollMs));
  orderPollTimer?.unref();

  const context: MarketContext = {
    registry,
    bundles,
    bundleExecutor,
    heartbeat,
    quoteBook,
    orders,
    storage,
    eventBus,
    analytics,
    reputation,
    signerPublicKey: signer.signerPublicKey,
    orderPollTimer,
    pauseMarket,
    pauseOrders,
    recordEvent,
  };

  return { router, context };
}

export function createMarketApp(deps: CreateMarketDeps = {}): { app: express.Express; context: MarketContext } {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const { router, context } = createMarketRouter(deps);
  app.use("/market", router);

  return { app, context };
}

export function signAndRegister(registry: MarketRegistry, signedManifest: SignedShopManifest): void {
  registry.register(signedManifest);
}
