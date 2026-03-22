/**
 * DNA x402 — Seller API Example
 *
 * An API provider that gates endpoints behind DNA micropayments.
 * Any AI agent with DNA SDK can pay and access these endpoints.
 *
 * Run:
 *   RECIPIENT=<your-solana-wallet> npx tsx examples/seller-api.ts
 */
import express from "express";
import { loadSdk } from "./_runtime.js";

const { dnaPaywall } = await loadSdk();

const app = express();
app.use(express.json());

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Set ${name} before running this example.`);
  }
  return value;
}

const RECIPIENT = requireEnv("RECIPIENT");

// Public endpoint — no payment required
app.get("/", (_req, res) => {
  res.json({
    service: "My AI Inference API",
    endpoints: {
      "/api/cheap":   { price: "$0.001", description: "Basic text completion" },
      "/api/premium":  { price: "$0.01",  description: "Advanced inference" },
      "/api/bulk":     { price: "$0.10",  description: "Batch processing" },
    },
    payment: "DNA x402 (USDC on Solana)",
  });
});

// Cheap endpoint — $0.001 per call
app.use("/api/cheap", dnaPaywall({
  priceAtomic: "1000",
  recipient: RECIPIENT,
  settlement: ["transfer"],
}));

app.get("/api/cheap", (_req, res) => {
  res.json({ result: "Hello from cheap endpoint", model: "basic-v1" });
});

// Premium endpoint — $0.01 per call
app.use("/api/premium", dnaPaywall({
  priceAtomic: "10000",
  recipient: RECIPIENT,
  settlement: ["transfer"],
}));

app.get("/api/premium", (_req, res) => {
  res.json({ result: "Premium inference result", model: "advanced-v2", tokens: 1500 });
});

// Bulk endpoint — $0.10 per call + API key required
app.use("/api/bulk", dnaPaywall({
  priceAtomic: "100000",
  recipient: RECIPIENT,
  settlement: ["transfer"],
  requireApiKey: true,
  apiKeys: new Set(["demo-key-123"]),
}));

app.get("/api/bulk", (_req, res) => {
  res.json({ result: "Bulk processing complete", items: 1000 });
});

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => {
  console.log(`Seller API running on http://localhost:${PORT}`);
  console.log(`Recipient wallet: ${RECIPIENT}`);
  console.log("\nEndpoints:");
  console.log("  GET /              — Service info (free)");
  console.log("  GET /api/cheap     — $0.001 (verified transfer)");
  console.log("  GET /api/premium   — $0.01  (verified transfer)");
  console.log("  GET /api/bulk      — $0.10  (transfer only, API key required)");
});
