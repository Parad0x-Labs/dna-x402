import { describe, expect, it } from "vitest";
import {
  WithdrawalIntentStore,
  assertWithdrawalRouteUnchanged,
  createQuotedWithdrawalIntent,
  expireAwaitingUserTransfer,
  invalidateIntentForRouteChange,
} from "../src/polymarket/withdrawals.js";

const baseQuote = {
  id: "wi-1",
  userId: "user-1",
  agentId: "agent-1",
  depositWallet: "0xDepositWallet",
  sourceAmountPusd: "10000000",
  destinationChain: "solana",
  destinationToken: "USDC",
  recipientAddress: "So11111111111111111111111111111111111111112",
  quoteId: "quote-1",
  quotePayload: { quoteId: "quote-1", route: "pusd-to-solana-usdc" },
  quoteExpiresAt: "2026-05-14T12:10:00.000Z",
  minReceived: "9900000",
  estimatedReceived: "9990000",
  fees: { gasUsd: 0 },
  slippage: { maxBps: 10 },
  now: new Date("2026-05-14T12:00:00.000Z"),
};

describe("polymarket withdrawal intents", () => {
  it("quote preview creates no withdrawal address and final confirmation creates one", () => {
    const store = new WithdrawalIntentStore();
    const quoted = store.createQuote(baseQuote);

    expect(quoted.status).toBe("QUOTED");
    expect(quoted.withdrawalAddress).toBeUndefined();

    store.confirm("wi-1", new Date("2026-05-14T12:01:00.000Z"));
    const addressed = store.createWithdrawalAddress("wi-1", "0xBridgeAddress", new Date("2026-05-14T12:02:00.000Z"));

    expect(addressed.status).toBe("WITHDRAW_ADDRESS_CREATED");
    expect(addressed.withdrawalAddress).toBe("0xBridgeAddress");
  });

  it("quote expiry and route changes invalidate execution", () => {
    const intent = createQuotedWithdrawalIntent(baseQuote);

    expect(() => assertWithdrawalRouteUnchanged(intent, {
      sourceAmountPusd: "11000000",
      destinationChain: "solana",
      destinationToken: "USDC",
      recipientAddress: baseQuote.recipientAddress,
    })).toThrow(/sourceAmountPusd/);

    expect(() => assertWithdrawalRouteUnchanged(intent, {
      sourceAmountPusd: baseQuote.sourceAmountPusd,
      destinationChain: "base",
      destinationToken: "USDC",
      recipientAddress: baseQuote.recipientAddress,
    })).toThrow(/destinationChain/);

    expect(() => assertWithdrawalRouteUnchanged(intent, {
      sourceAmountPusd: baseQuote.sourceAmountPusd,
      destinationChain: "solana",
      destinationToken: "SOL",
      recipientAddress: baseQuote.recipientAddress,
    })).toThrow(/destinationToken/);

    expect(() => assertWithdrawalRouteUnchanged(intent, {
      sourceAmountPusd: baseQuote.sourceAmountPusd,
      destinationChain: "solana",
      destinationToken: "USDC",
      recipientAddress: "Different111111111111111111111111111111111",
    })).toThrow(/recipientAddress/);
  });

  it("never reuses withdrawal addresses", () => {
    const store = new WithdrawalIntentStore();
    store.createQuote(baseQuote);
    store.confirm("wi-1", new Date("2026-05-14T12:01:00.000Z"));
    store.createWithdrawalAddress("wi-1", "0xBridgeAddress", new Date("2026-05-14T12:02:00.000Z"));

    store.createQuote({ ...baseQuote, id: "wi-2", quoteId: "quote-2", quotePayload: { quoteId: "quote-2" } });
    store.confirm("wi-2", new Date("2026-05-14T12:01:00.000Z"));
    expect(() => store.createWithdrawalAddress("wi-2", "0xBridgeAddress")).toThrow(/reuse/i);
  });

  it("handles no transfer, transfer-confirmed bridge lag, and recoverable quote failures", () => {
    const store = new WithdrawalIntentStore();
    store.createQuote(baseQuote);
    store.confirm("wi-1", new Date("2026-05-14T12:01:00.000Z"));
    store.createWithdrawalAddress("wi-1", "0xBridgeAddress", new Date("2026-05-14T12:02:00.000Z"));
    expect(store.markAwaitingUserTransfer("wi-1").status).toBe("AWAITING_USER_TRANSFER");
    expect(store.markRecoverableFailure("wi-1", "SUPPORT_NEEDED").status).toBe("SUPPORT_NEEDED");

    store.createQuote({ ...baseQuote, id: "wi-2", quoteId: "quote-2", quotePayload: { quoteId: "quote-2" } });
    store.confirm("wi-2", new Date("2026-05-14T12:01:00.000Z"));
    store.createWithdrawalAddress("wi-2", "0xBridgeAddress2", new Date("2026-05-14T12:02:00.000Z"));
    expect(store.markTransferConfirmed("wi-2", "0xTransferTx", false, new Date("2026-05-14T12:03:00.000Z")).status).toBe("PUSD_TRANSFER_CONFIRMED");

    store.createQuote({ ...baseQuote, id: "wi-3", quoteId: "quote-3", quotePayload: { quoteId: "quote-3" } });
    expect(store.markRecoverableFailure("wi-3", "ROUTE_UNAVAILABLE").status).toBe("ROUTE_UNAVAILABLE");
    expect(store.markRecoverableFailure("wi-3", "LIQUIDITY_EXHAUSTED").status).toBe("LIQUIDITY_EXHAUSTED");
  });

  it("marks expired quotes and route changes as non-executable states", () => {
    const store = new WithdrawalIntentStore();
    store.createQuote(baseQuote);
    expect(store.expireQuoteIfNeeded("wi-1", new Date("2026-05-14T12:11:00.000Z")).status).toBe("QUOTE_EXPIRED");

    const changed = invalidateIntentForRouteChange(createQuotedWithdrawalIntent({ ...baseQuote, id: "wi-2" }), {
      sourceAmountPusd: baseQuote.sourceAmountPusd,
      destinationChain: "solana",
      destinationToken: "SOL",
      recipientAddress: baseQuote.recipientAddress,
    });
    expect(changed.status).toBe("QUOTE_EXPIRED");
  });

  it("expires address-created withdrawals when the user never sends pUSD", () => {
    const store = new WithdrawalIntentStore();
    store.createQuote(baseQuote);
    store.confirm("wi-1", new Date("2026-05-14T12:01:00.000Z"));
    store.createWithdrawalAddress("wi-1", "0xBridgeAddress", new Date("2026-05-14T12:02:00.000Z"));
    const awaiting = store.markAwaitingUserTransfer("wi-1", new Date("2026-05-14T12:03:00.000Z"));

    expect(expireAwaitingUserTransfer(awaiting, {
      now: new Date("2026-05-14T12:12:59.000Z"),
      ttlMs: 10 * 60 * 1000,
    }).status).toBe("AWAITING_USER_TRANSFER");
    expect(store.expireAwaitingUserTransfer("wi-1", {
      now: new Date("2026-05-14T12:13:01.000Z"),
      ttlMs: 10 * 60 * 1000,
    }).status).toBe("SUPPORT_NEEDED");
  });

  it("tracks bridge pending, destination received, and reconciled withdrawals", () => {
    const store = new WithdrawalIntentStore();
    store.createQuote(baseQuote);
    store.confirm("wi-1", new Date("2026-05-14T12:01:00.000Z"));
    store.createWithdrawalAddress("wi-1", "0xBridgeAddress", new Date("2026-05-14T12:02:00.000Z"));
    store.markAwaitingUserTransfer("wi-1", new Date("2026-05-14T12:03:00.000Z"));
    store.markTransferSigned("wi-1", "0xTransferTx", new Date("2026-05-14T12:04:00.000Z"));
    store.markTransferConfirmed("wi-1", "0xTransferTx", false, new Date("2026-05-14T12:05:00.000Z"));

    expect(store.markBridgePending("wi-1").status).toBe("BRIDGE_PENDING");
    expect(store.markDestinationReceived("wi-1").status).toBe("DESTINATION_RECEIVED");
    expect(store.markReconciled("wi-1").status).toBe("RECONCILED");
  });
});
