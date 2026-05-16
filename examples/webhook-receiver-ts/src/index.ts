import crypto from "node:crypto";
import express from "express";

export function verifyWebhookBody(rawBody: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function createWebhookApp(secret = process.env.DNA_WEBHOOK_SECRET ?? "dev-secret") {
  const app = express();
  app.use(express.text({ type: "*/*" }));

  app.post("/webhooks/dna", (req, res) => {
    const signature = req.header("x-dna-signature") ?? "";
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    if (!signature || !verifyWebhookBody(body, signature, secret)) {
      res.status(401).json({ ok: false, error: "bad_signature" });
      return;
    }
    res.json({ ok: true });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3201);
  createWebhookApp().listen(port, "127.0.0.1", () => {
    console.log(`webhook-receiver: listening on http://127.0.0.1:${port}`);
    console.log("webhook-receiver: POST /webhooks/dna");
  });
}
