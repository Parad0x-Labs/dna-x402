import { describe, expect, it } from "vitest";
import BN from "bn.js";
import { StreamingService, StreamClientLike } from "../src/streaming.js";

class MockStreamClient implements StreamClientLike {
  async create() {
    return {
      txId: "create-tx",
      metadataId: "stream-meta-1",
      ixs: [],
    };
  }

  async topup() {
    return {
      txId: "topup-tx",
      ixs: [],
    };
  }

  async getOne() {
    return {
      sender: "sender",
      recipient: "recipient",
      mint: "mint",
      depositedAmount: new BN("1000"),
      withdrawnAmount: new BN("200"),
      canTopup: true,
      closed: false,
    } as any;
  }
}

describe("streaming wrapper", () => {
  it("supports create/topup/get APIs", async () => {
    const service = new StreamingService({
      clusterUrl: "https://api.devnet.solana.com",
      client: new MockStreamClient(),
    });

    const created = await service.createStream({
      sender: { publicKey: null } as any,
      recipient: "recipient",
      mint: "mint",
      amountAtomic: "1000",
      durationSeconds: 100,
      periodSeconds: 10,
    });

    expect(created.streamId).toBe("stream-meta-1");

    const topup = await service.topupStream({
      invoker: { publicKey: null } as any,
      streamId: created.streamId,
      amountAtomic: "50",
    });

    expect(topup.txId).toBe("topup-tx");

    const state = await service.getStream(created.streamId);
    expect(state.depositedAmountAtomic).toBe("1000");
    expect(state.withdrawnAmountAtomic).toBe("200");
  });
});
