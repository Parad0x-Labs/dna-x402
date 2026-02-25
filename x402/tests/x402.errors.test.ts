import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { traceIdMiddleware } from "../src/middleware/traceId.js";
import { sendX402Error, toErrorPayload } from "../src/x402/errorResponse.js";
import { X402Error, X402ErrorCode, errorDefinition } from "../src/x402/errors.js";

describe("x402 error contract", () => {
  it("maps stable codes to status and docs anchors", () => {
    const error = new X402Error(X402ErrorCode.X402_MISSING_PAYMENT_PROOF);
    const payload = toErrorPayload(error, {
      dialectDetected: "memeputer",
      missing: ["PAYMENT-SIGNATURE|X-PAYMENT"],
      paymentRequired: "example-required-value",
      paymentProof: null,
    });

    expect(error.httpStatus).toBe(errorDefinition(X402ErrorCode.X402_MISSING_PAYMENT_PROOF).status);
    expect(payload.error.docsUrl).toContain("#error-x402-missing-payment-proof");
    expect(payload.error.hint.length).toBeGreaterThan(0);
    expect(payload.error.redacted?.paymentRequired).toContain("len=");
    expect(payload.error.redacted?.paymentProof).toBeNull();
  });

  it("returns x-trace-id header that matches body traceId", async () => {
    const app = express();
    app.use(traceIdMiddleware);
    app.get("/boom", (req, res) => {
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_PARSE_FAILED), {
        dialectDetected: "unknown",
      });
    });

    const response = await request(app).get("/boom").expect(400);
    expect(response.header["x-trace-id"]).toBeTruthy();
    expect(response.body.error.traceId).toBe(response.header["x-trace-id"]);
  });
});
