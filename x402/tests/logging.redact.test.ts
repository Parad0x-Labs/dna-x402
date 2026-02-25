import { describe, expect, it } from "vitest";
import { redactSensitiveHeaders, redactValue } from "../src/logging/redact.js";

describe("redaction", () => {
  it("redacts payment headers and keeps length marker", () => {
    const headers = redactSensitiveHeaders({
      "payment-signature": "very-long-proof-value-1234567890",
      "x-payment": "another-proof-value-abcdef",
      "content-type": "application/json",
    });

    expect(headers["payment-signature"]).toContain("len=");
    expect(headers["payment-signature"]).not.toContain("very-long-proof-value-1234567890");
    expect(headers["x-payment"]).toContain("len=");
    expect(headers["content-type"]).toBeUndefined();
  });

  it("redacts objects safely", () => {
    const redacted = redactValue({ txSig: "tx-123", nested: { a: 1 } });
    expect(redacted).toContain("len=");
  });
});
