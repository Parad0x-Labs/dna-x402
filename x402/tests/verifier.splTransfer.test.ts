import { describe, expect, it } from "vitest";
import { verifySplTransferProof } from "../src/verifier/splTransfer.js";

describe("strict SPL transfer verifier", () => {
  it("accepts valid confirmed transfer with correct mint/recipient/amount", async () => {
    const connection: any = {
      async getSignatureStatus() {
        return { value: { err: null } };
      },
      async getParsedTransaction() {
        return {
          slot: 123,
          blockTime: Math.floor(Date.now() / 1000),
          meta: {
            err: null,
            preTokenBalances: [
              {
                owner: "recipient-wallet",
                mint: "usdc-mint",
                uiTokenAmount: { amount: "1000" },
              },
            ],
            postTokenBalances: [
              {
                owner: "recipient-wallet",
                mint: "usdc-mint",
                uiTokenAmount: { amount: "3000" },
              },
            ],
          },
          transaction: {
            message: {
              instructions: [],
            },
          },
        };
      },
      async getBlockTime() {
        return Math.floor(Date.now() / 1000);
      },
    };

    const verified = await verifySplTransferProof(connection, {
      txSignature: "sig-1",
      expectedMint: "usdc-mint",
      expectedRecipient: "recipient-wallet",
      minAmountAtomic: "1500",
      maxAgeSeconds: 900,
    });

    expect(verified.ok).toBe(true);
    expect(verified.settledOnchain).toBe(true);
    expect(verified.amountObservedAtomic).toBe("2000");
  });

  it("rejects wrong recipient/mint or underpayment", async () => {
    const connection: any = {
      async getSignatureStatus() {
        return { value: { err: null } };
      },
      async getParsedTransaction() {
        return {
          slot: 124,
          blockTime: Math.floor(Date.now() / 1000),
          meta: {
            err: null,
            preTokenBalances: [],
            postTokenBalances: [],
          },
          transaction: {
            message: {
              instructions: [],
            },
          },
        };
      },
      async getBlockTime() {
        return Math.floor(Date.now() / 1000);
      },
    };

    const verified = await verifySplTransferProof(connection, {
      txSignature: "sig-2",
      expectedMint: "usdc-mint",
      expectedRecipient: "recipient-wallet",
      minAmountAtomic: "1",
      maxAgeSeconds: 900,
    });

    expect(verified.ok).toBe(false);
    expect(verified.error).toContain("underpaid");
  });

  it("rejects stale transfer proofs", async () => {
    const nowMs = Date.UTC(2026, 1, 16, 12, 0, 0);
    const connection: any = {
      async getSignatureStatus() {
        return { value: { err: null } };
      },
      async getParsedTransaction() {
        return {
          slot: 125,
          blockTime: Math.floor((nowMs - 5_000_000) / 1000),
          meta: {
            err: null,
            preTokenBalances: [
              { owner: "recipient-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "0" } },
            ],
            postTokenBalances: [
              { owner: "recipient-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "500" } },
            ],
          },
          transaction: {
            message: {
              instructions: [],
            },
          },
        };
      },
      async getBlockTime() {
        return Math.floor((nowMs - 5_000_000) / 1000);
      },
    };

    const verified = await verifySplTransferProof(connection, {
      txSignature: "sig-3",
      expectedMint: "usdc-mint",
      expectedRecipient: "recipient-wallet",
      minAmountAtomic: "500",
      maxAgeSeconds: 120,
      nowMs,
    });

    expect(verified.ok).toBe(false);
    expect(verified.error).toContain("too old");
  });

  it("rejects wrong mint explicitly", async () => {
    const connection: any = {
      async getSignatureStatus() {
        return { value: { err: null } };
      },
      async getParsedTransaction() {
        return {
          slot: 126,
          blockTime: Math.floor(Date.now() / 1000),
          meta: {
            err: null,
            preTokenBalances: [
              { owner: "recipient-wallet", mint: "other-mint", uiTokenAmount: { amount: "0" } },
            ],
            postTokenBalances: [
              { owner: "recipient-wallet", mint: "other-mint", uiTokenAmount: { amount: "1000" } },
            ],
          },
          transaction: {
            message: {
              instructions: [],
            },
          },
        };
      },
      async getBlockTime() {
        return Math.floor(Date.now() / 1000);
      },
    };

    const verified = await verifySplTransferProof(connection, {
      txSignature: "sig-4",
      expectedMint: "usdc-mint",
      expectedRecipient: "recipient-wallet",
      minAmountAtomic: "500",
      maxAgeSeconds: 900,
    });

    expect(verified.ok).toBe(false);
    expect(verified.error).toContain("wrong mint");
  });

  it("rejects wrong recipient explicitly", async () => {
    const connection: any = {
      async getSignatureStatus() {
        return { value: { err: null } };
      },
      async getParsedTransaction() {
        return {
          slot: 127,
          blockTime: Math.floor(Date.now() / 1000),
          meta: {
            err: null,
            preTokenBalances: [
              { owner: "other-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "0" } },
            ],
            postTokenBalances: [
              { owner: "other-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "1000" } },
            ],
          },
          transaction: {
            message: {
              instructions: [],
            },
          },
        };
      },
      async getBlockTime() {
        return Math.floor(Date.now() / 1000);
      },
    };

    const verified = await verifySplTransferProof(connection, {
      txSignature: "sig-5",
      expectedMint: "usdc-mint",
      expectedRecipient: "recipient-wallet",
      minAmountAtomic: "500",
      maxAgeSeconds: 900,
    });

    expect(verified.ok).toBe(false);
    expect(verified.error).toContain("wrong recipient");
  });
});
