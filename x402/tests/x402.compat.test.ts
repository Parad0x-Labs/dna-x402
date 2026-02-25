import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeX402, parsePaymentProof, parsePaymentRequired } from "../src/x402/compat/parse.js";

function fixture(name: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), "tests/compat/fixtures", name), "utf8").trim();
}

describe("x402 compatibility parser", () => {
  it("parses coinbase base64 headers into canonical objects", () => {
    const requiredHeader = fixture("coinbase.payment-required.base64.txt");
    const proofHeader = fixture("coinbase.payment-signature.base64.txt");

    const requiredCtx = parsePaymentRequired({
      headers: {
        "PAYMENT-REQUIRED": requiredHeader,
      },
    });
    const proofCtx = parsePaymentProof({
      headers: {
        "PAYMENT-SIGNATURE": proofHeader,
      },
    });

    expect(requiredCtx.required?.amountAtomic).toBe("1500");
    expect(requiredCtx.required?.currency).toBe("USDC");
    expect(requiredCtx.style).toBe("coinbase");
    expect(proofCtx.proof?.txSig).toBe("tx-ok-123456789012345678901234567890");
    expect(proofCtx.style).toBe("coinbase");
  });

  it("parses memeputer and generic payloads", () => {
    const memeputerProof = fixture("memeputer.x-payment.json.txt");
    const genericBody = JSON.parse(fixture("generic.x402.json.txt"));

    const memeputerCtx = normalizeX402({
      headers: {
        "X-PAYMENT": memeputerProof,
        "X-PAYMENT-REQUIRED": fixture("coinbase.payment-required.base64.txt"),
      },
    });

    const genericCtx = normalizeX402({ body: genericBody });

    expect(memeputerCtx.style).toBe("memeputer");
    expect(memeputerCtx.proof?.txSig).toBe("tx-ok-123456789012345678901234567890");
    expect(genericCtx.required?.amountAtomic).toBe("900");
    expect(genericCtx.proof?.txSig).toBe("tx-ok-123456789012345678901234567890");
  });

  it("flags mismatch between requirement and proof hints", () => {
    const requiredHeader = fixture("coinbase.payment-required.base64.txt");
    const mismatchedProof = Buffer.from(JSON.stringify({
      txSig: "tx-ok-123456789012345678901234567890",
      scheme: "solana_spl",
      amountAtomic: "9999",
    }), "utf8").toString("base64");

    const ctx = normalizeX402({
      headers: {
        "PAYMENT-REQUIRED": requiredHeader,
        "X-PAYMENT": mismatchedProof,
      },
    });

    expect(ctx.parseWarnings.some((warning) => warning.includes("mismatch"))).toBe(true);
  });
});
