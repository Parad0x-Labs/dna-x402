/**
 * DNA Guard seller example
 *
 * Run:
 *   npx tsx examples/dna-guard-seller.ts
 *
 * Then:
 *   curl http://localhost:3003/
 *   curl http://localhost:3003/guard/leaderboard
 */
import express from "express";
import { loadSdk } from "./_runtime.js";

const { AuditLogger, createDnaGuard, dnaPrice, dnaSeller } = await loadSdk();

const app = express();
app.use(express.json());

const pay = dnaSeller(app, {
  recipient: process.env.RECIPIENT ?? "YOUR_SOLANA_WALLET_ADDRESS",
});

const audit = new AuditLogger({ filePath: "./audit-guard.ndjson" });
const guard = createDnaGuard({ auditLog: audit });

app.use("/guard", guard.router());

app.get("/", (_req, res) => {
  res.json({
    service: "DNA Guard demo seller",
    endpoints: {
      "/api/inference": "$0.005",
      "/guard/leaderboard": "provider ranking",
      "/guard/quote/best": "best provider recommendation",
      "/guard/summary": "guard rollup",
    },
  });
});

app.get("/api/inference", dnaPrice("5000", pay), guard.protect({
  providerId: "demo-seller",
  endpointId: "inference",
  amountAtomic: "5000",
  actor: (req) => ({
    buyerId: req.header("x-dna-buyer-id") ?? req.ip,
    walletAddress: req.header("x-dna-wallet") ?? undefined,
    agentId: req.header("x-dna-agent-id") ?? undefined,
    apiKeyId: req.header("x-dna-api-key-id") ?? undefined,
  }),
  spendCeilings: {
    buyerAtomic: "15000",
    walletAtomic: "25000",
    agentAtomic: "20000",
  },
  replayDetector: (req) => ({
    replay: req.header("x-dna-replay-key") === "duplicate",
    reason: "duplicate_replay_key",
  }),
  qualityValidator: (body) => ({
    ok: typeof (body as { result?: unknown }).result === "string",
    reason: "missing_result_string",
  }),
  failMode: "fail-open",
}), (_req, res) => {
  res.json({
    result: "validated inference output",
    latencyTier: "fast",
    provider: "demo-seller",
  });
});

const port = Number(process.env.PORT ?? 3003);
app.listen(port, () => {
  console.log(`DNA Guard seller demo listening on http://localhost:${port}`);
  console.log("Guard APIs:");
  console.log("  GET /guard/summary");
  console.log("  GET /guard/leaderboard");
  console.log("  GET /guard/quote/best");
  console.log("  GET /guard/reputation/demo-seller");
});
