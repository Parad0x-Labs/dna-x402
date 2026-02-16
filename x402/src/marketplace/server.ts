import express from "express";
import cors from "cors";
import { z } from "zod";
import { ReceiptSigner } from "../receipts.js";
import { validateShopManifest } from "../manifest/validate.js";
import { MarketplaceHeartbeatService } from "./heartbeat.js";
import { MarketplaceStore } from "./store.js";
import { LimitOrderBook } from "./orders.js";
import { QuoteEngine } from "./quotes.js";

interface CreateMarketplaceDeps {
  store?: MarketplaceStore;
  signer?: ReceiptSigner;
  quoteRecipientByShop?: (shopId: string) => string;
  orderPollIntervalMs?: number;
  now?: () => Date;
}

export interface MarketplaceContext {
  store: MarketplaceStore;
  quotes: QuoteEngine;
  orders: LimitOrderBook;
  heartbeat: MarketplaceHeartbeatService;
  signerPublicKey: string;
  pollTimer?: NodeJS.Timeout;
}

const searchQuerySchema = z.object({
  capability: z.string().optional(),
  maxPrice: z.string().regex(/^\d+$/).optional(),
  maxLatencyMs: z.coerce.number().int().positive().optional(),
});

const quotesQuerySchema = searchQuerySchema.extend({
  limit: z.coerce.number().int().positive().max(25).optional(),
});

const heartbeatBodySchema = z.object({
  shopId: z.string().min(1),
  queueDepth: z.number().int().nonnegative(),
  inflight: z.number().int().nonnegative(),
  p95LatencyMs: z.number().int().positive(),
});

const orderBodySchema = z.object({
  capability: z.string().min(1),
  maxPrice: z.string().regex(/^\d+$/),
  expiresAt: z.string().datetime(),
  callbackUrl: z.string().url().optional(),
});

export function createMarketplaceApp(deps: CreateMarketplaceDeps = {}): { app: express.Express; context: MarketplaceContext } {
  const app = express();
  const store = deps.store ?? new MarketplaceStore();
  const signer = deps.signer ?? ReceiptSigner.generate();
  const quoteRecipientByShop = deps.quoteRecipientByShop ?? ((shopId: string) => `${shopId}-recipient`);
  const quotes = new QuoteEngine(store, signer, quoteRecipientByShop);
  const heartbeat = new MarketplaceHeartbeatService(store);
  const orders = new LimitOrderBook(quotes, deps.now);

  app.use(cors());
  app.use(express.json());

  app.post("/shops", (req, res) => {
    try {
      const manifest = validateShopManifest(req.body);
      store.registerShop(manifest);
      res.status(201).json({ ok: true, shopId: manifest.shopId });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: (error as Error).message,
        issues: error instanceof Error && "issues" in error ? (error as any).issues : undefined,
      });
    }
  });

  app.get("/shops", (_req, res) => {
    res.json({ shops: store.listShops() });
  });

  app.get("/shops/:id", (req, res) => {
    const shop = store.getShop(req.params.id);
    if (!shop) {
      res.status(404).json({ error: "shop not found" });
      return;
    }
    res.json(shop);
  });

  app.get("/search", (req, res) => {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const results = store.search({
      capability: parsed.data.capability,
      maxPriceAtomic: parsed.data.maxPrice,
      maxLatencyMs: parsed.data.maxLatencyMs,
    });
    res.json({ results });
  });

  app.get("/quotes", (req, res) => {
    const parsed = quotesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const result = quotes.getQuotes({
      capability: parsed.data.capability,
      maxPriceAtomic: parsed.data.maxPrice,
      maxLatencyMs: parsed.data.maxLatencyMs,
      limit: parsed.data.limit,
    });
    res.json({
      signerPublicKey: signer.signerPublicKey,
      quotes: result,
    });
  });

  app.post("/heartbeat", (req, res) => {
    const parsed = heartbeatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const snapshot = heartbeat.report(parsed.data);
    res.json({ ok: true, heartbeat: snapshot });
  });

  app.post("/orders", (req, res) => {
    const parsed = orderBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const order = orders.placeOrder({
      capability: parsed.data.capability,
      maxPriceAtomic: parsed.data.maxPrice,
      expiresAt: parsed.data.expiresAt,
      callbackUrl: parsed.data.callbackUrl,
    });
    res.status(201).json(order);
  });

  app.get("/orders", (_req, res) => {
    res.json({ orders: orders.list() });
  });

  app.get("/orders/:id", (req, res) => {
    const order = orders.get(req.params.id);
    if (!order) {
      res.status(404).json({ error: "order not found" });
      return;
    }
    res.json(order);
  });

  app.post("/orders/poll", (_req, res) => {
    const executed = orders.poll();
    res.json({ executed });
  });

  const pollMs = deps.orderPollIntervalMs ?? 5_000;
  const pollTimer = setInterval(() => {
    orders.poll();
  }, pollMs);
  pollTimer.unref();

  return {
    app,
    context: {
      store,
      quotes,
      orders,
      heartbeat,
      signerPublicKey: signer.signerPublicKey,
      pollTimer,
    },
  };
}
