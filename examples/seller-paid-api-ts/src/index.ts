import express from "express";
import { dnaPrice, dnaSeller } from "dna-x402/seller";

export function createSellerApp() {
  const app = express();
  app.use(express.json());

  const recipient = process.env.SELLER_RECIPIENT_WALLET ?? "seller-wallet-placeholder";
  const priceAtomic = process.env.SELLER_PRICE_ATOMIC ?? "100000";

  dnaSeller(app, {
    recipient,
    network: "devnet",
    unsafeUnverifiedNettingEnabled: true,
  });

  app.get("/api/summary", dnaPrice(priceAtomic), (_req, res) => {
    res.json({
      ok: true,
      result: "paid seller data",
      generatedAt: new Date(0).toISOString(),
    });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3101);
  createSellerApp().listen(port, "127.0.0.1", () => {
    console.log(`seller-paid-api: listening on http://127.0.0.1:${port}`);
    console.log("seller-paid-api: protected route /api/summary");
  });
}
