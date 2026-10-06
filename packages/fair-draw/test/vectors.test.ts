// Recompute every vector of programs/null_fair_draw/tests/vectors/fair_draw_v1.json
// (written by the Rust test tests/vectors.rs) and compare.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import {
  ZEROS,
  decodeDraw,
  drawAddress,
  drawSeed,
  encodeAdvance,
  encodeCancel,
  encodeClaim,
  encodeClose,
  encodeCloseEntrant,
  encodeCommitList,
  encodeCreateDraw,
  encodeDraw,
  encodeEnter,
  encodeExtend,
  encodeFundPrizes,
  encodeProveEntry,
  encodeReclaim,
  encodeResolve,
  entrantAddress,
  fromBase58,
  fromHex,
  leafHash,
  proofOf,
  referenceDraw,
  rootOf,
  sha256,
  streamBlock,
  toBase58,
  toHex,
  u64le,
  vaultAddress,
  verifyDrawState,
  verifyProof,
  wideMod,
  type LeafProof,
  type Pair,
} from "../src/core.ts";

const V = JSON.parse(
  readFileSync(new URL("../../../programs/null_fair_draw/tests/vectors/fair_draw_v1.json", import.meta.url), "utf8"),
);

const te = new TextEncoder();
const h32 = (tag: string, i: bigint): Uint8Array => sha256(te.encode(tag), u64le(i));

test("sha256 matches node:crypto", () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 200, 1000]) {
    const b = new Uint8Array(randomBytes(n));
    assert.equal(toHex(sha256(b)), createHash("sha256").update(b).digest("hex"));
  }
});

test("base58 round trip", () => {
  for (let i = 0; i < 50; i++) {
    const b = new Uint8Array(randomBytes(32));
    if (i % 5 === 0) b[0] = 0;
    assert.deepEqual(fromBase58(toBase58(b)), b);
  }
  assert.equal(toBase58(new Uint8Array(32)), "11111111111111111111111111111111");
});

test("zero table", () => {
  assert.deepEqual(ZEROS.map(toHex), V.zeros);
});

test("leaves", () => {
  for (const c of V.leaves) {
    assert.equal(toHex(leafHash(fromHex(c.draw), fromHex(c.wallet), BigInt(c.weight))), c.leaf);
  }
});

test("sum trees, proofs and prefix sums", () => {
  V.trees.forEach((c: any) => {
    const draw = fromHex(c.draw);
    const weights = c.weights.map(BigInt);
    const leaves: Pair[] = weights.map((w: bigint, i: number) => ({ hash: leafHash(draw, h32("w", BigInt(i)), w), weight: w }));
    const r = rootOf(leaves, c.depth);
    assert.equal(toHex(r.hash), c.root);
    assert.equal(r.weight.toString(), c.total);
    for (const p of c.proofs) {
      const path = proofOf(leaves, c.depth, p.index);
      assert.equal(toHex(path), p.path);
      const start = verifyProof(r.hash, r.weight, c.depth, BigInt(weights.length), BigInt(p.index), leaves[p.index].hash, leaves[p.index].weight, path);
      assert.equal(start !== undefined, p.valid);
      if (p.valid) assert.equal(start!.toString(), p.start);
    }
  });
});

test("seeds, stream blocks and the wide reduction", () => {
  for (const c of V.seeds) {
    const s = drawSeed(fromHex(c.draw), c.round, BigInt(c.target_slot), BigInt(c.used_slot), fromHex(c.slot_hash), fromHex(c.root), BigInt(c.total), BigInt(c.count));
    assert.equal(toHex(s), c.seed);
  }
  for (const c of V.blocks) {
    const b = streamBlock(fromHex(c.seed), BigInt(c.j));
    assert.equal(toHex(b), c.block);
    for (const m of c.mods) assert.equal(wideMod(b, BigInt(m.m)).toString(), m.r);
  }
});

test("winner sequences", () => {
  for (const c of V.draws) {
    const w = referenceDraw(c.weights.map(BigInt), c.already_won, fromHex(c.seed), BigInt(c.first_slot), c.slots);
    assert.deepEqual(w.map((x) => (x === null ? -1 : x)), c.winners);
  }
});

test("instruction encodings", () => {
  const byName = Object.fromEntries(V.instructions.map((x: { name: string; hex: string }) => [x.name, x.hex]));
  const path = new Uint8Array(3 * 40);
  for (let i = 0; i < 3; i++) {
    path.set(h32("path", BigInt(i)), i * 40);
    path.set(u64le(BigInt(i * 11)), i * 40 + 32);
  }
  const proof: LeafProof = { leafIndex: 5n, wallet: h32("wallet", 5n), weight: 9n, path };
  const create = encodeCreateDraw(42n, {
    mode: 0,
    weighted: true,
    redrawRounds: 2,
    tiers: [
      { count: 1, amount: 1_000_000_000n },
      { count: 5, amount: 100_000_000n },
      { count: 50, amount: 10_000_000n },
    ],
    entryPrice: 5_000_000n,
    walletCap: 10n,
    closeSlot: 123_456n,
    claimWindowSlots: 216_000n,
    entryMint: h32("entry-mint", 0n),
    feeDest: h32("fee", 0n),
  });
  assert.equal(toHex(create), byName.create_draw);
  assert.equal(toHex(encodeFundPrizes()), byName.fund_prizes);
  assert.equal(toHex(encodeEnter(3, h32("owner", 1n))), byName.enter);
  assert.equal(toHex(encodeCommitList(h32("root", 9n), 20n, 5n, 3)), byName.commit_list);
  assert.equal(toHex(encodeDraw()), byName.draw);
  assert.equal(toHex(encodeResolve(1, [proof])), byName.resolve);
  assert.equal(toHex(encodeResolve(0, [])), byName.resolve_unweighted);
  assert.equal(toHex(encodeClaim(3, proof)), byName.claim);
  assert.equal(toHex(encodeClaim(3)), byName.claim_no_proof);
  assert.equal(toHex(encodeAdvance()), byName.advance);
  assert.equal(toHex(encodeReclaim()), byName.reclaim);
  assert.equal(toHex(encodeClose()), byName.close);
  assert.equal(toHex(encodeCancel()), byName.cancel);
  assert.equal(toHex(encodeProveEntry(proof)), byName.prove_entry);
  assert.equal(toHex(encodeCloseEntrant()), byName.close_entrant);
  assert.equal(toHex(encodeExtend()), byName.extend);
});

test("draw account layout", () => {
  const a = decodeDraw(fromHex(V.account.hex));
  const e = V.account;
  assert.deepEqual(
    {
      organizer: toHex(a.organizer), draw_id: String(a.drawId), bump: a.bump, vault_bump: a.vaultBump, mode: a.mode,
      weighted: a.weighted, status: a.status, redraw_rounds: a.redrawRounds, tier_count: a.tierCount, depth: a.depth,
      won_count: a.wonCount, tiers: a.tiers.map((t) => ({ count: t.count, amount: String(t.amount) })),
      total_prize: String(a.totalPrize), funded: String(a.funded), root: toHex(a.root), total_weight: String(a.totalWeight),
      leaf_count: String(a.leafCount), capacity: a.capacity, slot_count: a.slotCount, next_slot: a.nextSlot,
      claim_window_slots: String(a.claimWindowSlots),
    },
    {
      organizer: e.organizer, draw_id: e.draw_id, bump: e.bump, vault_bump: e.vault_bump, mode: e.mode, weighted: e.weighted,
      status: e.status, redraw_rounds: e.redraw_rounds, tier_count: e.tier_count, depth: e.depth, won_count: e.won_count,
      tiers: e.tiers, total_prize: e.total_prize, funded: e.funded, root: e.root, total_weight: e.total_weight,
      leaf_count: e.leaf_count, capacity: e.capacity, slot_count: e.slot_count, next_slot: e.next_slot,
      claim_window_slots: e.claim_window_slots,
    },
  );
  const r = a.rounds[0];
  assert.deepEqual(
    { first_target: String(r.firstTarget), target_slot: String(r.targetSlot), used_slot: String(r.usedSlot), attempt: String(r.attempt), slot_hash: toHex(r.slotHash), seed: toHex(r.seed) },
    e.round0,
  );
  const s = a.slots[0];
  assert.deepEqual(
    { start: String(s.start), weight: String(s.weight), leaf_index: String(s.leafIndex), wallet: toHex(s.wallet), tier: s.tier, status: s.status, round: s.round },
    e.slot0,
  );
  assert.deepEqual(a.won[0].map(String), e.won0);
});

test("program-derived addresses", () => {
  for (const c of V.pdas) {
    const pid = fromBase58(c.program);
    const [d, db] = drawAddress(pid, fromBase58(c.organizer), BigInt(c.draw_id));
    assert.deepEqual([toBase58(d), db], [c.draw, c.draw_bump]);
    const [v, vb] = vaultAddress(pid, d);
    assert.deepEqual([toBase58(v), vb], [c.vault, c.vault_bump]);
    const [en, eb] = entrantAddress(pid, d, fromBase58(c.owner));
    assert.deepEqual([toBase58(en), eb], [c.entrant, c.entrant_bump]);
  }
});

test("verify recomputes a resolved draw with a re-draw round", () => {
  const f = V.verify;
  const draw = fromHex(f.draw);
  const entries = f.entries.map((x: any) => ({ wallet: fromHex(x.wallet), weight: BigInt(x.weight) }));
  const a = decodeDraw(fromHex(f.hex));
  const r = verifyDrawState(draw, a, entries);
  assert.deepEqual(r.problems, []);
  assert.ok(r.ok);
  assert.equal(r.proofsChecked, 4);
  assert.deepEqual(r.winners.map((w) => Number(w.leafIndex)), f.winners);
  // A changed list, a moved winner or a different slot hash is caught.
  const bad = entries.map((e: any, i: number) => (i === 2 ? { ...e, weight: e.weight + 1n } : e));
  assert.ok(!verifyDrawState(draw, a, bad).ok);
  const bytes = fromHex(f.hex);
  const slotOff = 792 + 16; // slot 0 leaf_index
  bytes[slotOff] ^= 1;
  assert.ok(!verifyDrawState(draw, decodeDraw(bytes), entries).ok);
  const b2 = fromHex(f.hex);
  b2[408 + 32] ^= 1; // round 0 slot hash
  assert.ok(!verifyDrawState(draw, decodeDraw(b2), entries).ok);
});
