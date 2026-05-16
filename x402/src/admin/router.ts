import express from "express";
import type { X402AppContext } from "../server.js";
import type { AuditLogger } from "../logging/audit.js";
import type { X402Config } from "../config.js";
import { toAtomicString } from "../feePolicy.js";
import { adminAuth } from "./auth.js";

export interface AdminRouterDeps {
  context: X402AppContext;
  auditLog: AuditLogger;
  config: X402Config;
  adminSecret?: string;
}

export function createAdminRouter(deps: AdminRouterDeps): express.Router {
  const { context, auditLog, config, adminSecret } = deps;
  const router = express.Router();
  const startedAt = new Date().toISOString();

  router.use(adminAuth({ secret: adminSecret, allowInsecure: config.allowInsecure }));

  router.get("/overview", (_req, res) => {
    const quotesCount = context.quotes.size;
    const commitsCount = context.commits.size;
    const receiptsCount = context.receipts.size;
    const pendingAnchors = context.anchoringQueue?.getPendingCount() ?? 0;
    const anchoredCount = context.anchoringQueue?.getAnchoredCount() ?? 0;
    const nettingSnapshot = context.nettingLedger.snapshot();
    const marketShops = context.market.registry.list().length;
    const marketEvents = context.market.storage.all().length;
    const auditSummary = auditLog.summary();
    const guardSummary = context.guard?.ledger.summary() ?? null;
    const uptimeMs = Date.now() - new Date(startedAt).getTime();

    res.json({
      startedAt,
      uptimeMs,
      uptimeHuman: `${Math.floor(uptimeMs / 3_600_000)}h ${Math.floor((uptimeMs % 3_600_000) / 60_000)}m`,
      cluster: config.cluster,
      version: config.appVersion,
      commit: config.buildCommit ?? null,
      state: {
        quotes: quotesCount,
        commits: commitsCount,
        receipts: receiptsCount,
        pendingAnchors,
        anchoredCount,
        netting: nettingSnapshot,
        marketShops,
        marketEvents,
        guard: guardSummary,
      },
      audit24h: auditSummary,
      pauseFlags: {
        market: config.pauseMarket,
        orders: config.pauseOrders,
        finalize: config.pauseFinalize,
      },
      config: {
        port: config.port,
        mint: config.usdcMint,
        recipient: config.paymentRecipient,
        feePolicy: {
          baseFeeAtomic: toAtomicString(config.feePolicy.baseFeeAtomic),
          feeBps: config.feePolicy.feeBps,
          minFeeAtomic: toAtomicString(config.feePolicy.minFeeAtomic),
        },
        anchoringEnabled: Boolean(context.anchoringQueue),
        receiptAnchorProgramId: config.receiptAnchorProgramId ?? null,
        dnaGuardEnabled: Boolean(context.guard),
      },
    });
  });

  router.get("/guard", (_req, res) => {
    res.json({
      enabled: Boolean(context.guard),
      config: config.dnaGuard ?? null,
      summary: context.guard?.ledger.summary() ?? null,
      leaderboard: context.guard?.leaderboard(10) ?? [],
    });
  });

  router.get("/audit/events", (req, res) => {
    const kind = req.query.kind as string | undefined;
    const shopId = req.query.shopId as string | undefined;
    const traceId = req.query.traceId as string | undefined;
    const since = req.query.since as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;

    const entries = auditLog.query({ kind: kind as any, shopId, traceId, since, limit });
    res.json({ count: entries.length, entries });
  });

  router.get("/audit/summary", (req, res) => {
    const windowMs = req.query.windowMs ? parseInt(req.query.windowMs as string, 10) : 86_400_000;
    res.json(auditLog.summary(windowMs));
  });

  router.get("/audit/export", (req, res) => {
    const since = req.query.since as string | undefined;
    res.setHeader("content-type", "application/x-ndjson");
    res.setHeader("content-disposition", `attachment; filename="dna-audit-${Date.now()}.ndjson"`);
    res.send(auditLog.exportNdjson(since));
  });

  router.get("/x402/policy", (req, res) => {
    const state = req.query.state as string | undefined;
    const action = req.query.action as string | undefined;
    const entries = context.market.policyAuditEvents
      .filter((event) => (state ? event.state === state : true))
      .filter((event) => (action ? event.reasonCodes.some((reason) => reason.includes(action)) : true));
    res.json({ count: entries.length, entries });
  });

  router.get("/x402/audit", (req, res) => {
    const kind = req.query.kind as string | undefined;
    const since = req.query.since as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 200;
    res.json({ entries: auditLog.query({ kind: kind as any, since, limit }) });
  });

  router.get("/x402/denylist", (_req, res) => {
    res.json({ entries: context.governance.listDenylistEntries() });
  });

  router.post("/x402/denylist", (req, res) => {
    try {
      const body = req.body ?? {};
      const entry = context.governance.addDenylistEntry({
        subjectType: body.subjectType,
        subjectValue: body.subjectValue,
        reasonCode: body.reasonCode,
        evidenceRefs: Array.isArray(body.evidenceRefs) ? body.evidenceRefs : [],
        severity: body.severity,
        createdBy: body.createdBy ?? body.actorId ?? "admin",
        expiresAt: body.expiresAt,
      });
      auditLog.record({ kind: "GOVERNANCE_ACTION", meta: { action: "denylist.create", entryId: entry.entryId, subjectType: entry.subjectType } });
      res.status(201).json({ ok: true, entry });
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
    }
  });

  router.post("/x402/denylist/:entryId/revoke", (req, res) => {
    try {
      const entry = context.governance.updateDenylistStatus(req.params.entryId, "REVOKED", req.body?.actorId ?? "admin");
      auditLog.record({ kind: "GOVERNANCE_ACTION", meta: { action: "denylist.revoke", entryId: entry.entryId } });
      res.json({ ok: true, entry });
    } catch (error) {
      res.status(404).json({ ok: false, error: (error as Error).message });
    }
  });

  router.get("/x402/appeals", (_req, res) => {
    res.json({ appeals: context.governance.listAppeals() });
  });

  router.post("/x402/appeals", (req, res) => {
    try {
      const body = req.body ?? {};
      const appeal = context.governance.openAppeal({
        subjectType: body.subjectType,
        subjectId: body.subjectId,
        policyDecisionId: body.policyDecisionId,
        reason: body.reason,
        evidenceRefs: Array.isArray(body.evidenceRefs) ? body.evidenceRefs : [],
      });
      auditLog.record({ kind: "GOVERNANCE_ACTION", meta: { action: "appeal.open", appealId: appeal.appealId } });
      res.status(201).json({ ok: true, appeal });
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
    }
  });

  router.post("/x402/appeals/:appealId/resolve", (req, res) => {
    try {
      const body = req.body ?? {};
      const appeal = context.governance.resolveAppeal(
        req.params.appealId,
        body.reviewer ?? "admin",
        Boolean(body.approved),
        body.resolutionReason ?? "resolved",
        ["appeal_reviewer"],
      );
      auditLog.record({ kind: "GOVERNANCE_ACTION", meta: { action: "appeal.resolve", appealId: appeal.appealId, status: appeal.status } });
      res.json({ ok: true, appeal });
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
    }
  });

  router.get("/x402/emergency", (_req, res) => {
    res.json({
      state: context.emergencyPause.snapshot(),
      history: context.emergencyPause.history(),
    });
  });

  router.post("/x402/emergency", async (req, res) => {
    try {
      const body = req.body ?? {};
      const state = await context.emergencyPause.setFlag({
        flag: body.flag,
        enabled: Boolean(body.enabled),
        reason: body.reason,
        actorId: body.actorId,
      });
      if (body.flag === "marketplacePaused") {
        context.market.pauseMarket = Boolean(body.enabled);
      }
      if (body.flag === "sellerListingUpdatesPaused") {
        context.market.pauseMarket = Boolean(body.enabled);
      }
      auditLog.record({
        kind: body.enabled ? "PAUSE_ACTIVATED" : "PAUSE_DEACTIVATED",
        actor: body.actorId,
        meta: { flag: body.flag, reason: body.reason },
      });
      res.json({ ok: true, state });
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
    }
  });

  router.get("/receipts", (_req, res) => {
    const entries = Array.from(context.receipts.values()).map((r) => ({
      receiptId: r.payload.receiptId,
      quoteId: r.payload.quoteId,
      shopId: r.payload.shopId,
      settlement: r.payload.settlement,
      amountAtomic: r.payload.amountAtomic,
      totalAtomic: r.payload.totalAtomic,
      mint: r.payload.mint,
      settledOnchain: r.payload.settledOnchain,
      txSignature: r.payload.txSignature ?? null,
      createdAt: r.payload.createdAt,
    }));
    res.json({ count: entries.length, receipts: entries });
  });

  router.get("/commits", (_req, res) => {
    const entries = Array.from(context.commits.values()).map((c) => ({
      commitId: c.commitId,
      quoteId: c.quoteId,
      status: c.status,
      settlementMode: c.settlementMode ?? null,
      receiptId: c.receiptId ?? null,
      createdAt: c.createdAt,
    }));
    res.json({ count: entries.length, commits: entries });
  });

  router.get("/quotes", (_req, res) => {
    const now = Date.now();
    const entries = Array.from(context.quotes.values()).map((q) => ({
      quoteId: q.quoteId,
      resource: q.resource,
      totalAtomic: q.totalAtomic,
      mint: q.mint,
      settlement: q.settlement,
      expiresAt: q.expiresAt,
      expired: now >= new Date(q.expiresAt).getTime(),
    }));
    res.json({ count: entries.length, quotes: entries });
  });

  router.get("/anchoring", (_req, res) => {
    const status = context.anchoringQueue?.getStatus();
    res.json({
      enabled: Boolean(context.anchoringQueue),
      programId: config.receiptAnchorProgramId ?? null,
      status: status ?? null,
      recentSignatures: context.anchoringQueue?.recentSignatures(10) ?? [],
    });
  });

  router.get("/netting", (_req, res) => {
    res.json(context.nettingLedger.snapshot());
  });

  router.get("/market/shops", (_req, res) => {
    const shops = context.market.registry.list(true).map((shop) => ({
      shopId: shop.shopId,
      name: shop.name,
      ownerPubkey: shop.ownerPubkey,
      endpointCount: shop.endpoints.length,
      category: shop.category,
      disabled: context.market.registry.isDisabled(shop.shopId),
    }));
    res.json({ count: shops.length, shops });
  });

  router.post("/market/shops/:shopId/disable", (req, res) => {
    const { shopId } = req.params;
    context.market.registry.disable(shopId);
    auditLog.record({ kind: "SHOP_DISABLED", shopId, meta: { action: "listing.disable", actorId: req.body?.actorId ?? req.header("x-admin-actor") ?? "admin" } });
    res.json({ ok: true, shopId, disabled: true });
  });

  router.post("/market/shops/:shopId/restore", (req, res) => {
    const { shopId } = req.params;
    const existing = context.market.registry.getSigned(shopId, true);
    if (!existing) {
      res.status(404).json({ ok: false, error: "shop_not_found" });
      return;
    }
    context.market.registry.enable(shopId);
    auditLog.record({
      kind: "ADMIN_ACTION",
      shopId,
      meta: {
        action: "listing.restore",
        actorId: req.body?.actorId ?? req.header("x-admin-actor") ?? "admin",
        reason: req.body?.reason ?? "restore requested",
      },
    });
    res.json({ ok: true, shopId, disabled: false });
  });

  router.get("/market/events/raw", (req, res) => {
    auditLog.record({
      kind: "ADMIN_ACTION",
      actor: req.header("x-admin-actor") ?? "admin",
      meta: { action: "market.events.raw.read" },
    });
    res.json({ events: context.market.storage.all() });
  });

  router.get("/replay-store", (_req, res) => {
    res.json({
      size: context.replayStore.size(),
    });
  });

  router.post("/pause/:flag", (req, res) => {
    const { flag } = req.params;
    const enable = req.query.enable !== "false";
    switch (flag) {
      case "market":
        context.market.pauseMarket = enable;
        auditLog.record({ kind: enable ? "PAUSE_ACTIVATED" : "PAUSE_DEACTIVATED", meta: { flag: "market" } });
        break;
      case "orders":
        context.market.pauseOrders = enable;
        auditLog.record({ kind: enable ? "PAUSE_ACTIVATED" : "PAUSE_DEACTIVATED", meta: { flag: "orders" } });
        break;
      default:
        res.status(400).json({ error: `unknown flag: ${flag}` });
        return;
    }
    res.json({ ok: true, flag, enabled: enable });
  });

  return router;
}
