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
      txSignature: "5PjDJaPFDdw8RjTwd1PAZnFUSJj6Qfg4D5UrrM4utgYwDykcKhj7x8YxYwDmg9iP4W8VdM4pcftrfP5UiQ8H8xg7",
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
      txSignature: "5PjDJaPFDdw8RjTwd1PAZnFUSJj6Qfg4D5UrrM4utgYwDykcKhj7x8YxYwDmg9iP4W8VdM4pcftrfP5UiQ8H8xg8",
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
      txSignature: "5PjDJaPFDdw8RjTwd1PAZnFUSJj6Qfg4D5UrrM4utgYwDykcKhj7x8YxYwDmg9iP4W8VdM4pcftrfP5UiQ8H8xg9",
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
      txSignature: "5PjDJaPFDdw8RjTwd1PAZnFUSJj6Qfg4D5UrrM4utgYwDykcKhj7x8YxYwDmg9iP4W8VdM4pcftrfP5UiQ8H8xgA",
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
      txSignature: "5PjDJaPFDdw8RjTwd1PAZnFUSJj6Qfg4D5UrrM4utgYwDykcKhj7x8YxYwDmg9iP4W8VdM4pcftrfP5UiQ8H8xgB",
      expectedMint: "usdc-mint",
      expectedRecipient: "recipient-wallet",
      minAmountAtomic: "500",
      maxAgeSeconds: 900,
    });

    expect(verified.ok).toBe(false);
    expect(verified.error).toContain("wrong recipient");
  });

  it("fails fast with INVALID_PROOF for malformed signatures", async () => {
    const connection: any = {
      async getSignatureStatus() {
        throw new Error("should not call rpc for invalid signature");
      },
      async getParsedTransaction() {
        throw new Error("should not call rpc for invalid signature");
      },
      async getBlockTime() {
        throw new Error("should not call rpc for invalid signature");
      },
    };

    const verified = await verifySplTransferProof(connection, {
      txSignature: "bad_sig",
      expectedMint: "usdc-mint",
      expectedRecipient: "recipient-wallet",
      minAmountAtomic: "1",
      maxAgeSeconds: 900,
    });

    expect(verified.ok).toBe(false);
    expect(verified.errorCode).toBe("INVALID_PROOF");
  });

  it("maps retryable rpc errors to RPC_UNAVAILABLE", async () => {
    const connection: any = {
      async getSignatureStatus() {
        throw new Error("429 Too Many Requests");
      },
      async getParsedTransaction() {
        throw new Error("unused");
      },
      async getBlockTime() {
        throw new Error("unused");
      },
    };

    const verified = await verifySplTransferProof(connection, {
      txSignature: "5PjDJaPFDdw8RjTwd1PAZnFUSJj6Qfg4D5UrrM4utgYwDykcKhj7x8YxYwDmg9iP4W8VdM4pcftrfP5UiQ8H8xg7",
      expectedMint: "usdc-mint",
      expectedRecipient: "recipient-wallet",
      minAmountAtomic: "1",
      maxAgeSeconds: 900,
    });

    expect(verified.ok).toBe(false);
    expect(verified.errorCode).toBe("RPC_UNAVAILABLE");
    expect(verified.retryable).toBe(true);
  });
});
