import express from "express";
import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { z } from "zod";
import {
  DnaGuardActor,
  DnaGuardDisputeRecord,
  DnaGuardLedger,
  DnaGuardLedgerOptions,
  DnaGuardProviderSnapshot,
  DnaGuardReceiptStatus,
  DnaGuardReplayAlertRecord,
  DnaGuardSpendCeilings,
  DnaGuardSpendDecision,
} from "../guard/engine.js";
import type { AuditLogger } from "../logging/audit.js";

export { DnaGuardLedger } from "../guard/engine.js";
export {
  createFileBackedDnaGuardLedger,
  loadDnaGuardSnapshot,
  persistDnaGuardSnapshot,
} from "../guard/storage.js";

export type {
  DnaGuardActor,
  DnaGuardDisputeRecord,
  DnaGuardLedgerOptions,
  DnaGuardProviderSnapshot,
  DnaGuardReceiptStatus,
  DnaGuardReplayAlertRecord,
  DnaGuardSpendCeilings,
  DnaGuardSpendDecision,
} from "../guard/engine.js";
export type { DnaGuardFileStoreOptions } from "../guard/storage.js";

export type DnaGuardFailMode = "fail-open" | "fail-closed";

export interface DnaGuardValidationResult {
  ok: boolean;
  reason?: string;
}

export interface DnaGuardBestQuoteResult {
  provider: DnaGuardProviderSnapshot;
  compared: number;
  filters: {
    endpointId?: string;
    maxLatencyMs?: number;
    minScore?: number;
  };
}

export interface DnaGuardControllerOptions {
  ledger?: DnaGuardLedger;
  ledgerOptions?: DnaGuardLedgerOptions;
  auditLog?: AuditLogger;
}

export interface DnaGuardMiddlewareOptions {
  providerId: string | ((req: Request) => string);
  endpointId?: string | ((req: Request) => string | undefined);
  amountAtomic?: string | ((req: Request) => string | undefined);
  actor?: (req: Request) => DnaGuardActor;
  spendCeilings?: DnaGuardSpendCeilings | ((req: Request) => DnaGuardSpendCeilings | undefined);
  receiptId?: (req: Request, body: unknown) => string | undefined;
  qualityValidator?: (body: unknown, req: Request, res: Response) => boolean | DnaGuardValidationResult;
  replayDetector?: (req: Request) => boolean | { replay: boolean; reason?: string };
  failMode?: DnaGuardFailMode;
  tagFailedDeliveryAsDispute?: boolean;
}

const verificationBodySchema = z.object({
  providerId: z.string().min(1),
  endpointId: z.string().min(1).optional(),
  valid: z.boolean(),
  reason: z.string().min(1).optional(),
});

const disputeBodySchema = z.object({
  providerId: z.string().min(1),
  endpointId: z.string().min(1).optional(),
  reason: z.string().min(1),
});

const replayBodySchema = z.object({
  providerId: z.string().min(1),
  endpointId: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
});

const quoteQuerySchema = z.object({
  providers: z.string().optional(),
  endpointId: z.string().min(1).optional(),
  maxLatencyMs: z.coerce.number().int().positive().optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
});

const compareQuerySchema = z.object({
  providers: z.string().min(1),
  endpointId: z.string().min(1).optional(),
});

const scoreQuerySchema = z.object({
  endpointId: z.string().min(1).optional(),
});

const spendQuerySchema = z.object({
  buyerId: z.string().min(1).optional(),
  walletAddress: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  apiKeyId: z.string().min(1).optional(),
});

function defaultActorFromRequest(req: Request): DnaGuardActor {
  const header = (name: string) => req.header(name) ?? undefined;
  return {
    buyerId: header("x-dna-buyer-id"),
    walletAddress: header("x-dna-wallet"),
    agentId: header("x-dna-agent-id"),
    apiKeyId: header("x-dna-api-key-id"),
  };
}

function resolveValue<T>(value: T | ((req: Request) => T), req: Request): T {
  return typeof value === "function"
    ? (value as (req: Request) => T)(req)
    : value;
}

function normalizeValidationResult(result: boolean | DnaGuardValidationResult): DnaGuardValidationResult {
  return typeof result === "boolean"
    ? { ok: result }
    : result;
}

function normalizeReplayResult(result: boolean | { replay: boolean; reason?: string }): { replay: boolean; reason?: string } {
  return typeof result === "boolean"
    ? { replay: result }
    : result;
}

function splitProviders(raw?: string): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const providers = raw.split(",").map((value) => value.trim()).filter(Boolean);
  return providers.length > 0 ? providers : undefined;
}

export interface DnaGuardController {
  ledger: DnaGuardLedger;
  protect: (options: DnaGuardMiddlewareOptions) => RequestHandler;
  router: () => Router;
  providerSnapshot: (providerId: string, endpointId?: string) => DnaGuardProviderSnapshot;
  leaderboard: (limit?: number) => DnaGuardProviderSnapshot[];
  compareProviders: (providerIds: string[], endpointId?: string) => DnaGuardProviderSnapshot[];
  bestQuote: (input?: {
    providerIds?: string[];
    endpointId?: string;
    maxLatencyMs?: number;
    minScore?: number;
  }) => DnaGuardBestQuoteResult | undefined;
  spendSnapshot: (actor: DnaGuardActor) => Partial<Record<"buyer" | "wallet" | "agent" | "apiKey", string>>;
  verifyReceipt: (input: z.infer<typeof verificationBodySchema> & { receiptId: string; now?: Date }) => DnaGuardReceiptStatus;
  tagDispute: (input: DnaGuardDisputeRecord) => DnaGuardReceiptStatus | undefined;
  recordReplayAlert: (input: DnaGuardReplayAlertRecord) => void;
}

export function createDnaGuard(options: DnaGuardControllerOptions = {}): DnaGuardController {
  const ledger = options.ledger ?? new DnaGuardLedger(options.ledgerOptions);
  const auditLog = options.auditLog;

  function recordGuardEvent(
    kind:
    | "GUARD_SPEND_BLOCKED"
    | "GUARD_REPLAY_ALERT"
    | "GUARD_VALIDATION_FAILED"
    | "GUARD_DISPUTE_TAGGED"
    | "GUARD_RECEIPT_VERIFIED"
    | "GUARD_RECEIPT_INVALID"
    | "GUARD_FAIL_OPEN"
    | "GUARD_RUNTIME_ERROR",
    input: {
      providerId: string;
      endpointId?: string;
      receiptId?: string;
      actor?: DnaGuardActor;
      amountAtomic?: string;
      reason?: string;
      meta?: Record<string, unknown>;
    },
  ): void {
    auditLog?.record({
      kind,
      actor: input.actor?.buyerId ?? input.actor?.agentId ?? input.actor?.walletAddress ?? input.actor?.apiKeyId,
      shopId: input.providerId,
      endpointId: input.endpointId,
      receiptId: input.receiptId,
      amountAtomic: input.amountAtomic,
      errorMessage: input.reason,
      meta: input.meta,
    });
  }

  function providerSnapshot(providerId: string, endpointId?: string): DnaGuardProviderSnapshot {
    return ledger.providerSnapshot(providerId, endpointId);
  }

  function leaderboard(limit = 20): DnaGuardProviderSnapshot[] {
    return ledger.leaderboard(limit);
  }

  function compareProviders(providerIds: string[], endpointId?: string): DnaGuardProviderSnapshot[] {
    return providerIds
      .map((providerId) => providerSnapshot(providerId, endpointId))
      .sort((left, right) =>
        right.score - left.score
        || right.totals.successRate - left.totals.successRate
        || left.totals.avgLatencyMs - right.totals.avgLatencyMs
        || left.providerId.localeCompare(right.providerId));
  }

  function bestQuote(input: {
    providerIds?: string[];
    endpointId?: string;
    maxLatencyMs?: number;
    minScore?: number;
  } = {}): DnaGuardBestQuoteResult | undefined {
    const compared = input.providerIds
      ? compareProviders(input.providerIds, input.endpointId)
      : leaderboard(100)
        .filter((snapshot) => !input.endpointId || snapshot.endpointId === input.endpointId);
    const filtered = compared.filter((snapshot) => (
      (input.maxLatencyMs === undefined || snapshot.totals.avgLatencyMs <= input.maxLatencyMs)
      && (input.minScore === undefined || snapshot.score >= input.minScore)
    ));
    const selected = filtered[0];
    if (!selected) {
      return undefined;
    }
    return {
      provider: selected,
      compared: filtered.length,
      filters: {
        endpointId: input.endpointId,
        maxLatencyMs: input.maxLatencyMs,
        minScore: input.minScore,
      },
    };
  }

  function spendSnapshot(actor: DnaGuardActor): Partial<Record<"buyer" | "wallet" | "agent" | "apiKey", string>> {
    return ledger.spendSnapshot(actor);
  }

  function verifyReceipt(input: z.infer<typeof verificationBodySchema> & { receiptId: string; now?: Date }): DnaGuardReceiptStatus {
    ledger.recordReceiptVerification({
      providerId: input.providerId,
      endpointId: input.endpointId,
      receiptId: input.receiptId,
      valid: input.valid,
      reason: input.reason,
    }, input.now);
    recordGuardEvent(input.valid ? "GUARD_RECEIPT_VERIFIED" : "GUARD_RECEIPT_INVALID", {
      providerId: input.providerId,
      endpointId: input.endpointId,
      receiptId: input.receiptId,
      reason: input.reason,
    });
    return ledger.receiptStatus(input.receiptId)!;
  }

  function tagDispute(input: DnaGuardDisputeRecord): DnaGuardReceiptStatus | undefined {
    ledger.recordDispute(input);
    recordGuardEvent("GUARD_DISPUTE_TAGGED", {
      providerId: input.providerId,
      endpointId: input.endpointId,
      receiptId: input.receiptId,
      reason: input.reason,
    });
    return input.receiptId ? ledger.receiptStatus(input.receiptId) : undefined;
  }

  function recordReplayAlert(input: DnaGuardReplayAlertRecord): void {
    ledger.recordReplayAlert(input);
    recordGuardEvent("GUARD_REPLAY_ALERT", {
      providerId: input.providerId,
      endpointId: input.endpointId,
      reason: input.reason,
    });
  }

  function protect(guardOptions: DnaGuardMiddlewareOptions): RequestHandler {
    return function dnaGuardMiddleware(req: Request, res: Response, next: NextFunction): void {
      const startedAtMs = Date.now();
      const failMode = guardOptions.failMode ?? "fail-closed";
      const actor = (guardOptions.actor ?? defaultActorFromRequest)(req);
      const providerId = resolveValue(guardOptions.providerId, req);
      const endpointId = guardOptions.endpointId ? resolveValue(guardOptions.endpointId, req) : undefined;
      const amountAtomic = guardOptions.amountAtomic ? resolveValue(guardOptions.amountAtomic, req) : undefined;
      const spendCeilings = guardOptions.spendCeilings
        ? resolveValue(guardOptions.spendCeilings, req)
        : undefined;

      const failClosed = (statusCode: number, body: Record<string, unknown>) => {
        res.status(statusCode).json(body);
      };

      try {
        if (amountAtomic) {
          const spendDecision: DnaGuardSpendDecision | undefined = spendCeilings
            ? ledger.checkSpend(actor, amountAtomic, spendCeilings)
            : undefined;
          if (spendDecision && !spendDecision.ok) {
            ledger.recordSpendBlocked(providerId, endpointId);
            recordGuardEvent("GUARD_SPEND_BLOCKED", {
              providerId,
              endpointId,
              actor,
              amountAtomic,
              reason: "spend_ceiling_exceeded",
              meta: {
                enforced: failMode === "fail-closed",
                blocked: spendDecision.blocked,
              },
            });
            if (failMode === "fail-closed") {
              failClosed(429, {
                error: "dna_guard_spend_blocked",
                blocked: spendDecision.blocked,
              });
              return;
            }
          }
        }

        if (guardOptions.replayDetector) {
          const replay = normalizeReplayResult(guardOptions.replayDetector(req));
          if (replay.replay) {
            recordReplayAlert({
              providerId,
              endpointId,
              reason: replay.reason,
            });
            if (failMode === "fail-closed") {
              failClosed(409, {
                error: "dna_guard_replay_blocked",
                reason: replay.reason ?? "replay_detected",
              });
              return;
            }
          }
        }
      } catch (error) {
        recordGuardEvent(failMode === "fail-open" ? "GUARD_FAIL_OPEN" : "GUARD_RUNTIME_ERROR", {
          providerId,
          endpointId,
          actor,
          amountAtomic,
          reason: error instanceof Error ? error.message : "guard_runtime_error",
          meta: { stage: "preflight" },
        });
        if (failMode === "fail-closed") {
          failClosed(500, { error: "dna_guard_runtime_error" });
          return;
        }
      }

      let qualityAccepted: boolean | undefined;
      let qualityReason: string | undefined;
      let receiptId: string | undefined;
      let inspectedBody = false;
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);

      const inspectBody = (body: unknown): { blocked: boolean } => {
        if (inspectedBody) {
          return { blocked: false };
        }
        inspectedBody = true;
        if (guardOptions.receiptId) {
          try {
            receiptId = guardOptions.receiptId(req, body);
          } catch (error) {
            recordGuardEvent(failMode === "fail-open" ? "GUARD_FAIL_OPEN" : "GUARD_RUNTIME_ERROR", {
              providerId,
              endpointId,
              actor,
              amountAtomic,
              reason: error instanceof Error ? error.message : "receipt_extractor_failed",
              meta: { stage: "receipt_id" },
            });
            if (failMode === "fail-closed") {
              return { blocked: true };
            }
          }
        }
        if (!guardOptions.qualityValidator) {
          return { blocked: false };
        }
        try {
          const validation = normalizeValidationResult(guardOptions.qualityValidator(body, req, res));
          qualityAccepted = validation.ok;
          qualityReason = validation.reason;
        } catch (error) {
          recordGuardEvent(failMode === "fail-open" ? "GUARD_FAIL_OPEN" : "GUARD_RUNTIME_ERROR", {
            providerId,
            endpointId,
            receiptId,
            actor,
            amountAtomic,
            reason: error instanceof Error ? error.message : "quality_validator_failed",
            meta: { stage: "quality_validator" },
          });
          if (failMode === "fail-open") {
            return { blocked: false };
          }
          qualityAccepted = false;
          qualityReason = "validator_runtime_error";
        }

        if (qualityAccepted === false) {
          recordGuardEvent("GUARD_VALIDATION_FAILED", {
            providerId,
            endpointId,
            receiptId,
            actor,
            amountAtomic,
            reason: qualityReason ?? "non_conforming_response",
            meta: { failMode },
          });
          if (receiptId) {
            tagDispute({
              providerId,
              endpointId,
              receiptId,
              reason: qualityReason ?? "non_conforming_response",
            });
          }
          if (failMode === "fail-closed") {
            return { blocked: true };
          }
        }
        return { blocked: false };
      };

      res.json = ((body: unknown) => {
        const result = inspectBody(body);
        if (result.blocked) {
          res.status(res.statusCode >= 400 ? res.statusCode : 502);
          return originalJson({
            error: qualityReason === "validator_runtime_error"
              ? "dna_guard_runtime_error"
              : "dna_guard_validation_failed",
            reason: qualityReason ?? "non_conforming_response",
            receiptId,
          });
        }
        return originalJson(body);
      }) as Response["json"];

      res.send = ((body: unknown) => {
        const result = inspectBody(body);
        if (result.blocked) {
          res.status(res.statusCode >= 400 ? res.statusCode : 502);
          return originalJson({
            error: qualityReason === "validator_runtime_error"
              ? "dna_guard_runtime_error"
              : "dna_guard_validation_failed",
            reason: qualityReason ?? "non_conforming_response",
            receiptId,
          });
        }
        return originalSend(body);
      }) as Response["send"];

      res.on("finish", () => {
        ledger.recordDelivery({
          providerId,
          endpointId,
          latencyMs: Date.now() - startedAtMs,
          statusCode: res.statusCode,
          receiptId,
          qualityAccepted,
        });
        if (amountAtomic && res.statusCode < 400 && qualityAccepted !== false) {
          ledger.commitSpend(actor, amountAtomic);
        }
        if (receiptId && guardOptions.tagFailedDeliveryAsDispute !== false && res.statusCode >= 500) {
          tagDispute({
            providerId,
            endpointId,
            receiptId,
            reason: `delivery_failed_${res.statusCode}`,
          });
        }
      });

      next();
    };
  }

  function router(): Router {
    const router = express.Router();
    router.use(express.json());

    router.get("/summary", (_req, res) => {
      res.json(ledger.summary());
    });

    router.get("/leaderboard", (req, res) => {
      const limit = Number(req.query.limit ?? 20);
      res.json({
        count: leaderboard(Number.isFinite(limit) ? limit : 20).length,
        providers: leaderboard(Number.isFinite(limit) ? limit : 20),
      });
    });

    router.get("/score/:providerId", (req, res) => {
      const parsed = scoreQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_query", issues: parsed.error.issues });
        return;
      }
      res.json(providerSnapshot(req.params.providerId, parsed.data.endpointId));
    });

    router.get("/reputation/:providerId", (req, res) => {
      const parsed = scoreQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_query", issues: parsed.error.issues });
        return;
      }
      const snapshot = providerSnapshot(req.params.providerId, parsed.data.endpointId);
      res.json({
        providerId: snapshot.providerId,
        endpointId: snapshot.endpointId,
        score: snapshot.score,
        riskLevel: snapshot.riskLevel,
        metrics: snapshot.totals,
      });
    });

    router.get("/compare", (req, res) => {
      const parsed = compareQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_query", issues: parsed.error.issues });
        return;
      }
      const providers = splitProviders(parsed.data.providers) ?? [];
      const compared = compareProviders(providers, parsed.data.endpointId);
      res.json({
        count: compared.length,
        bestProviderId: compared[0]?.providerId ?? null,
        providers: compared,
      });
    });

    router.get("/quote/best", (req, res) => {
      const parsed = quoteQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_query", issues: parsed.error.issues });
        return;
      }
      const result = bestQuote({
        providerIds: splitProviders(parsed.data.providers),
        endpointId: parsed.data.endpointId,
        maxLatencyMs: parsed.data.maxLatencyMs,
        minScore: parsed.data.minScore,
      });
      if (!result) {
        res.status(404).json({ error: "no_matching_provider" });
        return;
      }
      res.json(result);
    });

    router.get("/spend", (req, res) => {
      const parsed = spendQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_query", issues: parsed.error.issues });
        return;
      }
      res.json(spendSnapshot(parsed.data));
    });

    router.get("/receipt/:receiptId/verify", (req, res) => {
      const receipt = ledger.receiptStatus(req.params.receiptId);
      if (!receipt) {
        res.status(404).json({ error: "receipt_not_found" });
        return;
      }
      res.json(receipt);
    });

    router.post("/receipt/:receiptId/verify", (req, res) => {
      const parsed = verificationBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
        return;
      }
      res.status(201).json(verifyReceipt({
        receiptId: req.params.receiptId,
        ...parsed.data,
      }));
    });

    router.post("/receipt/:receiptId/dispute", (req, res) => {
      const parsed = disputeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
        return;
      }
      res.status(201).json(tagDispute({
        receiptId: req.params.receiptId,
        ...parsed.data,
      }) ?? { ok: true });
    });

    router.post("/alerts/replay", (req, res) => {
      const parsed = replayBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
        return;
      }
      recordReplayAlert(parsed.data);
      res.status(201).json({ ok: true });
    });

    return router;
  }

  return {
    ledger,
    protect,
    router,
    providerSnapshot,
    leaderboard,
    compareProviders,
    bestQuote,
    spendSnapshot,
    verifyReceipt,
    tagDispute,
    recordReplayAlert,
  };
}
