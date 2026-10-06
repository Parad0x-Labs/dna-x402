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
  prizeTier,
  poolSummary,
  validParams,
  SMALL_POOL_PRESET,
  SMALL_POOL_JACKPOT_ONLY,
  LARGE_POOL_PRESET,
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
      tier2Bps: c.tier2_bps,
    };
    const vr = recoupVolume(p.seed, p.feeMaxBps);
    assert.equal(vr.toString(), c.recoup_volume);
    const v = BigInt(c.v_before);
    assert.equal(feeRate(vr, p.feeMaxBps, p.feeMinBps, v), c.rate_bps);
    const s = splitTicket(p, vr, v, c.retired);
    assert.deepEqual([s.creator, s.reserve, s.tier2, s.jackpot].map(String), [c.creator, c.reserve, c.tier2, c.jackpot]);
    assert.equal(s.creator + s.reserve + s.tier2 + s.jackpot, p.ticketPrice);
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
  const createT2 = encodeCreatePool(7n, { ...SMALL_POOL_PRESET });
  assert.equal(toHex(createT2), byName.create_pool_tier2);
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
      tier2_bps: p.params.tier2Bps, tier2_cap: String(p.tier2Cap), tier2_pool: String(p.tier2Pool),
    },
    e,
  );
  const r = decodeRound(fromHex(V.accounts.round_hex));
  const f = V.accounts.round;
  assert.deepEqual(
    {
      pool: toHex(r.pool), round_id: String(r.roundId), status: r.status, bump: r.bump, attempt: String(r.attempt),
      numbers: r.numbers, prize: String(r.prize), share: String(r.share), rent_payer: toHex(r.rentPayer),
      draw_slot: String(r.drawSlot), tier2_prize: String(r.tier2Prize), tier2_winners: String(r.tier2Winners),
      tier2_share: String(r.tier2Share), tier2_paid: String(r.tier2Paid),
    },
    f,
  );
});

test("prize tiers", () => {
  for (const c of V.tiers) {
    assert.equal(prizeTier(c.ticket, c.drawn, c.k, true), c.tier_on);
    assert.equal(prizeTier(c.ticket, c.drawn, c.k, false), c.tier_off);
  }
});

test("presets are valid and poolSummary matches the program's integer math", () => {
  for (const p of [SMALL_POOL_PRESET, SMALL_POOL_JACKPOT_ONLY, LARGE_POOL_PRESET]) assert.ok(validParams(p));
  assert.ok(!validParams({ ...SMALL_POOL_PRESET, capBps: 7_000 }), "cap + fee + tier2 above 100%");
  const s = poolSummary(SMALL_POOL_PRESET);
  assert.equal(s.combos, 816n);
  assert.equal(s.jackpotCap, 4_896_000_000n);
  assert.equal(s.tier2Cap, 816_000_000n);
  assert.equal(s.seeder.recoupVolume, 1_666_666_667n);
  assert.equal(s.seeder.recoupTickets, 167n);
  // Same values as econ::tests::small_preset_numbers in the program.
  assert.deepEqual(s.seeder.atSales.map((x) => [x.tickets, x.creatorFees, x.net]), [
    [200n, 591_394_000n, 91_394_000n],
    [500n, 1_050_150_000n, 550_150_000n],
  ]);
  assert.equal(s.seeder.atSales[1].netPctOfSeed, 110.03);
  assert.deepEqual(s.buyer.jackpotAt.map((x) => x.jackpot), [1_608_606_000n, 3_699_850_000n]);
  assert.ok(Math.abs(s.buyer.pTier2 - 45 / 816) < 1e-12);
  assert.ok(Math.abs(s.buyer.pAnyPrize - 46 / 816) < 1e-12);
  assert.equal(s.buyer.tier2EvPerTicket, 1_000_000n);
  assert.equal(s.buyer.typicalTier2Prize, 18_133_333n);
  const r50 = s.buyer.perRound.find((x) => x.tickets === 50)!;
  assert.ok(Math.abs(r50.pSomeoneWins - 0.945) < 0.001);
  const j = poolSummary(SMALL_POOL_JACKPOT_ONLY);
  assert.deepEqual(j.buyer.jackpotAt.map((x) => x.jackpot), [1_808_606_000n, 4_199_850_000n]);
  assert.equal(j.buyer.pTier2, 0);
  // About 46% chance of a jackpot win within 500 quick-pick tickets.
  const p500 = poolSummary(SMALL_POOL_JACKPOT_ONLY, { roundSizes: [500] }).buyer.perRound[0].pJackpotHit;
  assert.ok(Math.abs(p500 - 0.4583) < 0.0005);
});

test("error names", () => {
  assert.equal(poolErrorName(0x4c50_0011), "InvalidProof");
  assert.equal(poolErrorName(0x6001), undefined);
});
