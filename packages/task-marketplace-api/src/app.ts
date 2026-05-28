/**
 * NULL Miner Task Marketplace API
 *
 * REST API that serves tasks to SDK agents and processes proof submissions.
 * SDK agents call this automatically — platform developers don't touch it directly.
 *
 * Routes:
 *   GET  /health                   — liveness probe
 *   GET  /tasks                    — list available tasks (filtered by tier)
 *   GET  /tasks/:id                — get single task
 *   POST /tasks/:id/claim          — claim a task for execution
 *   POST /tasks/:id/proof          — submit proof → USDC release
 *   GET  /platform/:id/stats       — platform earnings dashboard
 *   POST /tasks                    — post a new task (enterprise task posters)
 */

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { createHash } from "crypto";
import { taskStore, type ReputationTier } from "./store.js";

const app = express();

app.use(cors());
app.use(express.json());

// ── Request logging ───────────────────────────────────────────────────────────

app.use((req: Request, _res: Response, next: NextFunction) => {
  const passport = req.headers["x-passport-id"] as string | undefined;
  const platform = req.headers["x-platform-id"] as string | undefined;
  console.log(`[API] ${req.method} ${req.path} passport=${passport?.slice(0,12) ?? "anon"} platform=${platform ?? "anon"}`);
  next();
});

// ── Health ────────────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "null-miner-marketplace", ts: Date.now() });
});

// ── GET /tasks — list available tasks ─────────────────────────────────────────

app.get("/tasks", (req: Request, res: Response) => {
  const passportId = req.headers["x-passport-id"] as string | undefined;
  const platformId = req.headers["x-platform-id"] as string | string[] | undefined;
  const tier       = (req.headers["x-tier"] as ReputationTier | undefined) ?? "bronze";

  if (!passportId) {
    res.status(401).json({ error: "X-Passport-Id header required" });
    return;
  }

  const platform = Array.isArray(platformId) ? platformId[0] : platformId ?? "unknown";
  const tasks    = taskStore.getAvailable(tier, platform);

  // Return tasks sorted by reward descending (agent will pick best)
  const sorted = tasks.sort((a, b) => b.rewardUsdc - a.rewardUsdc);
  res.json(sorted);
});

// ── GET /tasks/:id ────────────────────────────────────────────────────────────

app.get("/tasks/:id", (req: Request, res: Response) => {
  const id   = String(req.params["id"] ?? "");
  const task = taskStore.get(id);
  if (!task) { res.status(404).json({ error: "task not found" }); return; }
  res.json(task);
});

// ── POST /tasks/:id/claim ─────────────────────────────────────────────────────

app.post("/tasks/:id/claim", (req: Request, res: Response) => {
  const passportId = req.headers["x-passport-id"] as string | undefined;
  const platformId = req.headers["x-platform-id"] as string | string[] | undefined;

  if (!passportId) {
    res.status(401).json({ error: "X-Passport-Id header required" });
    return;
  }

  const platform = (Array.isArray(platformId) ? platformId[0] : platformId) ?? "unknown";
  const id       = String(req.params["id"] ?? "");
  const result   = taskStore.claim(id, passportId, platform);

  if (!result.ok) {
    res.status(409).json({ error: result.error });
    return;
  }

  const task = taskStore.get(id);
  res.json({ ok: true, task });
});

// ── POST /tasks/:id/proof — submit proof, release USDC ────────────────────────

app.post("/tasks/:id/proof", (req: Request, res: Response) => {
  const passportId = req.headers["x-passport-id"] as string | undefined;
  const platformId = req.headers["x-platform-id"] as string | string[] | undefined;

  if (!passportId) {
    res.status(401).json({ error: "X-Passport-Id header required" });
    return;
  }

  const { proofHash } = req.body as { proofHash?: string };
  if (!proofHash) {
    res.status(400).json({ error: "proofHash required in body" });
    return;
  }

  const platform = (Array.isArray(platformId) ? platformId[0] : platformId) ?? "unknown";
  const id       = String(req.params["id"] ?? "");

  // Allow proof mismatch only when explicitly opted in via env var (local devnet only).
  const allowProofMismatch = process.env["NULL_MINER_DEV_ALLOW_PROOF_MISMATCH"] === "true";
  const result = taskStore.complete(id, passportId, platform, proofHash, { allowProofMismatch });

  if (!result.ok) {
    // 422 Unprocessable for proof hash mismatch — distinct from 409 conflict
    const status = result.error === "proof hash mismatch" ? 422 : 409;
    res.status(status).json({ error: result.error });
    return;
  }

  // In production: trigger dark-agent-escrow release on Solana here
  res.json({
    ok:         true,
    usdcEarned: result.usdcEarned,
    nullYield:  result.nullYield,
    // stealthAddress: derived from passportId + taskId (production)
    receipt: {
      txHash:    sha256(passportId + id + Date.now().toString()),
      slot:      Math.floor(Date.now() / 400),
      anchored:  false, // true in production after Solana tx confirm
    },
  });
});

// ── GET /platform/:id/stats ───────────────────────────────────────────────────

app.get("/platform/:id/stats", (req: Request, res: Response) => {
  const id          = String(req.params["id"] ?? "");
  const completions = taskStore.getCompletions(id);
  const totalUsdc   = completions.reduce((sum, c) => sum + c.usdcEarned, 0);
  const totalNull   = completions.reduce((sum, c) => sum + c.nullYield, 0);
  const platformFee = totalUsdc * 0.1 / 0.9; // 10% of gross

  res.json({
    platformId:         id,
    tasksCompleted:     completions.length,
    agentUsdcPaid:      totalUsdc,
    platformFeeEarned:  platformFee,
    nullEmitted:        totalNull,
    lastUpdated:        Date.now(),
  });
});

// ── POST /tasks — enterprise task posting ─────────────────────────────────────

app.post("/tasks", (req: Request, res: Response) => {
  // Simplified — production requires signed auth + escrow deposit first
  const body = req.body as {
    kind?: string;
    rewardUsdc?: number;
    ttlSeconds?: number;
    proofHash?: string;
    minTier?: string;
    encryptedPayload?: string;
  };

  const { kind, rewardUsdc, ttlSeconds, proofHash, minTier, encryptedPayload } = body;

  if (!kind || !rewardUsdc || !proofHash) {
    res.status(400).json({ error: "kind, rewardUsdc, proofHash required" });
    return;
  }

  const slot   = Math.floor(Date.now() / 400);
  const ttl    = Math.floor((ttlSeconds ?? 3600) / 0.4); // seconds → slots
  const taskId = sha256(kind + rewardUsdc + Date.now());

  // Injected directly into store (production: verify escrow deposit on Solana first)
  const task = {
    taskId,
    kind:             kind as "residential_relay",
    rewardUsdc,
    expiresAtSlot:    slot + ttl,
    minTier:          (minTier ?? "bronze") as "bronze",
    posterId:         req.headers["x-platform-id"] as string ?? "unknown",
    claimedBy:        null,
    claimedAt:        null,
    completed:        false,
    completedAt:      null,
    createdAt:        Date.now(),
    encryptedPayload,
    proofRequirements: { expectedProofHash: proofHash },
  };

  (taskStore as unknown as Record<string, Map<string, typeof task>>)["tasks"]?.set(taskId, task);

  res.status(201).json({ taskId, ok: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export default app;
