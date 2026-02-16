import { describe, expect, it } from "vitest";
import BN from "bn.js";
import { verifyStreamflowProof } from "../src/verifier/streamflow.js";

describe("streamflow verifier", () => {
  it("accepts valid active stream proof", async () => {
    const client: any = {
      async getOne() {
        return {
          recipient: "provider-wallet",
          mint: "usdc-mint",
          depositedAmount: new BN("5000"),
          withdrawnAmount: new BN("1000"),
          closed: false,
        };
      },
    };

    const verified = await verifyStreamflowProof(client, {
      streamId: "stream-1",
      expectedRecipient: "provider-wallet",
      expectedMint: "usdc-mint",
      minFundedAtomic: "3000",
    });

    expect(verified.ok).toBe(true);
    expect(verified.fundedAtomic).toBe("4000");
  });

  it("rejects wrong recipient", async () => {
    const client: any = {
      async getOne() {
        return {
          recipient: "wrong-wallet",
          mint: "usdc-mint",
          depositedAmount: new BN("5000"),
          withdrawnAmount: new BN("0"),
          closed: false,
        };
      },
    };

    const verified = await verifyStreamflowProof(client, {
      streamId: "stream-2",
      expectedRecipient: "provider-wallet",
      expectedMint: "usdc-mint",
      minFundedAtomic: "1",
    });

    expect(verified.ok).toBe(false);
    expect(verified.error).toContain("wrong recipient");
  });

  it("rejects insufficient funded amount", async () => {
    const client: any = {
      async getOne() {
        return {
          recipient: "provider-wallet",
          mint: "usdc-mint",
          depositedAmount: new BN("100"),
          withdrawnAmount: new BN("90"),
          closed: false,
        };
      },
    };

    const verified = await verifyStreamflowProof(client, {
      streamId: "stream-3",
      expectedRecipient: "provider-wallet",
      expectedMint: "usdc-mint",
      minFundedAtomic: "50",
    });

    expect(verified.ok).toBe(false);
    expect(verified.error).toContain("insufficient");
  });
});
