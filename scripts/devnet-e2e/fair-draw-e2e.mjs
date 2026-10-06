// End-to-end run of null_fair_draw against a live cluster (local validator or devnet).
//
// Scenario 1 (open raffle, SOL prizes, unweighted, one re-draw round):
//   CreateDraw, FundPrizes, Enter (several wallets, counts > 1), Draw, Resolve,
//   claims (two winners skip), Advance (re-draw round), Draw, Resolve, one
//   re-drawn winner claims, Advance (complete), Reclaim, Close.
// Scenario 2 (committed list, weighted, SPL prizes):
//   mint + organizer token account, CreateDraw (SPL vault), FundPrizes (SPL),
//   CommitList, Draw, Resolve (one proof per slot), claims to token accounts,
//   Advance, Close, token-account cleanup.
// Every outcome is graded from the ledger (getTransaction: err, logs, CU, fee,
// pre/post balances). Negative cases land on chain with preflight off and are
// graded by their exact custom error code.
//
// Env:
//   RPC_URL (required), EVIDENCE_DIR, AIRDROP=1 (local only)
//   PROGRAM_ID     default FZxUXmGNzivQCw1nS6N6GakwyWN1PrX5ebGnS7hPjzGL
//   KEY_DIR        default ./keys
//   ORGANIZER_KEY  default $KEY_DIR/facilitator.json
//   ENTRANT_KEYS   comma-separated keypair paths (>= 4), default $KEY_DIR/payer1..4,payee1,payee2
//   CLOSE_DELAY_SLOTS  slots from now to the open raffle close (default 150)
//   ENTRANT_MIN_LAMPORTS / ENTRANT_TOPUP_LAMPORTS  entrant float when AIRDROP!=1 (default 3,000,000 / 5,000,000)

import * as L from "./lib.mjs";
import * as FD from "../../packages/fair-draw/src/index.ts";

const PID = process.env.PROGRAM_ID ?? "FZxUXmGNzivQCw1nS6N6GakwyWN1PrX5ebGnS7hPjzGL";
const KEY_DIR = process.env.KEY_DIR ?? "./keys";
const CLOSE_DELAY = BigInt(process.env.CLOSE_DELAY_SLOTS ?? "150");
const CLAIM_WINDOW = 150n; // program minimum (MIN_CLAIM_WINDOW_SLOTS)
const ENTRANT_MIN = BigInt(process.env.ENTRANT_MIN_LAMPORTS ?? "3000000");
const ENTRANT_TOPUP = BigInt(process.env.ENTRANT_TOPUP_LAMPORTS ?? "5000000");
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = FD.TOKEN_PROGRAM_ID;
const SLOT_HASHES = FD.SLOT_HASHES_SYSVAR;
const NEG = { skipPreflight: true, cuLimit: 200_000 };
const E = (name) => FD.ERROR_BASE + FD.DRAW_ERRORS[name];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = (v) => (typeof v === "bigint" ? v.toString() : v);

const fdRpc = FD.jsonRpc(L.RPC_URL);
const ev = new L.Evidence("fair-draw", { programId: PID, airdrop: L.AIRDROP });

// ── keys ────────────────────────────────────────────────────────────────────

const organizer = L.loadKey(process.env.ORGANIZER_KEY ?? `${KEY_DIR}/facilitator.json`);
const entrantPaths = (process.env.ENTRANT_KEYS ?? ["payer1", "payer2", "payer3", "payer4", "payee1", "payee2"].map((n) => `${KEY_DIR}/${n}.json`).join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const entrants = entrantPaths.map((p) => L.loadKey(p));
const names = new Map([[organizer.pk, "organizer"]]);
entrantPaths.forEach((p, i) => names.set(entrants[i].pk, p.split("/").pop().replace(/\.json$/, "")));
const signers = new Map([[organizer.pk, organizer], ...entrants.map((e) => [e.pk, e])]);
const nm = (pk) => names.get(pk) ?? pk.slice(0, 8);

// ── ledger accounting ───────────────────────────────────────────────────────

const spent = new Map(); // pk -> { name, net, min, fees, txs }
const track = (k, name) => {
  if (!spent.has(k.pk)) spent.set(k.pk, { name, net: 0n, min: 0n, fees: 0n, txs: 0 });
};
track(organizer, "organizer");
entrants.forEach((e) => track(e, nm(e.pk)));

const cuStats = {}; // kind -> { min, max, n }
function addCu(kind, v) {
  const s = (cuStats[kind] ??= { min: v, max: v, n: 0 });
  s.min = Math.min(s.min, v);
  s.max = Math.max(s.max, v);
  s.n++;
}

async function txMeta(sig) {
  for (let i = 0; i < 30; i++) {
    const t = await L.rpc("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    if (t) return t;
    await sleep(400);
  }
  throw new Error(`getTransaction null for ${sig}`);
}
const keysOf = (t) => t.transaction.message.accountKeys;
function deltaOf(t, pk) {
  const i = keysOf(t).indexOf(pk);
  return i < 0 ? 0n : BigInt(t.meta.postBalances[i]) - BigInt(t.meta.preBalances[i]);
}
function tokenBal(t, pk, which) {
  const i = keysOf(t).indexOf(pk);
  const e = (t.meta[which] ?? []).find((x) => x.accountIndex === i);
  return e ? BigInt(e.uiTokenAmount.amount) : 0n;
}

/** Send through lib.run, read the full meta back, account SOL per tracked wallet, record CU. */
async function tx(label, kind, sendFn, expect = "ok") {
  const g = await L.run(ev, label, sendFn, expect, kind ? { kind } : {});
  if (!g) return null;
  const t = await txMeta(g.signature);
  for (const [pk, s] of spent) {
    const d = deltaOf(t, pk);
    if (d !== 0n) {
      s.net += d;
      if (s.net < s.min) s.min = s.net;
    }
    if (keysOf(t)[0] === pk) {
      s.fees += BigInt(t.meta.fee);
      s.txs++;
    }
  }
  if (kind) {
    const mine = g.ixCu.filter((x) => x.program === PID);
    for (const x of mine) addCu(g.err === null ? kind : `${kind} [rejected]`, x.cu);
  }
  return { ...g, t };
}

// ── instruction helpers ─────────────────────────────────────────────────────

const ix = (programId, keys, data) => ({ programId, keys: keys.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })), data });
const u64 = (v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return b;
};
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
function createAccountIx(from, newPk, lamports, space, owner) {
  const data = cat(Uint8Array.of(0, 0, 0, 0), u64(lamports), u64(space), L.b58decode(owner));
  return ix(SYSTEM, [[from, true, true], [newPk, true, true]], data);
}
const initMint2Ix = (mint, decimals, authority) => ix(TOKEN, [[mint, false, true]], cat(Uint8Array.of(20, decimals), L.b58decode(authority), Uint8Array.of(0)));
const initAccount3Ix = (acct, mint, owner) => ix(TOKEN, [[acct, false, true], [mint, false, false]], cat(Uint8Array.of(18), L.b58decode(owner)));
const mintToCheckedIx = (mint, dest, auth, amount, decimals) => ix(TOKEN, [[mint, false, true], [dest, false, true], [auth, true, false]], cat(Uint8Array.of(14), u64(amount), Uint8Array.of(decimals)));
const transferIx = (src, dst, owner, amount) => ix(TOKEN, [[src, false, true], [dst, false, true], [owner, true, false]], cat(Uint8Array.of(3), u64(amount)));
const burnIx = (acct, mint, owner, amount) => ix(TOKEN, [[acct, false, true], [mint, false, true], [owner, true, false]], cat(Uint8Array.of(8), u64(amount)));
const closeTokenIx = (acct, dest, owner) => ix(TOKEN, [[acct, false, true], [dest, false, true], [owner, true, false]], Uint8Array.of(9));

const drawIx = (draw) => ix(PID, [[draw, false, true], [SLOT_HASHES, false, false]], FD.encodeDraw());
const advanceIx = (draw) => ix(PID, [[draw, false, true]], FD.encodeAdvance());
const resolveIx = (draw, proofs) => ix(PID, [[draw, false, true]], FD.encodeResolve(1, proofs));
const claimIxRaw = (winner, draw, slot, proof, spl) =>
  ix(PID, [[winner, true, true], [draw, false, true], ...(spl ? [[spl.dest, false, true], [spl.vault, false, true], [TOKEN, false, false]] : [])], FD.encodeClaim(slot, proof));
const orgIx = (data, draw, spl) =>
  ix(PID, [[organizer.pk, true, true], [draw, false, true], ...(spl ? [[spl.dest, false, true], [spl.vault, false, true], [TOKEN, false, false]] : [])], data);

async function tokenAmount(pk) {
  const a = await L.getAccount(pk);
  if (!a) return null;
  return Buffer.from(a.data).readBigUInt64LE(64);
}
const tamper = (proof) => {
  const path = Uint8Array.from(proof.path);
  path[3] ^= 0x01;
  return { ...proof, path };
};

/** Cranks Draw / Resolve until the round is fully resolved (stops before Advance). */
async function crankRound(S, draw, entries) {
  for (let i = 0; i < 64; i++) {
    const d = await FD.fetchDraw(fdRpc, draw);
    const step = await FD.crank(fdRpc, { programId: PID, draw, entries });
    if (step.step === "none" || step.step === "advance") return d;
    const kind = step.step === "draw" ? "Draw" : d.weighted ? `Resolve (weighted, 1 proof, depth ${d.depth})` : `Resolve (unweighted, ${Math.min(24, d.slotCount - d.nextSlot)} slots)`;
    const g = await tx(`${S}: crank ${step.step} round ${d.round} next slot ${d.nextSlot}`, kind, () => L.sendLegacy(organizer, step.instructions));
    if (!g || g.err) return null;
  }
  return null;
}

async function waitFirstTarget(draw, S) {
  const d = await FD.fetchDraw(fdRpc, draw);
  const t = d.rounds[d.round].firstTarget;
  await L.waitSlot(t + 2n, `${S} round ${d.round} target ${t}`);
  return t;
}

function checkVerify(S, label, v, d) {
  const resolved = d.slots.slice(0, d.nextSlot).filter((s) => s.status !== FD.SLOT_STATUS.void);
  const match = v.winners.length === resolved.length && v.winners.every((w) => d.slots[w.slot].leafIndex === w.leafIndex);
  ev.doc.verify ??= [];
  ev.doc.verify.push({ scenario: S, label, ok: v.ok, problems: v.problems, proofsChecked: v.proofsChecked, rounds: d.round + 1, winners: v.winners.map((w) => ({ ...w, leafIndex: big(w.leafIndex), amount: big(w.amount) })) });
  ev.check(`${S}: verify ${label} reproduces on-chain winners`, v.ok && match, { ok: v.ok, problems: v.problems, winners: v.winners.length, onChain: resolved.length, proofsChecked: v.proofsChecked });
}

// ── funding ─────────────────────────────────────────────────────────────────

/** Keeps a wallet above ENTRANT_MIN (the shared local keys can be spent by other runs). */
async function ensureFloat(k) {
  const b = await L.getBalance(k.pk);
  if (b >= ENTRANT_MIN) return;
  if (L.AIRDROP) await L.airdrop(k.pk, 1_000_000_000n);
  else await tx(`top-up ${nm(k.pk)}`, null, () => L.fund(organizer, k.pk, (ENTRANT_TOPUP > ENTRANT_MIN ? ENTRANT_TOPUP : ENTRANT_MIN) - b));
}

async function ensureFunds() {
  const orgBal = await L.getBalance(organizer.pk);
  if (L.AIRDROP && orgBal < 5_000_000_000n) await L.airdrop(organizer.pk, 10_000_000_000n);
  for (const e of entrants) await ensureFloat(e);
  const ob = await L.getBalance(organizer.pk);
  ev.doc.organizerStartBalance = ob.toString();
  ev.check("setup: organizer holds >= 0.15 SOL", ob >= 150_000_000n, { balance: ob });
  if (ob < 150_000_000n) throw new Error("organizer underfunded");
}

// ── scenario 1: open raffle, SOL, unweighted, re-draw ───────────────────────

async function openRaffle() {
  const S = "open";
  const tiers = [
    { count: 1, amount: 20_000_000n },
    { count: 2, amount: 10_000_000n },
    { count: 3, amount: 5_000_000n },
  ];
  const totalPrize = tiers.reduce((s, t) => s + BigInt(t.count) * t.amount, 0n);
  const entryPrice = 10_000n;
  const drawId = BigInt(Date.now());
  const closeSlot = (await L.getSlot()) + CLOSE_DELAY;
  const params = { mode: FD.MODE_OPEN, weighted: false, redrawRounds: 1, tiers, entryPrice, walletCap: 0n, closeSlot, claimWindowSlots: CLAIM_WINDOW, feeDest: organizer.publicKey };
  const c = FD.createDraw({ programId: PID, organizer: organizer.pk, drawId, params });
  const draw = c.draw;
  ev.doc.summary.openDraw = draw;
  console.log(`${S}: draw ${draw} close ${closeSlot}`);

  const cr = await tx(`${S}: CreateDraw`, "CreateDraw (open raffle, SOL, 6 prizes, 1 re-draw round)", () => L.sendLegacy(organizer, c.instructions));
  if (!cr || cr.err) return;
  const fg = await tx(`${S}: FundPrizes`, "FundPrizes (SOL, 12 slot capacity)", () => L.sendLegacy(organizer, [FD.fundPrizes({ programId: PID, funder: organizer.pk, draw })]));
  let d = await FD.fetchDraw(fdRpc, draw);
  ev.check(`${S}: prizes escrowed`, d.funded === totalPrize && d.status === FD.STATUS.funded && deltaOf(fg.t, organizer.pk) === -(totalPrize + BigInt(fg.fee)), { funded: d.funded, totalPrize });

  // Entries: several wallets, counts > 1, each payer pays count * price to the organizer.
  const plan = [[0, 3], [1, 1], [2, 4], [3, 2], [4, 1], [5, 2], [0, 1], [2, 1]];
  let expectLeaves = 0;
  for (const [n, [i, count]] of plan.entries()) {
    const e = entrants[i % entrants.length];
    await ensureFloat(e);
    const g = await tx(`${S}: Enter #${n} count ${count} by ${nm(e.pk)}`, `Enter (unweighted, ${count} leaves, SOL entry fee)`, () =>
      L.sendLegacy(e, [FD.enter({ programId: PID, payer: e.pk, draw, count, feeDest: organizer.pk })]),
    );
    if (g && g.err === null) {
      expectLeaves += count;
      const fee = entryPrice * BigInt(count);
      ev.check(`${S}: Enter #${n} fee moved payer -> organizer`, deltaOf(g.t, e.pk) === -(fee + BigInt(g.fee)) && deltaOf(g.t, organizer.pk) === fee, { payer: deltaOf(g.t, e.pk), organizer: deltaOf(g.t, organizer.pk) });
    }
  }
  await tx(`${S}: Draw while entries open`, "Draw", () => L.sendLegacy(organizer, [drawIx(draw)], [], NEG), E("EntriesOpen"));

  await L.waitSlot(closeSlot, `${S} close`);
  await Promise.all([
    tx(`${S}: Enter after close`, "Enter (unweighted, 1 leaves, SOL entry fee)", () => L.sendLegacy(entrants[1], [FD.enter({ programId: PID, payer: entrants[1].pk, draw, count: 1, feeDest: organizer.pk })], [], NEG), E("EntriesClosed")),
    tx(`${S}: Draw before target slot hash`, "Draw", () => L.sendLegacy(organizer, [drawIx(draw)], [], NEG), E("DrawTooEarly")),
  ]);
  d = await FD.fetchDraw(fdRpc, draw);
  ev.check(`${S}: target slot = close + 32, ${expectLeaves} leaves`, d.rounds[0].firstTarget === closeSlot + 32n && d.leafCount === BigInt(expectLeaves), { target: d.rounds[0].firstTarget, leaves: d.leafCount });

  await waitFirstTarget(draw, S);
  d = await crankRound(S, draw);
  if (!d) return ev.check(`${S}: round 0 resolved`, false);
  ev.check(`${S}: round 0 resolved, 6 winners`, d.nextSlot === 6 && d.slotCount === 6 && d.windowEnd > 0n, { nextSlot: d.nextSlot, windowEnd: d.windowEnd });

  const entries = FD.entriesFromLogs(await fdRpc.getLogs(draw), PID, FD.key(draw));
  ev.check(`${S}: entries rebuilt from Enter logs`, BigInt(entries.length) === d.leafCount, { entries: entries.length });
  const list = FD.buildList(FD.key(draw), entries, d.depth);
  const win = (dd, j) => {
    const s = dd.slots[j];
    const leaf = Number(s.leafIndex);
    return { slot: j, tier: s.tier, leaf, wallet: FD.toBase58(entries[leaf].wallet), amount: dd.tiers[s.tier].amount };
  };
  checkVerify(S, "round 0", await FD.verify(fdRpc, { programId: PID, draw }), d);

  const r0 = [0, 1, 2, 3, 4, 5].map((j) => win(d, j));
  ev.doc.summary.openRound0 = r0.map((w) => ({ ...w, wallet: nm(w.wallet), amount: big(w.amount) }));
  const lastOfTier = (t) => Math.max(...r0.filter((w) => w.tier === t).map((w) => w.slot));
  const skip = new Set([lastOfTier(1), lastOfTier(2)]);
  let paidSeen = 0n;

  async function claimOne(w, round) {
    const signer = signers.get(w.wallet);
    await ensureFloat(signer);
    const ixc = await FD.claim(fdRpc, { programId: PID, draw, winner: w.wallet, slot: w.slot, entries });
    const g = await tx(`${S}: Claim slot ${w.slot} tier ${w.tier} round ${round} by ${nm(w.wallet)}`, "Claim (unweighted, leaf proof, SOL)", () => L.sendLegacy(signer, [ixc]));
    if (g && g.err === null) {
      const delta = deltaOf(g.t, w.wallet);
      ev.check(`${S}: slot ${w.slot} winner balance rose by tier amount minus own fee`, delta === w.amount - BigInt(g.fee), { delta, amount: w.amount, fee: g.fee });
      paidSeen += w.amount;
    }
    return g;
  }

  const w0 = r0[0];
  const s0 = signers.get(w0.wallet);
  const proof0 = FD.listProof(list, w0.leaf);
  const other = entrants.find((e) => e.pk !== w0.wallet && entries.some((x) => FD.toBase58(x.wallet) === e.pk));
  const otherLeaf = entries.findIndex((x) => FD.toBase58(x.wallet) === other.pk);
  const showcase = async () => {
    await Promise.all([ensureFloat(s0), ensureFloat(other)]);
    await tx(`${S}: Claim slot 0 with a tampered proof`, "Claim (unweighted, leaf proof, SOL)", () => L.sendLegacy(s0, [claimIxRaw(w0.wallet, draw, 0, tamper(proof0))], [], NEG), E("InvalidProof"));
    await tx(`${S}: Claim slot 0 by non-winner ${nm(other.pk)} (own leaf proof)`, "Claim (unweighted, leaf proof, SOL)", () => L.sendLegacy(other, [claimIxRaw(other.pk, draw, 0, FD.listProof(list, otherLeaf))], [], NEG), E("NotWinner"));
    await claimOne(w0, 0);
    await tx(`${S}: Claim slot 0 again`, "Claim (unweighted, leaf proof, SOL)", () => L.sendLegacy(s0, [claimIxRaw(w0.wallet, draw, 0, proof0)], [], NEG), E("AlreadyClaimed"));
  };
  await Promise.all([showcase(), ...r0.filter((w) => w.slot !== 0 && !skip.has(w.slot)).map((w) => claimOne(w, 0))]);

  // Window over: the skipped winner is refused, then Advance opens the re-draw round.
  await L.waitSlot(d.windowEnd + 1n, `${S} round 0 window end`);
  const late = r0.find((w) => skip.has(w.slot));
  await ensureFloat(signers.get(late.wallet));
  const lateIx = await FD.claim(fdRpc, { programId: PID, draw, winner: late.wallet, slot: late.slot, entries });
  await tx(`${S}: Claim slot ${late.slot} after the window`, "Claim (unweighted, leaf proof, SOL)", () => L.sendLegacy(signers.get(late.wallet), [lateIx], [], NEG), E("ClaimWindowClosed"));
  const windowEnd0 = d.windowEnd;
  await tx(`${S}: Advance (opens re-draw round)`, "Advance (2 forfeited, opens re-draw round)", () => L.sendLegacy(organizer, [advanceIx(draw)]));
  d = await FD.fetchDraw(fdRpc, draw);
  ev.check(`${S}: re-draw round opened for 2 forfeited prizes`, d.status === FD.STATUS.awaitDraw && d.round === 1 && d.slotCount === 8 && [...skip].every((j) => d.slots[j].status === FD.SLOT_STATUS.forfeited) && d.rounds[1].firstTarget === windowEnd0 + 32n, { status: d.status, round: d.round, slotCount: d.slotCount, target: d.rounds[1].firstTarget });

  await waitFirstTarget(draw, S);
  d = await crankRound(S, draw);
  if (!d) return ev.check(`${S}: round 1 resolved`, false);
  const r1 = [6, 7].map((j) => win(d, j));
  ev.doc.summary.openRound1 = r1.map((w) => ({ ...w, wallet: nm(w.wallet), amount: big(w.amount) }));
  const r0Leaves = new Set(r0.map((w) => w.leaf));
  ev.check(`${S}: re-drawn winners are new leaves with the forfeited tiers`, r1.every((w) => !r0Leaves.has(w.leaf)) && r1[0].leaf !== r1[1].leaf && r1.map((w) => w.tier).join() === [...skip].sort().map((j) => r0[j].tier).join(), { r1: r1.map((w) => [w.slot, w.leaf, w.tier]) });
  checkVerify(S, "after re-draw round", await FD.verify(fdRpc, { programId: PID, draw }), d);

  await claimOne(r1[0], 1); // r1[1] deliberately does not claim
  await L.waitSlot(d.windowEnd + 1n, `${S} round 1 window end`);
  await tx(`${S}: Advance (complete)`, "Advance (1 forfeited, completes)", () => L.sendLegacy(organizer, [advanceIx(draw)]));
  d = await FD.fetchDraw(fdRpc, draw);
  ev.check(`${S}: complete, unclaimed re-drawn prize refundable`, d.status === FD.STATUS.complete && d.refundable === r1[1].amount && d.slots[7].status === FD.SLOT_STATUS.forfeited, { status: d.status, refundable: d.refundable });
  checkVerify(S, "final (complete)", await FD.verify(fdRpc, { programId: PID, draw }), d);

  const rg = await tx(`${S}: Reclaim`, "Reclaim (SOL)", () => L.sendLegacy(organizer, [orgIx(FD.encodeReclaim(), draw)]));
  if (rg && rg.err === null) ev.check(`${S}: organizer received the refundable prize`, deltaOf(rg.t, organizer.pk) === d.refundable - BigInt(rg.fee), { delta: deltaOf(rg.t, organizer.pk) });
  d = await FD.fetchDraw(fdRpc, draw);
  ev.check(`${S}: prize conservation funded == paid + returned`, d.funded === d.paid + d.returned && d.paid === paidSeen && d.returned === r1[1].amount && d.funded === totalPrize, { funded: d.funded, paid: d.paid, returned: d.returned, paidSeen });
  const rent = (await L.getAccount(draw)).lamports;
  const cg = await tx(`${S}: Close`, "Close (SOL)", () => L.sendLegacy(organizer, [orgIx(FD.encodeClose(), draw)]));
  if (cg && cg.err === null) ev.check(`${S}: draw closed, rent back to organizer`, (await L.getAccount(draw)) === null && deltaOf(cg.t, organizer.pk) === rent - BigInt(cg.fee), { rent, delta: deltaOf(cg.t, organizer.pk) });
}

// ── scenario 2: committed list, weighted, SPL prizes ────────────────────────

async function committedList() {
  const S = "list";
  const decimals = 6;
  const minted = 1_000_000_000n;
  const tiers = [
    { count: 1, amount: 100_000_000n },
    { count: 2, amount: 25_000_000n },
  ];
  const totalPrize = tiers.reduce((s, t) => s + BigInt(t.count) * t.amount, 0n);

  // Mint + organizer token account.
  const mint = L.freshKey();
  const orgTok = L.freshKey();
  const [rentMint, rentTok] = [await L.rentExempt(82), await L.rentExempt(165)];
  await tx(`${S}: create mint + organizer token account + mint ${minted}`, null, () =>
    L.sendLegacy(organizer, [
      createAccountIx(organizer.pk, mint.pk, rentMint, 82, TOKEN),
      initMint2Ix(mint.pk, decimals, organizer.pk),
      createAccountIx(organizer.pk, orgTok.pk, rentTok, 165, TOKEN),
      initAccount3Ix(orgTok.pk, mint.pk, organizer.pk),
      mintToCheckedIx(mint.pk, orgTok.pk, organizer.pk, minted, decimals),
    ], [mint, orgTok]),
  );
  ev.doc.summary.listMint = mint.pk;

  // List: our wallets with varied weights, interleaved with fresh keys.
  const weights = [5, 9, 3, 12, 7, 4];
  const fresh = Array.from({ length: Math.max(3, 9 - entrants.length) }, () => L.freshKey());
  fresh.forEach((f, i) => {
    names.set(f.pk, `fresh${i}`);
    signers.set(f.pk, f);
    track(f, `fresh${i}`);
  });
  const freshW = [1, 2, 6, 3, 2, 1];
  const rows = [];
  entrants.forEach((e, i) => {
    rows.push({ k: e, w: weights[i % weights.length] });
    if (fresh[i]) rows.push({ k: fresh[i], w: freshW[i] });
  });
  fresh.slice(entrants.length).forEach((f, i) => rows.push({ k: f, w: freshW[(entrants.length + i) % freshW.length] }));
  const entries = rows.map((r) => ({ wallet: r.k.publicKey, weight: BigInt(r.w) }));
  ev.doc.summary.list = rows.map((r) => ({ wallet: nm(r.k.pk), weight: r.w }));

  const drawId = BigInt(Date.now());
  const params = { mode: FD.MODE_LIST, weighted: true, redrawRounds: 1, tiers, entryPrice: 0n, walletCap: 0n, closeSlot: 0n, claimWindowSlots: CLAIM_WINDOW, prizeMint: mint.publicKey };
  const c = FD.createDraw({ programId: PID, organizer: organizer.pk, drawId, params });
  const draw = c.draw;
  const vault = c.vault;
  ev.doc.summary.listDraw = draw;
  console.log(`${S}: draw ${draw} vault ${vault}`);
  const spl = (dest) => ({ dest, vault });

  await tx(`${S}: CreateDraw`, "CreateDraw (committed list, SPL vault)", () => L.sendLegacy(organizer, c.instructions));
  await tx(`${S}: FundPrizes`, "FundPrizes (SPL)", () => L.sendLegacy(organizer, [FD.fundPrizes({ programId: PID, funder: organizer.pk, draw, funderToken: orgTok.pk })]));
  ev.check(`${S}: vault escrows the prizes`, (await tokenAmount(vault)) === totalPrize && (await tokenAmount(orgTok.pk)) === minted - totalPrize, { vault: await tokenAmount(vault) });

  const cl = FD.commitList({ programId: PID, organizer: organizer.pk, draw, list: entries, weighted: true });
  const list = cl.list;
  await tx(`${S}: CommitList (${entries.length} entries, total weight ${list.total})`, "CommitList", () => L.sendLegacy(organizer, [cl.instruction]));
  let d = await FD.fetchDraw(fdRpc, draw);
  ev.check(`${S}: list committed, target = commit + 32`, d.status === FD.STATUS.awaitDraw && FD.equalBytes(d.root, list.root) && d.totalWeight === list.total && d.rounds[0].firstTarget === d.commitSlot + 32n, { commitSlot: d.commitSlot, target: d.rounds[0].firstTarget });
  await tx(`${S}: Draw before target slot hash`, "Draw", () => L.sendLegacy(organizer, [drawIx(draw)], [], NEG), E("DrawTooEarly"));

  await waitFirstTarget(draw, S);
  await tx(`${S}: crank draw round 0`, "Draw", async () => L.sendLegacy(organizer, (await FD.crank(fdRpc, { programId: PID, draw, entries })).instructions));
  // Resolve with wrong proofs before the right one.
  d = await FD.fetchDraw(fdRpc, draw);
  const p = FD.remap(FD.point(d.rounds[0].seed, BigInt(d.nextSlot), d.totalWeight - d.wonWeight), d.won);
  const leaf = FD.leafAt(list, p);
  const neighbour = (leaf + 1) % entries.length;
  await tx(`${S}: Resolve with a tampered proof`, `Resolve (weighted, 1 proof, depth ${d.depth})`, () => L.sendLegacy(organizer, [resolveIx(draw, [tamper(FD.listProof(list, leaf))])], [], NEG), E("InvalidProof"));
  await tx(`${S}: Resolve with a valid proof of another leaf`, `Resolve (weighted, 1 proof, depth ${d.depth})`, () => L.sendLegacy(organizer, [resolveIx(draw, [FD.listProof(list, neighbour)])], [], NEG), E("PointNotInLeaf"));
  d = await crankRound(S, draw, entries);
  if (!d) return ev.check(`${S}: round 0 resolved`, false);
  ev.check(`${S}: 3 weighted slots resolved`, d.nextSlot === 3 && d.windowEnd > 0n, { nextSlot: d.nextSlot });
  checkVerify(S, "round 0", await FD.verify(fdRpc, { programId: PID, draw, entries }), d);
  const winners = [0, 1, 2].map((j) => {
    const s = d.slots[j];
    return { slot: j, tier: s.tier, leaf: Number(s.leafIndex), wallet: FD.toBase58(s.wallet), amount: d.tiers[s.tier].amount };
  });
  ev.doc.summary.listWinners = winners.map((w) => ({ ...w, wallet: nm(w.wallet), weight: rows[w.leaf].w, amount: big(w.amount) }));
  ev.check(`${S}: slot wallets match their list leaves`, winners.every((w) => FD.toBase58(entries[w.leaf].wallet) === w.wallet), {});

  // Non-winner before the slot-0 claim (the AlreadyClaimed check runs before it).
  const nonWinner = entrants.find((e) => !winners.some((w) => w.wallet === e.pk));
  if (nonWinner) await ensureFloat(nonWinner);
  if (nonWinner) await tx(`${S}: Claim slot 0 by non-winner ${nm(nonWinner.pk)}`, "Claim (weighted, SPL)", () => L.sendLegacy(nonWinner, [claimIxRaw(nonWinner.pk, draw, 0, undefined, spl(orgTok.pk))], [], NEG), E("NotWinner"));

  const winnerToks = [];
  let paidSeen = 0n;
  await Promise.all(
    winners.map(async (w) => {
      const tk = L.freshKey();
      winnerToks.push({ tk, owner: w.wallet });
      const claimIx = await FD.claim(fdRpc, { programId: PID, draw, winner: w.wallet, slot: w.slot, entries, winnerToken: tk.pk });
      const g = await tx(`${S}: token account + Claim slot ${w.slot} tier ${w.tier} by ${nm(w.wallet)}`, "Claim (weighted, SPL)", () =>
        L.sendLegacy(organizer, [createAccountIx(organizer.pk, tk.pk, rentTok, 165, TOKEN), initAccount3Ix(tk.pk, mint.pk, w.wallet), claimIx], [tk, signers.get(w.wallet)]),
      );
      if (g && g.err === null) {
        const got = tokenBal(g.t, tk.pk, "postTokenBalances");
        const onChain = await tokenAmount(tk.pk);
        ev.check(`${S}: slot ${w.slot} winner token account holds the tier amount`, got === w.amount && onChain === w.amount && deltaOf(g.t, w.wallet) === 0n, { got, onChain, amount: w.amount });
        paidSeen += w.amount;
      }
    }),
  );
  const w0 = winners[0];
  const tk0 = winnerToks.find((x) => x.owner === w0.wallet).tk;
  await tx(`${S}: Claim slot 0 again`, "Claim (weighted, SPL)", () => L.sendLegacy(organizer, [claimIxRaw(w0.wallet, draw, 0, undefined, spl(tk0.pk))], [signers.get(w0.wallet)], NEG), E("AlreadyClaimed"));

  await L.waitSlot(d.windowEnd + 1n, `${S} window end`);
  await tx(`${S}: Advance (complete)`, "Advance (0 forfeited, completes)", () => L.sendLegacy(organizer, [advanceIx(draw)]));
  d = await FD.fetchDraw(fdRpc, draw);
  const vaultLeft = await tokenAmount(vault);
  ev.check(`${S}: complete, all prizes paid, vault empty`, d.status === FD.STATUS.complete && d.refundable === 0n && d.paid === totalPrize && d.paid === paidSeen && d.funded === d.paid + d.returned && vaultLeft === 0n, { status: d.status, paid: d.paid, returned: d.returned, vaultLeft });
  checkVerify(S, "final (complete)", await FD.verify(fdRpc, { programId: PID, draw, entries }), d);

  const rent = (await L.getAccount(draw)).lamports + (await L.getAccount(vault)).lamports;
  const cg = await tx(`${S}: Close (draw + vault)`, "Close (SPL, closes vault)", () => L.sendLegacy(organizer, [orgIx(FD.encodeClose(), draw, spl(orgTok.pk))]));
  if (cg && cg.err === null) ev.check(`${S}: draw and vault closed, rent back to organizer`, (await L.getAccount(draw)) === null && (await L.getAccount(vault)) === null && deltaOf(cg.t, organizer.pk) === rent - BigInt(cg.fee), { rent, delta: deltaOf(cg.t, organizer.pk) });

  // Cleanup: winner tokens back to the organizer, token accounts closed, rent back to the organizer.
  for (const { tk, owner } of winnerToks) {
    const amt = await tokenAmount(tk.pk);
    await tx(`${S}: cleanup token account of ${nm(owner)}`, null, () => L.sendLegacy(organizer, [transferIx(tk.pk, orgTok.pk, owner, amt), closeTokenIx(tk.pk, organizer.pk, owner)], [signers.get(owner)]));
  }
  const left = await tokenAmount(orgTok.pk);
  ev.check(`${S}: every minted token accounted for`, left === minted, { left });
  await tx(`${S}: cleanup organizer token account`, null, () => L.sendLegacy(organizer, [burnIx(orgTok.pk, mint.pk, organizer.pk, left), closeTokenIx(orgTok.pk, organizer.pk, organizer.pk)]));
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const pa = await L.rpc("getAccountInfo", [PID, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
  if (!ev.check("setup: program deployed and executable", pa?.value?.executable === true, { programId: PID })) return;
  if (entrants.length < 4) throw new Error("ENTRANT_KEYS needs at least 4 keypairs");
  if (new Set([organizer.pk, ...entrants.map((e) => e.pk)]).size !== entrants.length + 1) throw new Error("organizer and entrants must be distinct");
  ev.doc.wallets = Object.fromEntries([...names].map(([pk, n]) => [n, pk]));
  await ensureFunds();
  const t0 = Date.now();
  await openRaffle();
  ev.doc.summary.openSeconds = (Date.now() - t0) / 1000;
  const t1 = Date.now();
  await committedList();
  ev.doc.summary.listSeconds = (Date.now() - t1) / 1000;
}

try {
  await main();
} catch (e) {
  ev.check("uncaught exception", false, { error: String(e.stack ?? e).slice(0, 800) });
}
ev.doc.cuPerInstruction = cuStats;
ev.doc.solSpent = Object.fromEntries([...spent].map(([pk, s]) => [s.name, { pk, net: s.net.toString(), peakDraw: s.min.toString(), fees: s.fees.toString(), txsPaid: s.txs }]));
const total = [...spent.values()].reduce((a, s) => a + s.net, 0n);
const fees = [...spent.values()].reduce((a, s) => a + s.fees, 0n);
ev.doc.solSpentTotal = { net: total.toString(), fees: fees.toString(), txs: ev.doc.steps.length };
console.log("CU per instruction:", JSON.stringify(cuStats));
console.log("SOL net per wallet:", JSON.stringify(ev.doc.solSpent));
console.log("total net:", total.toString(), "fees:", fees.toString());
ev.save("fair-draw.json");
process.exit(ev.failures === 0 ? 0 : 1);
