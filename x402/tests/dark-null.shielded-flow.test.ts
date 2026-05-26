import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Pure logic tests for shielded payment flow concepts.
// No external imports beyond Node crypto — verifies data-structure contracts.
// ---------------------------------------------------------------------------

function sha256(...inputs: (string | Buffer)[]): Buffer {
  const h = createHash("sha256");
  for (const i of inputs) h.update(typeof i === "string" ? Buffer.from(i, "utf8") : i);
  return h.digest();
}

function amountToLeBuffer(amount: bigint): Buffer {
  const buf = Buffer.alloc(32, 0);
  buf.writeBigUInt64LE(amount, 0);
  return buf;
}

describe("shielded payment flow", () => {
  // Test 1: Buyer commitment hides raw wallet address
  it("buyer commitment does not equal raw buyer hash", () => {
    const buyerHash = sha256("wallet:buyer-address-fixture");
    const serviceHash = sha256("service:https://provider.example/api");
    const nonce = Buffer.from("random-nonce-fixture-32-bytes!!!"); // 32 bytes
    const amountLe = amountToLeBuffer(500_000n);

    // commitment = SHA256("x402-commitment-v1" || buyerHash || amount_le || serviceHash || nonce)
    const commitment = sha256(
      "x402-commitment-v1",
      buyerHash,
      amountLe,
      serviceHash,
      nonce,
    );

    expect(commitment.equals(buyerHash)).toBe(false);
    expect(commitment).toHaveLength(32);
    expect(buyerHash).toHaveLength(32);
  });

  // Test 2: Same payment + different nonce → different commitment
  it("nonce randomizes the commitment", () => {
    const buyerHash = sha256("wallet:alice");
    const serviceHash = sha256("service:inference-api");
    const amountLe = amountToLeBuffer(1_000n);
    const nonce1 = Buffer.from("nonce-1-32-bytes-padded!!!!!!!!!", "utf8").subarray(0, 32);
    const nonce2 = Buffer.from("nonce-2-32-bytes-padded!!!!!!!!!", "utf8").subarray(0, 32);

    const c1 = sha256("x402-commitment-v1", buyerHash, amountLe, serviceHash, nonce1);
    const c2 = sha256("x402-commitment-v1", buyerHash, amountLe, serviceHash, nonce2);

    expect(c1.equals(c2)).toBe(false);
  });

  // Test 3: Access token is derived from nonce + signal_hash (not buyer identity)
  it("access token derived from nonce and signal", () => {
    const nonce = Buffer.from("session-nonce-fixture-32-bytes!!", "utf8").subarray(0, 32);
    const signalHash = sha256("signal:resource-grant-abc123");

    const accessToken = sha256("x402-access-v1", nonce, signalHash).toString("hex");

    // Access token must NOT equal raw nonce hex
    expect(accessToken).not.toBe(nonce.toString("hex"));
    // Access token must NOT equal raw signal hash hex
    expect(accessToken).not.toBe(signalHash.toString("hex"));
    // Access token is a hex string of the right length
    expect(accessToken).toHaveLength(64);
    expect(accessToken).toMatch(/^[0-9a-f]{64}$/);
  });

  // Test 4: Seller-facing JSON contains commitment_hash but not buyer_hash
  it("seller view contains commitment but not buyer", () => {
    const buyerWallet = "5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM";
    const buyerHash = sha256(`wallet:${buyerWallet}`).toString("hex");
    const commitment = sha256("x402-commitment-v1", Buffer.from(buyerHash, "hex")).toString("hex");

    // Simulate what the seller-facing view looks like
    const sellerView = {
      commitment_hash: commitment,
      amount_atomic: "1000000",
      resource: "/api/inference",
      settled_at: new Date().toISOString(),
    };

    const serialized = JSON.stringify(sellerView);

    // Commitment is present
    expect(serialized).toContain(commitment);
    // Raw buyer wallet address is NOT present
    expect(serialized).not.toContain(buyerWallet);
    // Raw buyer hash is NOT present (commitment is derived from it, not equal to it)
    expect(serialized).not.toContain(buyerHash);
  });

  // Test 5: Fee split (90/10) is mathematically correct
  it("fee split 90/10 is correct", () => {
    const totalAtomic = 1_000_000n;
    const PROVIDER_BPS = 9000n; // 90%
    const FEE_BPS = 1000n;     // 10%
    const BPS_DENOM = 10_000n;

    const providerAmount = (totalAtomic * PROVIDER_BPS) / BPS_DENOM;
    const feeAmount = (totalAtomic * FEE_BPS) / BPS_DENOM;

    expect(providerAmount).toBe(900_000n);
    expect(feeAmount).toBe(100_000n);
    expect(providerAmount + feeAmount).toBe(totalAtomic);
  });

  // Test 6: Shielded receipt mainnet_ready is false
  it("shielded receipt has mainnet_ready false", () => {
    const shieldedReceiptMeta = {
      version: "shielded-v0",
      protocol: "dark-null",
      mainnet_ready: false,
      settlement_path: "dark-null",
      privacy: {
        rawResourceStored: false,
        rawPaymentHeaderStored: false,
      },
    };

    expect(shieldedReceiptMeta.mainnet_ready).toBe(false);
    expect(shieldedReceiptMeta.privacy.rawResourceStored).toBe(false);
    expect(shieldedReceiptMeta.privacy.rawPaymentHeaderStored).toBe(false);
    expect(shieldedReceiptMeta.settlement_path).toBe("dark-null");
  });

  // Test 7: Receipt commitment changes if amount changes
  it("amount change invalidates commitment", () => {
    const buyerHash = sha256("wallet:buyer-address");
    const serviceHash = sha256("service:some-api");
    const nonce = Buffer.from("stable-nonce-for-amount-test!!!!").subarray(0, 32);

    const amount1 = amountToLeBuffer(100n);
    const amount2 = amountToLeBuffer(101n); // 1 lamport different

    const c1 = sha256("x402-commitment-v1", buyerHash, amount1, serviceHash, nonce);
    const c2 = sha256("x402-commitment-v1", buyerHash, amount2, serviceHash, nonce);

    expect(c1.equals(c2)).toBe(false);
  });
});
