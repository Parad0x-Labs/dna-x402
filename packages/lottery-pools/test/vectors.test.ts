// Recompute every vector of programs/null_lottery_pools/tests/vectors/lottery_pools_v1.json
// (written by the Rust test tests/vectors.rs) and compare.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  IncrementalTree,
  ZEROS,
  applyCap,
  binom,
  decodePool,
  decodeRound,
  drawEntropy,
  drawNumbers,
  encodeBuyTicket,
  encodeClaim,
  encodeCreatePool,
  encodeDraw,
  encodeWithdrawCreatorFees,
  feeRate,
  firstTarget,
  fromHex,
  jackpotCap,
  poolErrorName,
  proofOf,
  recoupVolume,
  rootFromProof,
  rootOf,
  selectSlotHash,
  sha256,
  splitTicket,
  ticketLeaf,
  toHex,
  u64le,
  validNumbers,
  type PoolParams,
} from "../src/index.ts";

const V = JSON.parse(
  readFileSync(new URL("../../../programs/null_lottery_pools/tests/vectors/lottery_pools_v1.json", import.meta.url), "utf8"),
);

const h32 = (tag: string, i: bigint): Uint8Array => sha256(new TextEncoder().encode(tag), u64le(i));

test("zero table", () => {
  assert.deepEqual(ZEROS.map(toHex), V.zeros);
});

test("ticket leaves", () => {
  assert.ok(V.leaves.length > 0);
  for (const c of V.leaves) {
    const leaf = ticketLeaf(fromHex(c.pool), BigInt(c.round_id), fromHex(c.owner), c.numbers, BigInt(c.ticket_index));
    assert.equal(toHex(leaf), c.leaf);
  }
});

test("tree roots, proofs and the incremental append", () => {
  for (const c of V.trees) {
    const leaves = c.leaves.map(fromHex);
    assert.equal(toHex(rootOf(leaves)), c.root);
    const inc = new IncrementalTree();
    for (const l of leaves) inc.append(l);
    assert.equal(toHex(inc.root), c.root);
    for (const p of c.proofs) {
      const proof = proofOf(leaves, p.index);
      assert.deepEqual(proof.map(toHex), p.proof);
      assert.equal(toHex(rootFromProof(leaves[p.index], BigInt(p.index), proof)), c.root);
    }
  }
});

test("fee curve and ticket split", () => {
  assert.ok(V.fees.length > 0);
  for (const c of V.fees) {
    const p: PoolParams = {
      seed: BigInt(c.seed),
      ticketPrice: BigInt(c.ticket_price),
      feeMaxBps: c.fee_max_bps,
      feeMinBps: c.fee_min_bps,
      reserveBps: c.reserve_bps,
      capBps: 7_000,
      pickK: 5,
      rangeN: 36,
      roundSlots: 150n,
      claimWindowSlots: 150n,
    };
    const vr = recoupVolume(p.seed, p.feeMaxBps);
    assert.equal(vr.toString(), c.recoup_volume);
    const v = BigInt(c.v_before);
    assert.equal(feeRate(vr, p.feeMaxBps, p.feeMinBps, v), c.rate_bps);
    const s = splitTicket(p, vr, v, c.retired);
    assert.deepEqual([s.creator, s.reserve, s.jackpot].map(String), [c.creator, c.reserve, c.jackpot]);
    assert.equal(s.creator + s.reserve + s.jackpot, p.ticketPrice);
  }
});

test("jackpot cap", () => {
  for (const c of V.caps) {
    const combos = binom(c.n, c.k);
    assert.equal(combos.toString(), c.combos);
    assert.equal(jackpotCap(c.cap_bps, BigInt(c.ticket_price), combos).toString(), c.cap);
  }
  assert.deepEqual(applyCap(90n, 20n, 100n), [10n, 10n]);
  assert.deepEqual(applyCap(150n, 20n, 100n), [0n, 20n]);
});

test("draw slot selection", () => {
  for (const c of V.selections) {
    const entries = c.slots.map((s: string) => ({ slot: BigInt(s), hash: h32(c.slot_hash_tag, BigInt(s)) }));
    const r = selectSlotHash(entries, firstTarget(BigInt(c.close_slot)));
    if ("error" in r) {
      assert.deepEqual(r, c.result);
    } else {
      assert.deepEqual(
        { attempt: r.attempt.toString(), target_slot: r.targetSlot.toString(), used_slot: r.usedSlot.toString(), hash: toHex(r.hash) },
        c.result,
      );
    }
  }
});

test("draw entropy and numbers", () => {
  for (const c of V.draws) {
    const sel = {
      attempt: BigInt(c.attempt),
      targetSlot: BigInt(c.target_slot),
      usedSlot: BigInt(c.used_slot),
      hash: fromHex(c.slot_hash),
    };
    const e = drawEntropy(fromHex(c.pool), BigInt(c.round_id), sel, fromHex(c.root), BigInt(c.ticket_count));
    assert.equal(toHex(e), c.entropy);
    const n = drawNumbers(e, c.k, c.n);
    assert.deepEqual(n, c.numbers);
    assert.ok(validNumbers(n, c.k, c.n));
  }
});

test("instruction encodings", () => {
  const byName = Object.fromEntries(V.instructions.map((x: { name: string; hex: string }) => [x.name, x.hex]));
  const create = encodeCreatePool(42n, {
    seed: 1_000_000_000n,
    ticketPrice: 10_000_000n,
    feeMaxBps: 2_500,
    feeMinBps: 200,
    reserveBps: 500,
    capBps: 7_000,
    pickK: 5,
    rangeN: 36,
    roundSlots: 9_000n,
    claimWindowSlots: 216_000n,
  });
  assert.equal(toHex(create), byName.create_pool);
  const numbers = [3, 9, 17, 22, 35];
  assert.equal(toHex(encodeBuyTicket(3n, h32("owner", 9n), numbers)), byName.buy_ticket);
  const proof = Array.from({ length: 20 }, (_, i) => h32("proof", BigInt(i)));
  assert.equal(toHex(encodeClaim(1_234n, numbers, proof)), byName.claim);
  assert.equal(toHex(encodeDraw()), byName.draw);
  assert.equal(toHex(encodeWithdrawCreatorFees(987_654_321n)), byName.withdraw_creator_fees);
});

test("account layouts", () => {
  const p = decodePool(fromHex(V.accounts.pool_hex));
  const e = V.accounts.pool;
  assert.deepEqual(
    {
      creator: toHex(p.creator), nonce: String(p.nonce), seed: String(p.params.seed), bump: p.bump,
      has_pending: p.hasPending, last_settle_won: p.lastSettleWon, retired: p.retired, cap: String(p.cap),
      recoup_volume: String(p.recoupVolume), jackpot: String(p.jackpot), owed_prizes: String(p.owedPrizes),
      ticket_count: String(p.ticketCount), root: toHex(p.root), claim_window_slots: String(p.params.claimWindowSlots),
    },
    e,
  );
  const r = decodeRound(fromHex(V.accounts.round_hex));
  const f = V.accounts.round;
  assert.deepEqual(
    {
      pool: toHex(r.pool), round_id: String(r.roundId), status: r.status, bump: r.bump, attempt: String(r.attempt),
      numbers: r.numbers, prize: String(r.prize), share: String(r.share), rent_payer: toHex(r.rentPayer),
      draw_slot: String(r.drawSlot),
    },
    f,
  );
});

test("error names", () => {
  assert.equal(poolErrorName(0x4c50_0011), "InvalidProof");
  assert.equal(poolErrorName(0x6001), undefined);
});
