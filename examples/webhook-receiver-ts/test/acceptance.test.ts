import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookBody } from "../src/index.js";

describe("webhook receiver example", () => {
  it("verifies HMAC signatures", () => {
    const body = JSON.stringify({ event: "receipt.issued" });
    const signature = crypto.createHmac("sha256", "secret").update(body).digest("hex");
    expect(verifyWebhookBody(body, signature, "secret")).toBe(true);
  });
});
