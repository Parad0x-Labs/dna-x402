import crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import bs58 from "bs58";
import nacl from "tweetnacl";

function makeSignedReceipt(receiptId: string) {
  const keypair = nacl.sign.keyPair();
  const payload = {
    receiptId,
    quoteId: "quote-123",
    commitId: "commit-123",
    resource: "/resource",
    payerCommitment32B: "0x" + "ab".repeat(32),
    recipient: "3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz",
    mint: "So11111111111111111111111111111111111111112",
    amountAtomic: "1000",
    feeAtomic: "0",
    totalAtomic: "1000",
    settlement: "netting",
    settledOnchain: false,
    createdAt: new Date().toISOString(),
  };
  const prevHash = "0".repeat(64);
  const receiptHash = crypto.createHash("sha256").update(JSON.stringify({ prevHash, payload })).digest("hex");
  const signature = bs58.encode(nacl.sign.detached(Buffer.from(receiptHash, "hex"), keypair.secretKey));
  return {
    payload,
    prevHash,
    receiptHash,
    signerPublicKey: bs58.encode(keypair.publicKey),
    signature,
  };
}

test("control room renders and simulated demo timeline runs", async ({ page }) => {
  const receipt = makeSignedReceipt("receipt-test-1");

  await page.route("**/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        cluster: "solana-devnet",
        build: { version: "test", commit: "test-commit" },
        programs: {
          paymentProgramId: "pdx_test",
          receiptAnchorProgramId: "anchor_test",
        },
        pauseFlags: { market: false, orders: false, finalize: false },
        anchoring: { enabled: true, programId: "anchor_test" },
      }),
    });
  });

  await page.route("**/market/snapshot", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        fastCount24h: 9,
        verifiedCount24h: 4,
        topCapabilitiesByDemandVelocity: [{ key: "ai_inference", value: 1.2 }],
        medianPriceByCapability: { ai_inference: "1000" },
        sellerDensityByCapability: { ai_inference: 2 },
        volatilityScoreByCapability: { ai_inference: 0.2 },
        recommendedProviders: [],
      }),
    });
  });

  await page.route("**/market/top-selling**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        window: "24h",
        verificationTier: "FAST",
        results: [{ key: "ai_inference", value: 3 }],
      }),
    });
  });

  await page.route("**/market/trending**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        window: "1h",
        verificationTier: "FAST",
        results: [{ key: "ai_inference", value: 0.9 }],
      }),
    });
  });

  await page.route("**/market/on-sale**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        window: "24h",
        results: [{ key: "ai_inference", value: 0.12 }],
      }),
    });
  });

  await page.route("**/market/anchoring/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        enabled: true,
        queueDepth: 0,
        anchoredCount: 7,
        lastFlushAt: new Date().toISOString(),
        lastAnchorSig: "sig-test-anchor",
        lastBucketId: "42",
        lastBucketCount: 7,
      }),
    });
  });

  await page.route("**/demo/ping", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, serverTime: new Date().toISOString(), requestId: "r1" }),
    });
  });

  await page.route("**/resource", async (route, request) => {
    const commitHeader = request.headers()["x-dnp-commit-id"];
    if (commitHeader) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: "resource payload" }),
      });
      return;
    }

    await route.fulfill({
      status: 402,
      contentType: "application/json",
      body: JSON.stringify({
        error: "payment_required",
        paymentRequirements: {
          version: "x402-dnp-v1",
          quote: {
            amount: "1000",
            mint: "So11111111111111111111111111111111111111112",
            recipient: "3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            settlement: ["transfer", "stream", "netting"],
            memoHash: "memo",
            quoteId: "quote-123",
            feeAtomic: "0",
            totalAtomic: "1000",
          },
          accepts: [],
          recommendedMode: "netting",
          commitEndpoint: "http://localhost:8080/commit",
          finalizeEndpoint: "http://localhost:8080/finalize",
          receiptEndpoint: "http://localhost:8080/receipt/:receiptId",
        },
      }),
    });
  });

  await page.route("**/commit", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ commitId: "commit-123" }),
    });
  });

  await page.route("**/finalize", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, receiptId: "receipt-test-1" }),
    });
  });

  await page.route("**/receipt/receipt-test-1", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(receipt),
    });
  });

  await page.route("**/anchoring/receipt/receipt-test-1", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        anchored: {
          receiptId: "receipt-test-1",
          signature: "sig-test-anchor",
          bucketId: "42",
          bucketPda: "bucket-test",
          anchoredAt: new Date().toISOString(),
        },
      }),
    });
  });

  await page.goto("/agent/control-room");

  await expect(page.getByRole("heading", { name: "Health" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Market snapshot" })).toBeVisible();

  await page.getByRole("button", { name: "Run Live Demo" }).click();

  await expect(page.getByText("SIMULATED mode: no wallet")).toBeVisible();
  await expect(page.getByText("Retry returned 200")).toBeVisible();
  await expect(page.getByText("Receipt verified: true")).toBeVisible();
});
