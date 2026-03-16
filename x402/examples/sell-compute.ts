/**
 * DNA x402 — Sell Your Compute in 10 Lines
 *
 * This is the "I have an AI model / GPU / API and I want to get paid" example.
 * No separate DNA server needed. Everything runs in your Express app.
 *
 * Run:
 *   npx tsx examples/sell-compute.ts
 *
 * Test:
 *   curl http://localhost:3000/                          # free — see prices
 *   curl http://localhost:3000/api/inference             # 402 — payment required
 *   curl http://localhost:3000/health                    # server status
 */
import express from "express";
import { dnaSeller, dnaPrice } from "../src/sdk/seller.js";

const app = express();
app.use(express.json());

// ── 1. Initialize DNA payments (one line) ──────────────────────
const pay = dnaSeller(app, {
  recipient: "YOUR_SOLANA_WALLET_ADDRESS",  // <-- your wallet
});

// ── 2. Free endpoint — show what you sell ──────────────────────
app.get("/", (_req, res) => {
  res.json({
    service: "My AI Inference",
    pricing: {
      "/api/inference":   "$0.005 per call",
      "/api/embedding":   "$0.001 per call",
      "/api/batch":       "$0.05 per call",
    },
    payment: "DNA x402 — USDC on Solana",
    how: "Any x402-compatible agent can call these endpoints and pay automatically.",
  });
});

// ── 3. Paid endpoints — just add dnaPrice() ────────────────────
app.get("/api/inference", dnaPrice("5000", pay), (_req, res) => {
  res.json({ model: "llama-3", result: "The answer is 42.", tokens: 847 });
});

app.get("/api/embedding", dnaPrice("1000", pay), (_req, res) => {
  res.json({ model: "embed-v2", vector: [0.1, 0.2, 0.3, 0.4], dims: 4 });
});

app.post("/api/batch", dnaPrice("50000", pay), (req, res) => {
  const items = req.body?.items ?? [];
  res.json({ processed: items.length, results: items.map(() => "done") });
});

// ── Done. Start. ───────────────────────────────────────────────
app.listen(3000, () => {
  console.log("Selling compute at http://localhost:3000");
  console.log("Wallet: YOUR_SOLANA_WALLET_ADDRESS");
  console.log("");
  console.log("Endpoints:");
  console.log("  GET  /                → free (price list)");
  console.log("  GET  /api/inference   → $0.005 (verified transfer)");
  console.log("  GET  /api/embedding   → $0.001 (verified transfer)");
  console.log("  POST /api/batch       → $0.05  (verified transfer)");
  console.log("");
  console.log("Any x402 agent can pay and access these automatically.");
});
