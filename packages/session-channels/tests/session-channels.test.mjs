/**
 * Tests for @parad0x_labs/session-channels
 * Run: node --test tests/session-channels.test.mjs
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  openSession,
  recordAction,
  closeSession,
  buildSettlementPayload,
  settleSession,
} from "../src/index.ts";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const baseParams = (over = {}) => ({
  agentPubkey: "AgentPubkey1111111111111111111111111111111",
  providerPubkey: "ProviderPubkey11111111111111111111111111111",
  maxActions: 5,
  pricePerAction: 10,
  currency: "USDC",
  ...over,
});

/** Open a session and record `n` actions with distinct payloads. */
function sessionWith(n, over = {}) {
  let s = openSession(baseParams(over));
  for (let i = 0; i < n; i++) s = recordAction(s, "tool-call", `result-${i}`);
  return s;
}

/** Independent recomputation of the close receipt from the documented formula. */
function expectedReceipt(session, totalFee) {
  return sha256(
    session.actions.map((a) => a.actionId).join("|") + `|total=${totalFee}|session=${session.sessionId}`,
  );
}

// ---------------------------------------------------------------------------
// openSession
// ---------------------------------------------------------------------------

describe("openSession", () => {
  test("opens an empty channel with the requested terms", () => {
    const before = Date.now();
    const s = openSession(baseParams({ currency: "SOL", pricePerAction: 0 }));
    assert.match(s.sessionId, /^[0-9a-f]{32}$/);
    assert.equal(s.status, "open");
    assert.deepEqual(s.actions, []);
    assert.equal(s.maxActions, 5);
    assert.equal(s.pricePerAction, 0);
    assert.equal(s.currency, "SOL");
    assert.equal(s.agentPubkey, baseParams().agentPubkey);
    assert.equal(s.providerPubkey, baseParams().providerPubkey);
    assert.ok(s.openedAt >= before && s.openedAt <= Date.now());
  });

  test("session IDs are unique", () => {
    const ids = new Set(Array.from({ length: 200 }, () => openSession(baseParams()).sessionId));
    assert.equal(ids.size, 200);
  });

  test("rejects maxActions < 1", () => {
    assert.throws(() => openSession(baseParams({ maxActions: 0 })), RangeError);
    assert.throws(() => openSession(baseParams({ maxActions: -3 })), RangeError);
  });

  test("rejects non-integer or non-finite maxActions (NaN would disable the action cap)", () => {
    for (const bad of [NaN, 2.5, Infinity]) {
      assert.throws(() => openSession(baseParams({ maxActions: bad })), RangeError, String(bad));
    }
  });

  test("rejects a negative or non-finite pricePerAction", () => {
    for (const bad of [-1, -0.0001, NaN, Infinity]) {
      assert.throws(() => openSession(baseParams({ pricePerAction: bad })), RangeError, String(bad));
    }
  });

  test("requires both agent and provider pubkeys", () => {
    assert.throws(() => openSession(baseParams({ agentPubkey: "" })), TypeError);
    assert.throws(() => openSession(baseParams({ providerPubkey: "" })), TypeError);
  });
});

// ---------------------------------------------------------------------------
// recordAction
// ---------------------------------------------------------------------------

describe("recordAction", () => {
  test("appends an action with a SHA-256 digest of the string payload and the session price", () => {
    const s0 = openSession(baseParams({ pricePerAction: 7 }));
    const s1 = recordAction(s0, "llm-inference", "hello world");
    assert.equal(s1.actions.length, 1);
    const a = s1.actions[0];
    assert.equal(a.actionType, "llm-inference");
    assert.equal(a.resultDigest, sha256("hello world"));
    assert.equal(a.fee, 7);
    assert.match(a.actionId, /^[0-9a-f]{32}$/);
    assert.ok(a.executedAt >= s0.openedAt);
  });

  test("object payloads are digested via JSON.stringify", () => {
    const payload = { answer: 42, tags: ["a", "b"] };
    const s = recordAction(openSession(baseParams()), "search", payload);
    assert.equal(s.actions[0].resultDigest, sha256(JSON.stringify(payload)));
  });

  test("different payloads produce different digests", () => {
    let s = openSession(baseParams());
    s = recordAction(s, "t", "result-a");
    s = recordAction(s, "t", "result-b");
    assert.notEqual(s.actions[0].resultDigest, s.actions[1].resultDigest);
  });

  test("does not mutate the input session", () => {
    const s0 = openSession(baseParams());
    const s1 = recordAction(s0, "t", "x");
    assert.equal(s0.actions.length, 0);
    assert.notEqual(s0.actions, s1.actions);
    assert.equal(s1.sessionId, s0.sessionId);
  });

  test("enforces maxActions exactly", () => {
    const s = sessionWith(5, { maxActions: 5 });
    assert.equal(s.actions.length, 5);
    assert.throws(() => recordAction(s, "t", "one-too-many"), /reached maxActions \(5\)/);
  });

  test("maxActions = 1 allows exactly one action", () => {
    const s = recordAction(openSession(baseParams({ maxActions: 1 })), "t", "only");
    assert.throws(() => recordAction(s, "t", "second"), RangeError);
  });

  test("cannot record into a closed or settled session", () => {
    const { session: closed } = closeSession(sessionWith(1));
    assert.throws(() => recordAction(closed, "t", "late"), /is closed/);
    const settled = settleSession(closed, "sig");
    assert.throws(() => recordAction(settled, "t", "late"), /is settled/);
  });
});

// ---------------------------------------------------------------------------
// closeSession
// ---------------------------------------------------------------------------

describe("closeSession", () => {
  test("totals fees and produces the documented SHA-256 receipt", () => {
    const s = sessionWith(3, { pricePerAction: 10 });
    const { session, totalFee, receipt } = closeSession(s);
    assert.equal(totalFee, 30);
    assert.equal(session.status, "closed");
    assert.equal(receipt, expectedReceipt(s, 30));
    assert.match(receipt, /^[0-9a-f]{64}$/);
  });

  test("closing does not mutate the open session", () => {
    const s = sessionWith(1);
    closeSession(s);
    assert.equal(s.status, "open");
  });

  test("an empty session closes with zero fee", () => {
    const s = openSession(baseParams());
    const { totalFee, receipt } = closeSession(s);
    assert.equal(totalFee, 0);
    assert.equal(receipt, expectedReceipt(s, 0));
  });

  test("receipt is tamper-evident over action IDs, their order, the total and the session", () => {
    const s = sessionWith(3);
    const { receipt } = closeSession(s);

    // Dropping an action
    const dropped = { ...s, actions: s.actions.slice(0, 2) };
    assert.notEqual(closeSession(dropped).receipt, receipt);

    // Reordering actions
    const reordered = { ...s, actions: [s.actions[1], s.actions[0], s.actions[2]] };
    assert.notEqual(closeSession(reordered).receipt, receipt);

    // Inflating a fee changes the total committed in the receipt
    const inflated = { ...s, actions: s.actions.map((a, i) => (i === 0 ? { ...a, fee: a.fee + 1 } : a)) };
    const r = closeSession(inflated);
    assert.equal(r.totalFee, 31);
    assert.notEqual(r.receipt, receipt);

    // Replaying the same actions under another session ID
    const other = { ...s, sessionId: "f".repeat(32) };
    assert.notEqual(closeSession(other).receipt, receipt);
  });

  test("closing twice is rejected (no double close)", () => {
    const { session } = closeSession(sessionWith(1));
    assert.throws(() => closeSession(session), /already closed/);
    assert.throws(() => closeSession(settleSession(session, "sig")), /already settled/);
  });
});

// ---------------------------------------------------------------------------
// buildSettlementPayload
// ---------------------------------------------------------------------------

describe("buildSettlementPayload", () => {
  test("builds a batch commitment, 34-byte anchor ix data and an x402 envelope", () => {
    const { session, totalFee } = closeSession(sessionWith(3, { pricePerAction: 25 }));
    const p = buildSettlementPayload(session, "solana-devnet");

    const expectedBatch = new TextEncoder().encode(JSON.stringify(session.actions));
    assert.deepEqual(p.compressedReceiptBatch, expectedBatch);
    assert.equal(p.batchHash, sha256(expectedBatch));

    assert.equal(p.anchorIxData.length, 34);
    assert.equal(p.anchorIxData[0], 0x01);
    assert.equal(p.anchorIxData[1], 0x00);
    assert.equal(Buffer.from(p.anchorIxData.subarray(2)).toString("hex"), p.batchHash);

    assert.equal(p.sessionId, session.sessionId);
    assert.equal(p.actionCount, 3);
    assert.equal(p.totalFee, totalFee);
    assert.equal(p.currency, "USDC");
    assert.deepEqual(p.x402Payment, {
      scheme: "exact",
      network: "solana-devnet",
      from: session.agentPubkey,
      to: session.providerPubkey,
      amount: 75,
      currency: "USDC",
      sessionId: session.sessionId,
      batchHash: p.batchHash,
      actionCount: 3,
    });
  });

  test("network defaults to solana-mainnet", () => {
    const { session } = closeSession(sessionWith(1));
    assert.equal(buildSettlementPayload(session).x402Payment.network, "solana-mainnet");
  });

  test("the batch round-trips back to the exact action log", () => {
    const { session } = closeSession(sessionWith(4));
    const p = buildSettlementPayload(session);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(p.compressedReceiptBatch)), session.actions);
  });

  test("tampering with any action's result digest changes the on-chain commitment", () => {
    const { session } = closeSession(sessionWith(3));
    const originalHash = buildSettlementPayload(session).batchHash;
    const forged = {
      ...session,
      actions: session.actions.map((a, i) => (i === 1 ? { ...a, resultDigest: sha256("forged") } : a)),
    };
    const forgedPayload = buildSettlementPayload(forged);
    assert.notEqual(forgedPayload.batchHash, originalHash);
    assert.notDeepEqual(forgedPayload.anchorIxData, buildSettlementPayload(session).anchorIxData);
  });

  test("uses a caller-supplied compressor and commits to its output", () => {
    const { session } = closeSession(sessionWith(2));
    let seen;
    const compress = (actions) => {
      seen = actions;
      return new Uint8Array([9, 8, 7]);
    };
    const p = buildSettlementPayload(session, "solana-mainnet", compress);
    assert.equal(seen, session.actions);
    assert.deepEqual(p.compressedReceiptBatch, new Uint8Array([9, 8, 7]));
    assert.equal(p.batchHash, sha256(new Uint8Array([9, 8, 7])));
  });

  test("an open session can be priced (documented), and matches the closed totals", () => {
    const s = sessionWith(2);
    const openPayload = buildSettlementPayload(s);
    const closedPayload = buildSettlementPayload(closeSession(s).session);
    assert.equal(openPayload.batchHash, closedPayload.batchHash);
    assert.equal(openPayload.totalFee, closedPayload.totalFee);
  });

  test("rejects a session with no actions", () => {
    const { session } = closeSession(openSession(baseParams()));
    assert.throws(() => buildSettlementPayload(session), /no recorded actions/);
  });

  test("rejects an already-settled session (no second payment for the same batch)", () => {
    const { session } = closeSession(sessionWith(2));
    const settled = settleSession(session, "anchorSig");
    assert.throws(() => buildSettlementPayload(settled), /already settled/);
  });

  test("full lifecycle: 200 actions settle as one payment of 200 x price", () => {
    let s = openSession(baseParams({ maxActions: 200, pricePerAction: 1000 }));
    for (let i = 0; i < 200; i++) s = recordAction(s, "llm-inference", { i });
    assert.throws(() => recordAction(s, "llm-inference", "201st"), RangeError);
    const { session, totalFee } = closeSession(s);
    const p = buildSettlementPayload(session);
    assert.equal(totalFee, 200_000);
    assert.equal(p.x402Payment.amount, 200_000);
    assert.equal(p.actionCount, 200);
    assert.equal(new Set(session.actions.map((a) => a.actionId)).size, 200);
  });
});

// ---------------------------------------------------------------------------
// settleSession
// ---------------------------------------------------------------------------

describe("settleSession", () => {
  test("marks a closed session settled and records the anchor tx", () => {
    const { session } = closeSession(sessionWith(1));
    const settled = settleSession(session, "5xAnchorSig");
    assert.equal(settled.status, "settled");
    assert.equal(settled.anchorTxSig, "5xAnchorSig");
    assert.equal(session.status, "closed", "input not mutated");
    assert.deepEqual(settled.actions, session.actions);
  });

  test("an open session cannot be settled", () => {
    assert.throws(() => settleSession(sessionWith(1), "sig"), /expected "closed", got "open"/);
  });

  test("a settled session cannot be settled again (replay)", () => {
    const { session } = closeSession(sessionWith(1));
    const settled = settleSession(session, "sig-1");
    assert.throws(() => settleSession(settled, "sig-2"), /got "settled"/);
  });

  test("requires a non-empty anchor transaction signature", () => {
    const { session } = closeSession(sessionWith(1));
    assert.throws(() => settleSession(session, ""), TypeError);
  });
});
