/**
 * DNA x402 — Seller API Example
 *
 * An API provider that gates endpoints behind DNA micropayments.
 * Any AI agent with DNA SDK can pay and access these endpoints.
 *
 * Run:
 *   npx tsx examples/seller-api.ts
 */
import express from "express";
import { dnaPaywall, apiKeyGuard } from "../src/sdk/index.js";

const app = express();
app.use(express.json());

const RECIPIENT = process.env.RECIPIENT ?? "7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ";

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
  settlement: ["netting", "transfer"],
}));

app.get("/api/cheap", (_req, res) => {
  res.json({ result: "Hello from cheap endpoint", model: "basic-v1" });
});

// Premium endpoint — $0.01 per call
app.use("/api/premium", dnaPaywall({
  priceAtomic: "10000",
  recipient: RECIPIENT,
  settlement: ["netting", "transfer"],
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
  console.log("  GET /api/cheap     — $0.001 (netting or transfer)");
  console.log("  GET /api/premium   — $0.01  (netting or transfer)");
  console.log("  GET /api/bulk      — $0.10  (transfer only, API key required)");
});
