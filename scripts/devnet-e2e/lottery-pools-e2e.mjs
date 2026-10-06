// End-to-end run of null_lottery_pools against a live cluster (local validator or devnet).
//
// Every outcome is graded from the ledger (getTransaction: err, logs, CU, fee).
//
// Scenarios:
//   1. Small preset pool (3 of 18, tier 2 at 1000 bps, 0.5 SOL seed) with short rounds: buys from
//      several wallets, ticket tree rebuilt from the logs, draw recomputed off chain, every winning
//      ticket registered, settle, payout, close round, econ checks against an off-chain model and poolSummary.
//   2. Guaranteed-winner pool (2 of 4, 6 combinations, all bought): jackpot and tier-2 claims, exact
//      balance deltas on payout.
//   3. Rollover: a round where winners deliberately do not register (prize rolls into the next jackpot),
//      then an empty round rolled by Draw.
//   4. Negatives landed on chain: SalesOpen, SalesClosed, InvalidProof, AlreadyClaimed, ClaimWindowOpen.
//   5. WithdrawCreatorFees on both pools; buyer wallets swept back to the creator (SWEEP=1, default).
//
// Env:
//   RPC_URL (required), EVIDENCE_DIR, AIRDROP=1 (local only)
//   PROGRAM_ID           default 39QHCDuqugs2Fm16CtvD3SBmDJp9n2WbdNGQPtqFZSxw
//   KEY_DIR              default ./keys
//   CREATOR_KEY          default $KEY_DIR/payer1.json
//   BUYER_KEYS           comma-separated, default $KEY_DIR/payer2.json,$KEY_DIR/payer3.json,$KEY_DIR/payer4.json
//   ROUND_SLOTS          default 150 (program minimum)
//   CLAIM_WINDOW_SLOTS   default 150 (program minimum)
//   TICKETS              tickets in round 0 of the small pool, default 24
//   NEXT_ROUND_TICKETS   tickets in the rollover round, default 3
//   SWEEP                1 (default) returns buyer balances to the creator at the end

import * as L from "./lib.mjs";
import * as LP from "../../packages/lottery-pools/src/index.ts";
import { PublicKey } from "@solana/web3.js";

const PROGRAM_ID = process.env.PROGRAM_ID ?? "39QHCDuqugs2Fm16CtvD3SBmDJp9n2WbdNGQPtqFZSxw";
const PROG = L.b58decode(PROGRAM_ID);
const KEY_DIR = process.env.KEY_DIR ?? "./keys";
const CREATOR_KEY = process.env.CREATOR_KEY ?? `${KEY_DIR}/payer1.json`;
const BUYER_KEYS = (process.env.BUYER_KEYS ?? ["payer2", "payer3", "payer4"].map((n) => `${KEY_DIR}/${n}.json`).join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ROUND_SLOTS = BigInt(process.env.ROUND_SLOTS ?? 150);
const CLAIM_WINDOW_SLOTS = BigInt(process.env.CLAIM_WINDOW_SLOTS ?? 150);
const TICKETS = Number(process.env.TICKETS ?? 24);
const NEXT_ROUND_TICKETS = Number(process.env.NEXT_ROUND_TICKETS ?? 3);
const SWEEP = process.env.SWEEP !== "0";

const SLOT_HASHES = "SysvarS1otHashes111111111111111111111111111";
const SYSTEM = new Uint8Array(32);
const SIG_FEE = 5000n;
const BUYS_PER_TX = 8;
const E = (name) => LP.ERROR_BASE + LP.POOL_ERRORS[name];
const hex = (b) => Buffer.from(b).toString("hex");
const eqb = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const big = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

const ev = new L.Evidence("lottery-pools", {
  programId: PROGRAM_ID,
  config: { ROUND_SLOTS: String(ROUND_SLOTS), CLAIM_WINDOW_SLOTS: String(CLAIM_WINDOW_SLOTS), TICKETS, NEXT_ROUND_TICKETS, AIRDROP: L.AIRDROP },
});
ev.doc.econ = [];
ev.doc.draws = [];
ev.doc.payouts = [];

// ── wallets and accounting ──────────────────────────────────────────────────

const wallets = [];
function wallet(name, key) {
  const w = { name, key, pk: key.pk, fees: 0n, fundedIn: 0n, fundedOut: 0n, start: 0n, end: 0n, low: 0n };
  wallets.push(w);
  return w;
}
const creator = wallet("creator", L.loadKey(CREATOR_KEY));
const buyers = BUYER_KEYS.map((p, i) => wallet(`buyer${i + 1}`, L.loadKey(p)));
if (buyers.length < 3) throw new Error("need at least 3 buyer keys");
const byPk = new Map(wallets.map((w) => [w.pk, w]));

const cuStats = {};
function recordCu(kind, g) {
  if (!g || g.err !== null) return;
  for (const x of g.ixCu) {
    if (x.program !== PROGRAM_ID) continue;
    const s = (cuStats[kind] ??= { n: 0, min: Infinity, max: 0, txCu: [] });
    s.n++;
    s.min = Math.min(s.min, x.cu);
    s.max = Math.max(s.max, x.cu);
  }
  cuStats[kind].txCu.push(g.cu);
}

/** Sends one transaction through lib.run, records fee and CU. */
async function tx(label, kind, payer, ixs, signers = [], expect = "ok", opts = {}) {
  const sendOpts = { ...opts };
  if (expect !== "ok") sendOpts.skipPreflight = true;
  const g = await L.run(ev, label, () => L.sendLegacy(payer.key, ixs, signers.map((s) => s.key), sendOpts), expect, { kind, payer: payer.name });
  if (g?.fee != null) payer.fees += BigInt(g.fee);
  if (expect === "ok") recordCu(kind, g);
  if (payer === creator) {
    const b = await L.getBalance(creator.pk);
    if (b < creator.low) creator.low = b;
  }
  return g;
}

async function fundW(to, lamports, label) {
  if (L.AIRDROP) {
    await L.airdrop(to.pk, lamports);
    to.fundedIn += lamports;
    return;
  }
  const sig = await L.fund(creator.key, to.pk, lamports);
  const g = await L.readTx(sig);
  ev.step(label, g, { kind: "fund", payer: "creator" });
  ev.check(label, g.err === null, { lamports, err: g.err });
  creator.fees += BigInt(g.fee ?? 0);
  creator.fundedOut += lamports;
  to.fundedIn += lamports;
}

let RENT0 = 0n;
async function ensureBalance(w, need, label) {
  const b = await L.getBalance(w.pk);
  if (b >= need) return;
  let amt = need - b;
  if (b === 0n && amt < RENT0) amt = RENT0;
  await fundW(w, amt, `${label}: fund ${w.name} ${amt} lamports`);
}

// ── addresses and instructions ──────────────────────────────────────────────

const PROG_PK = new PublicKey(PROGRAM_ID);
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), PROG_PK)[0].toBytes();
const poolPda = (creatorPk, nonce) => pda(LP.poolSeeds(creatorPk, nonce));
const roundPda = (pool, id) => pda(LP.roundSeeds(pool, id));
const claimPda = (pool, id, idx) => pda(LP.claimSeeds(pool, id, idx));

const S = (pubkey, w = true) => ({ pubkey, isSigner: true, isWritable: w });
const W = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const R = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
const ix = (keys, data) => ({ programId: PROG, keys, data });

const ixCreate = (c, pool, nonce, p) => ix([S(c), W(pool), R(SYSTEM)], LP.encodeCreatePool(nonce, p));
const ixBuy = (payer, pool, rid, owner, nums) => ix([S(payer), W(pool), R(SYSTEM)], LP.encodeBuyTicket(rid, owner, nums));
const ixDraw = (cranker, pool, rid) => ix([S(cranker), W(pool), W(roundPda(pool, rid)), R(SLOT_HASHES), R(SYSTEM)], LP.encodeDraw());
const ixClaim = (claimant, pool, rid, idx, nums, proof) =>
  ix([S(claimant), R(pool), W(roundPda(pool, rid)), W(claimPda(pool, rid, idx)), R(SYSTEM)], LP.encodeClaim(idx, nums, proof));
const ixSettle = (pool, rid) => ix([W(pool), W(roundPda(pool, rid))], LP.encodeSettle());
const ixPayout = (pool, rid, idx, owner) => ix([W(pool), W(roundPda(pool, rid)), W(claimPda(pool, rid, idx)), W(owner)], LP.encodePayout());
const ixWithdraw = (c, pool, amt) => ix([S(c), W(pool)], LP.encodeWithdrawCreatorFees(amt));
const ixCloseRound = (pool, rid, payer) => ix([R(pool), W(roundPda(pool, rid)), W(payer)], LP.encodeCloseRound());

// ── off-chain model of the pool's books ─────────────────────────────────────

class Model {
  constructor(p, pool) {
    this.p = p;
    this.cap = pool.cap;
    this.t2cap = pool.tier2Cap;
    this.vr = LP.recoupVolume(p.seed, p.feeMaxBps);
    Object.assign(this, { jackpot: p.seed, reserve: 0n, tier2Pool: 0n, creatorOwed: 0n, creatorWithdrawn: 0n, lockedPrize: 0n, owedPrizes: 0n, totalSales: 0n, paid: 0n });
  }
  buy() {
    const s = LP.splitTicket(this.p, this.vr, this.totalSales, false);
    this.creatorOwed += s.creator;
    const [j, o] = LP.applyCap(this.jackpot, s.jackpot, this.cap);
    this.jackpot += j;
    this.reserve += s.reserve + o;
    if (s.tier2 > 0n) {
      const [t, o2] = LP.applyCap(this.tier2Pool, s.tier2, this.t2cap);
      this.tier2Pool += t;
      this.reserve += o2;
    }
    this.totalSales += this.p.ticketPrice;
  }
  draw() {
    const r = { prize: this.jackpot, tier2Prize: this.tier2Pool };
    this.lockedPrize += r.prize + r.tier2Prize;
    this.jackpot = 0n;
    this.tier2Pool = 0n;
    return r;
  }
  settle(prize, tier2Prize, winners, tier2Winners) {
    this.lockedPrize -= prize + tier2Prize;
    let back2 = tier2Prize, share2 = 0n, share = 0n;
    if (tier2Winners > 0n) {
      share2 = tier2Prize / tier2Winners;
      this.owedPrizes += share2 * tier2Winners;
      back2 = tier2Prize - share2 * tier2Winners;
    }
    const [t2, o2] = LP.applyCap(this.tier2Pool, back2, this.t2cap);
    this.tier2Pool += t2;
    this.reserve += o2;
    if (winners === 0n) {
      const [j, o] = LP.applyCap(this.jackpot, prize, this.cap);
      this.jackpot += j;
      this.reserve += o;
    } else {
      share = prize / winners;
      this.owedPrizes += share * winners;
      const [j, o] = LP.applyCap(this.jackpot, prize - share * winners, this.cap);
      this.jackpot += j;
      this.reserve += o;
      const [seeded] = LP.applyCap(this.jackpot, this.reserve, this.cap);
      this.jackpot += seeded;
      this.reserve -= seeded;
    }
    return { share, share2 };
  }
  payout(a) {
    this.owedPrizes -= a;
    this.paid += a;
  }
  withdraw(a) {
    this.creatorOwed -= a;
    this.creatorWithdrawn += a;
  }
}

const MODEL_FIELDS = ["jackpot", "reserve", "tier2Pool", "creatorOwed", "creatorWithdrawn", "lockedPrize", "owedPrizes", "totalSales"];
let POOL_RENT = 0n;

async function readPool(P) {
  const a = await L.getAccount(P.pool);
  return { acct: a, pool: LP.decodePool(a.data) };
}

/** Compares chain state with the model; checks solvency and lifetime conservation. */
async function econ(label, P) {
  const { acct, pool } = await readPool(P);
  const m = P.model;
  const mismatches = MODEL_FIELDS.filter((f) => pool[f] !== m[f]).map((f) => ({ field: f, chain: pool[f], model: m[f] }));
  const liab = LP.poolLiabilities(pool);
  const entry = {
    label,
    lamports: acct.lamports,
    liabilities: liab,
    rent: POOL_RENT,
    ...Object.fromEntries(MODEL_FIELDS.map((f) => [f, pool[f]])),
    paidOut: m.paid,
  };
  ev.doc.econ.push(big(entry));
  ev.check(`${label}: pool books equal the off-chain model`, mismatches.length === 0, mismatches.length ? { mismatches } : {});
  ev.check(`${label}: lamports >= liabilities + rent`, acct.lamports >= liab + POOL_RENT, { lamports: acct.lamports, need: liab + POOL_RENT });
  ev.check(`${label}: lamports == liabilities + rent (no surplus, no deficit)`, acct.lamports === liab + POOL_RENT);
  const lhs = P.params.seed + pool.totalSales;
  const rhs = pool.jackpot + pool.reserve + pool.tier2Pool + pool.creatorOwed + pool.creatorWithdrawn + pool.lockedPrize + pool.owedPrizes + m.paid;
  ev.check(`${label}: seed + sales == jackpot + reserve + tier2 + creator owed + withdrawn + locked + owed + paid`, lhs === rhs, { lhs, rhs });
  return pool;
}

// ── tickets, tree, draw ─────────────────────────────────────────────────────

function randomTicket(k, n) {
  const pick = new Set();
  const rnd = crypto.getRandomValues(new Uint32Array(64));
  let i = 0;
  while (pick.size < k) {
    if (i >= rnd.length) throw new Error("rng");
    pick.add((rnd[i++] % n) + 1);
  }
  return [...pick].sort((a, b) => a - b);
}

function combos(n, k) {
  const out = [];
  const rec = (start, acc) => {
    if (acc.length === k) return out.push(acc.slice());
    for (let x = start; x <= n; x++) rec(x + 1, [...acc, x]);
  };
  rec(1, []);
  return out;
}

/** Buys tickets [{buyer, numbers}] for round `rid`; returns the parsed ticket logs. */
async function buyTickets(P, rid, list, labelPrefix) {
  const logs = [];
  const byBuyer = new Map();
  for (const t of list) {
    if (!byBuyer.has(t.buyer)) byBuyer.set(t.buyer, []);
    byBuyer.get(t.buyer).push(t);
  }
  for (const [b, ts] of byBuyer) {
    for (let i = 0; i < ts.length; i += BUYS_PER_TX) {
      const chunk = ts.slice(i, i + BUYS_PER_TX);
      const ixs = chunk.map((t) => ixBuy(b.key.publicKey, P.pool, rid, b.key.publicKey, t.numbers));
      const g = await tx(`${labelPrefix}: ${b.name} buys ${chunk.length} ticket(s)`, "BuyTicket", b, ixs, [], "ok", { cuLimit: 20_000 * chunk.length });
      if (!g || g.err) continue;
      for (const _ of chunk) P.model.buy();
      for (const l of g.logs) {
        const t = LP.parseTicketLog(l, P.pool);
        if (t) logs.push(t);
      }
    }
  }
  return logs;
}

/** Rebuilds the round's leaves from the logs; checks indexes and the root against chain. */
function checkTree(label, logs, rid, chainRoot, chainCount) {
  const mine = logs.filter((t) => t.roundId === rid).sort((a, b) => (a.ticketIndex < b.ticketIndex ? -1 : 1));
  const contiguous = mine.every((t, i) => t.ticketIndex === BigInt(i));
  const leaves = mine.map((t) => t.leaf);
  const inc = new LP.IncrementalTree();
  for (const l of leaves) inc.append(l);
  const root = LP.rootOf(leaves);
  ev.check(`${label}: ticket logs are contiguous 0..${mine.length - 1} and count matches chain`, contiguous && BigInt(mine.length) === chainCount, { logs: mine.length, chainCount });
  ev.check(`${label}: tree rebuilt from logs equals the on-chain root`, eqb(root, chainRoot) && eqb(inc.root, chainRoot), { rebuilt: hex(root), chain: hex(chainRoot) });
  return { tickets: mine, leaves };
}

function parseSlotHashes(d) {
  const n = Number(new DataView(d.buffer, d.byteOffset).getBigUint64(0, true));
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 8 + 40 * i;
    out.push({ slot: new DataView(d.buffer, d.byteOffset).getBigUint64(o, true), hash: d.slice(o + 8, o + 40) });
  }
  return out;
}

/** Draws round `rid` and recomputes the numbers off chain. */
async function drawAndVerify(P, rid, closeSlot, label) {
  const t0 = closeSlot + LP.DRAW_DELAY_SLOTS;
  await L.waitSlot(t0 + 2n, `${label}: target slot`);
  const g = await tx(`${label}: Draw round ${rid}`, "Draw", creator, [ixDraw(creator.key.publicKey, P.pool, rid)], [], "ok", { cuLimit: 100_000 });
  const sh = await L.getAccount(SLOT_HASHES);
  const ra = await L.getAccount(roundPda(P.pool, rid));
  if (!g || g.err || !ra) {
    ev.check(`${label}: round account exists after Draw`, false);
    return null;
  }
  const round = LP.decodeRound(ra.data);
  const entries = parseSlotHashes(sh.data);
  const sel = LP.selectSlotHash(entries, t0);
  const used = entries.find((e) => e.slot === round.usedSlot);
  ev.check(`${label}: SlotHashes selection off chain equals the recorded target/used slot/hash`,
    !sel.error && sel.attempt === round.attempt && sel.targetSlot === round.targetSlot && sel.usedSlot === round.usedSlot && eqb(sel.hash, round.slotHash) && !!used && eqb(used.hash, round.slotHash),
    { t0, attempt: round.attempt, target: round.targetSlot, used: round.usedSlot, offchainUsed: sel.usedSlot, drawTxSlot: g.slot });
  const entropy = LP.drawEntropy(P.pool, rid, { attempt: round.attempt, targetSlot: round.targetSlot, usedSlot: round.usedSlot, hash: round.slotHash }, round.root, round.ticketCount);
  const nums = LP.drawNumbers(entropy, P.params.pickK, P.params.rangeN);
  ev.check(`${label}: drawn numbers recomputed off chain equal the on-chain numbers`, nums.every((x, i) => x === round.numbers[i]), { offchain: nums, chain: round.numbers });
  ev.doc.draws.push(big({ label, pool: L.b58encode(P.pool), roundId: rid, t0, attempt: round.attempt, targetSlot: round.targetSlot, usedSlot: round.usedSlot, drawSlot: round.drawSlot, numbers: round.numbers.slice(0, P.params.pickK), prize: round.prize, tier2Prize: round.tier2Prize, ticketCount: round.ticketCount, windowEnd: round.windowEnd }));
  return round;
}

function winnersOf(P, tickets, round) {
  const t2on = (P.params.tier2Bps ?? 0) > 0;
  return tickets
    .map((t) => ({ ...t, tier: LP.prizeTier(t.numbers, round.numbers, P.params.pickK, t2on) }))
    .filter((t) => t.tier !== 0);
}

/** Registers each winning ticket (owner signs), in parallel. */
async function claimAll(P, rid, winners, leaves, label) {
  const claimRent = await L.rentExempt(LP.CLAIM_LEN);
  const need = new Map();
  for (const w of winners) need.set(w.owner58, (need.get(w.owner58) ?? 0n) + claimRent + 2n * SIG_FEE);
  for (const [pk, amt] of need) await ensureBalance(byPk.get(pk), amt + RENT0, `${label}: claim rent`);
  await Promise.all(
    winners.map((w) => {
      const o = byPk.get(w.owner58);
      const proof = LP.proofOf(leaves, Number(w.ticketIndex));
      return tx(`${label}: ${o.name} claims ticket ${w.ticketIndex} (tier ${w.tier})`, "Claim", o, [ixClaim(o.key.publicKey, P.pool, rid, w.ticketIndex, w.numbers, proof)], [], "ok", { cuLimit: 60_000 });
    }),
  );
}

/** Pays every registered ticket (creator pays the fee) and checks each owner's balance delta. */
async function payAll(P, rid, winners, round, label) {
  for (const w of winners) {
    const o = byPk.get(w.owner58);
    const share = w.tier === LP.TIER_JACKPOT ? round.share : round.tier2Share;
    const ca = await L.getAccount(claimPda(P.pool, rid, w.ticketIndex));
    const before = await L.getBalance(o.pk);
    const g = await tx(`${label}: Payout ticket ${w.ticketIndex} to ${o.name}`, "Payout", creator, [ixPayout(P.pool, rid, w.ticketIndex, o.key.publicKey)], [], "ok", { cuLimit: 40_000 });
    const after = await L.getBalance(o.pk);
    const gone = (await L.getAccount(claimPda(P.pool, rid, w.ticketIndex))) === null;
    if (g && !g.err) P.model.payout(share);
    const expected = share + (ca?.lamports ?? 0n);
    ev.check(`${label}: ${o.name} received exactly share + claim rent for ticket ${w.ticketIndex}, record closed`, after - before === expected && gone, { delta: after - before, share, claimRent: ca?.lamports, tier: w.tier });
    ev.doc.payouts.push(big({ label, ticket: w.ticketIndex, owner: o.name, tier: w.tier, share, claimRent: ca?.lamports, delta: after - before }));
  }
}

async function closeRound(P, rid, label) {
  const ra = await L.getAccount(roundPda(P.pool, rid));
  const before = await L.getBalance(creator.pk);
  const g = await tx(`${label}: CloseRound ${rid}`, "CloseRound", creator, [ixCloseRound(P.pool, rid, creator.key.publicKey)], [], "ok", { cuLimit: 30_000 });
  const after = await L.getBalance(creator.pk);
  const gone = (await L.getAccount(roundPda(P.pool, rid))) === null;
  ev.check(`${label}: round rent returned to the cranker, account closed`, !!g && !g.err && gone && after - before === ra.lamports - BigInt(g.fee), { rent: ra?.lamports, delta: after - before, fee: g?.fee });
}

async function withdrawAll(P, label) {
  const { pool } = await readPool(P);
  const amt = pool.creatorOwed;
  const before = await L.getBalance(creator.pk);
  const g = await tx(`${label}: WithdrawCreatorFees ${amt}`, "WithdrawCreatorFees", creator, [ixWithdraw(creator.key.publicKey, P.pool, amt)], [], "ok", { cuLimit: 30_000 });
  const after = await L.getBalance(creator.pk);
  if (g && !g.err) P.model.withdraw(amt);
  ev.check(`${label}: creator received the accrued fees`, !!g && !g.err && after - before === amt - BigInt(g.fee), { amount: amt, delta: after - before, fee: g?.fee });
  await econ(`${label}: after withdraw`, P);
}

async function createPool(label, params) {
  const nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const pool = poolPda(creator.key.publicKey, nonce);
  const g = await tx(`${label}: CreatePool`, "CreatePool", creator, [ixCreate(creator.key.publicKey, pool, nonce, params)], [], "ok", { cuLimit: 60_000 });
  if (!g || g.err) throw new Error(`${label}: CreatePool failed`);
  const { acct, pool: st } = await readPool({ pool });
  const P = { label, pool, nonce, params, model: new Model(params, st) };
  const pOk = ["seed", "ticketPrice", "feeMaxBps", "feeMinBps", "reserveBps", "capBps", "pickK", "rangeN", "roundSlots", "claimWindowSlots", "tier2Bps"].every((f) => st.params[f] === (params[f] ?? 0));
  const C = LP.binom(params.rangeN, params.pickK);
  ev.check(`${label}: pool params, combos, caps and recoup volume as created`,
    pOk && eqb(st.creator, creator.key.publicKey) && st.combos === C && st.cap === LP.jackpotCap(params.capBps, params.ticketPrice, C) &&
      st.tier2Cap === LP.jackpotCap(params.tier2Bps ?? 0, params.ticketPrice, C) && st.recoupVolume === LP.recoupVolume(params.seed, params.feeMaxBps) &&
      st.roundId === 0n && st.roundCloseSlot === st.roundOpenSlot + params.roundSlots && acct.lamports === POOL_RENT + params.seed,
    { pool: L.b58encode(pool), combos: st.combos, cap: st.cap, tier2Cap: st.tier2Cap, lamports: acct.lamports });
  ev.doc[`pool_${label}`] = L.b58encode(pool);
  await econ(`${label}: after CreatePool`, P);
  return P;
}

// ── scenarios ───────────────────────────────────────────────────────────────

async function scenarioSmallPool() {
  const label = "small";
  const params = { ...LP.SMALL_POOL_PRESET, roundSlots: ROUND_SLOTS, claimWindowSlots: CLAIM_WINDOW_SLOTS };
  const per = Math.ceil(TICKETS / buyers.length);
  const r0list = Array.from({ length: TICKETS }, (_, i) => ({ buyer: buyers[i % buyers.length], numbers: randomTicket(params.pickK, params.rangeN) }));
  const claimRent = await L.rentExempt(LP.CLAIM_LEN);
  // Pre-fund before the pool opens so funding does not eat into the sales window.
  for (const b of buyers) {
    await ensureBalance(b, BigInt(per + NEXT_ROUND_TICKETS) * params.ticketPrice + 2n * claimRent + 20n * SIG_FEE + RENT0, label);
  }

  const P = await createPool(label, params);
  let { pool } = await readPool(P);

  // Negative: Draw before close.
  await tx(`${label}: Draw before close`, "Draw", creator, [ixDraw(creator.key.publicKey, P.pool, 0n)], [], E("SalesOpen"));

  // Round 0 sales.
  const logs0 = await buyTickets(P, 0n, r0list, `${label} r0`);
  pool = await econ(`${label} r0: after ${TICKETS} buys`, P);
  const tree0 = checkTree(`${label} r0`, logs0, 0n, pool.root, pool.ticketCount);
  const summary = LP.poolSummary(params, { salesPoints: [pool.totalSales] });
  ev.check(`${label} r0: poolSummary at the sold volume equals chain (creator fees, jackpot, caps, recoup)`,
    summary.seeder.atSales[0].creatorFees === pool.creatorOwed && summary.buyer.jackpotAt[0].jackpot === pool.jackpot &&
      summary.combos === pool.combos && summary.jackpotCap === pool.cap && summary.tier2Cap === pool.tier2Cap && summary.seeder.recoupVolume === pool.recoupVolume,
    { summaryCreatorFees: summary.seeder.atSales[0].creatorFees, chainCreatorOwed: pool.creatorOwed, summaryJackpot: summary.buyer.jackpotAt[0].jackpot, chainJackpot: pool.jackpot });
  ev.doc.smallPoolSummary = big({ combos: summary.combos, jackpotCap: summary.jackpotCap, tier2Cap: summary.tier2Cap, recoupVolume: summary.seeder.recoupVolume, recoupTickets: summary.seeder.recoupTickets, atSales: summary.seeder.atSales, pJackpot: summary.buyer.pJackpot, pTier2: summary.buyer.pTier2 });

  // Negative: buy after close.
  const close0 = pool.roundCloseSlot;
  await L.waitSlot(close0, `${label} r0 close`);
  await tx(`${label} r0: BuyTicket after close`, "BuyTicket", buyers[0], [ixBuy(buyers[0].key.publicKey, P.pool, 0n, buyers[0].key.publicKey, r0list[0].numbers)], [], E("SalesClosed"));

  // Draw round 0.
  const round0 = await drawAndVerify(P, 0n, close0, `${label} r0`);
  if (!round0) return;
  const drawn0 = P.model.draw();
  ev.check(`${label} r0: locked prizes equal the pre-draw jackpot and tier-2 pool`, round0.prize === drawn0.prize && round0.tier2Prize === drawn0.tier2Prize && eqb(round0.root, pool.root) && round0.ticketCount === pool.ticketCount, { prize: round0.prize, tier2Prize: round0.tier2Prize });
  pool = await econ(`${label} r0: after Draw`, P);

  // Round 1 sales during round 0's claim window (these winners will deliberately not register).
  const r1list = Array.from({ length: NEXT_ROUND_TICKETS }, (_, i) => ({ buyer: buyers[i % buyers.length], numbers: randomTicket(params.pickK, params.rangeN) }));
  const logs1 = await buyTickets(P, 1n, r1list, `${label} r1`);

  // Register every round-0 winner.
  const tickets0 = tree0.tickets.map((t) => ({ ...t, owner58: L.b58encode(t.owner) }));
  const win0 = winnersOf(P, tickets0, round0);
  ev.doc.smallRound0Winners = big(win0.map((w) => ({ ticket: w.ticketIndex, owner: byPk.get(w.owner58).name, numbers: w.numbers.slice(0, 3), tier: w.tier })));
  console.log(`  ${label} r0 drawn ${round0.numbers.slice(0, 3)}: ${win0.length} winning ticket(s)`);
  await claimAll(P, 0n, win0, tree0.leaves, `${label} r0`);
  const ra0 = LP.decodeRound((await L.getAccount(roundPda(P.pool, 0n))).data);
  const nJ = BigInt(win0.filter((w) => w.tier === LP.TIER_JACKPOT).length), n2 = BigInt(win0.filter((w) => w.tier === LP.TIER_SECOND).length);
  ev.check(`${label} r0: registered winner counts on chain match the off-chain scan`, ra0.winners === nJ && ra0.tier2Winners === n2, { jackpot: ra0.winners, tier2: ra0.tier2Winners });

  // Settle round 0.
  await L.waitSlot(round0.windowEnd + 1n, `${label} r0 window end`);
  pool = (await readPool(P)).pool;
  const jBefore = pool.jackpot, t2Before = pool.tier2Pool;
  await tx(`${label} r0: Settle`, "Settle", creator, [ixSettle(P.pool, 0n)], [], "ok", { cuLimit: 30_000 });
  const exp0 = P.model.settle(round0.prize, round0.tier2Prize, nJ, n2);
  const rs0 = LP.decodeRound((await L.getAccount(roundPda(P.pool, 0n))).data);
  ev.check(`${label} r0: settled shares equal floor(prize / registered winners)`, rs0.status === "settled" && rs0.share === exp0.share && rs0.tier2Share === exp0.share2, { share: rs0.share, tier2Share: rs0.tier2Share });
  pool = await econ(`${label} r0: after Settle`, P);
  if (nJ === 0n) {
    const [j] = LP.applyCap(jBefore, round0.prize, pool.cap);
    ev.check(`${label} r0: no jackpot registered, the jackpot rolled into round 1`, pool.jackpot === jBefore + j, { before: jBefore, rolled: j, after: pool.jackpot });
  }
  if (n2 === 0n) {
    const [t] = LP.applyCap(t2Before, round0.tier2Prize, pool.tier2Cap);
    ev.check(`${label} r0: no tier-2 registered, the tier-2 pool rolled into round 1`, pool.tier2Pool === t2Before + t, { before: t2Before, after: pool.tier2Pool });
  }
  await payAll(P, 0n, win0, rs0, `${label} r0`);
  await closeRound(P, 0n, `${label} r0`);
  await econ(`${label} r0: after payouts and CloseRound`, P);

  // Round 1: draw, nobody registers, Settle rolls both prizes into round 2.
  pool = (await readPool(P)).pool;
  const tree1 = checkTree(`${label} r1`, logs1, 1n, pool.root, pool.ticketCount);
  const round1 = await drawAndVerify(P, 1n, pool.roundCloseSlot, `${label} r1`);
  if (!round1) return;
  P.model.draw();
  const unclaimed = winnersOf(P, tree1.tickets, round1);
  ev.doc.smallRound1UnregisteredWinners = unclaimed.length;
  await econ(`${label} r1: after Draw`, P);
  await L.waitSlot(round1.windowEnd + 1n, `${label} r1 window end`);
  pool = (await readPool(P)).pool;
  const j1 = pool.jackpot, t21 = pool.tier2Pool, res1 = pool.reserve;
  await tx(`${label} r1: Settle with no registered ticket`, "Settle", creator, [ixSettle(P.pool, 1n)], [], "ok", { cuLimit: 30_000 });
  P.model.settle(round1.prize, round1.tier2Prize, 0n, 0n);
  pool = await econ(`${label} r1: after rollover Settle`, P);
  const [rj, oj] = LP.applyCap(j1, round1.prize, pool.cap);
  const [rt, ot] = LP.applyCap(t21, round1.tier2Prize, pool.tier2Cap);
  ev.check(`${label} r1: next jackpot grew by the rolled prize (overflow to reserve)`, pool.jackpot === j1 + rj && pool.reserve === res1 + oj + ot && pool.jackpot > j1, { before: j1, prize: round1.prize, after: pool.jackpot });
  ev.check(`${label} r1: next tier-2 pool grew by the rolled tier-2 prize`, pool.tier2Pool === t21 + rt, { before: t21, tier2Prize: round1.tier2Prize, after: pool.tier2Pool });
  await closeRound(P, 1n, `${label} r1`);

  // Round 2: no tickets, Draw rolls it without a round account.
  pool = (await readPool(P)).pool;
  await L.waitSlot(pool.roundCloseSlot, `${label} r2 close`);
  const jb = pool.jackpot;
  const g = await tx(`${label} r2: Draw of an empty round`, "Draw(empty)", creator, [ixDraw(creator.key.publicKey, P.pool, 2n)], [], "ok", { cuLimit: 100_000 });
  const emptyLog = g?.logs.some((l) => l.startsWith("Program data: ") && Buffer.from(l.slice(14).split(" ")[0], "base64").toString() === "empty");
  const after = (await readPool(P)).pool;
  const noRound = (await L.getAccount(roundPda(P.pool, 2n))) === null;
  ev.check(`${label} r2: empty round rolled by Draw (log "empty", no round account, jackpot kept, round 3 open)`, !!emptyLog && noRound && after.jackpot === jb && after.roundId === 3n && !after.hasPending && after.ticketCount === 0n, { roundId: after.roundId, jackpot: after.jackpot });
  await econ(`${label} r2: after empty Draw`, P);

  await withdrawAll(P, label);
}

async function scenarioGuaranteed() {
  const label = "allcombos";
  const params = { seed: 20_000n, ticketPrice: 10_000n, feeMaxBps: 1000, feeMinBps: 500, reserveBps: 500, capBps: 7000, pickK: 2, rangeN: 4, roundSlots: ROUND_SLOTS, claimWindowSlots: CLAIM_WINDOW_SLOTS, tier2Bps: 2000 };
  ev.check(`${label}: params within the SDK bounds`, LP.validParams(params));
  const list = combos(params.rangeN, params.pickK).map((numbers, i) => ({ buyer: buyers[i % 3], numbers }));
  for (const b of buyers.slice(0, 3)) await ensureBalance(b, 4n * params.ticketPrice + 2n * (await L.rentExempt(LP.CLAIM_LEN)) + 20n * SIG_FEE + RENT0, label);
  const P = await createPool(label, params);
  const logs = await buyTickets(P, 0n, list, label);
  let pool = await econ(`${label}: after buying all ${list.length} combinations`, P);
  ev.check(`${label}: jackpot reached its cap, overflow went to the reserve`, pool.jackpot === pool.cap && pool.tier2Pool === pool.tier2Cap, { jackpot: pool.jackpot, cap: pool.cap, reserve: pool.reserve });
  const tree = checkTree(label, logs, 0n, pool.root, pool.ticketCount);
  const round = await drawAndVerify(P, 0n, pool.roundCloseSlot, label);
  if (!round) return;
  P.model.draw();
  await econ(`${label}: after Draw`, P);
  const tickets = tree.tickets.map((t) => ({ ...t, owner58: L.b58encode(t.owner) }));
  const win = winnersOf(P, tickets, round);
  const jp = win.filter((w) => w.tier === LP.TIER_JACKPOT), t2 = win.filter((w) => w.tier === LP.TIER_SECOND);
  ev.check(`${label}: exactly 1 jackpot and 4 tier-2 tickets among the 6 combinations`, jp.length === 1 && t2.length === 4, { drawn: round.numbers.slice(0, 2), jackpot: jp.length, tier2: t2.length });
  const jw = jp[0];
  const owner = byPk.get(jw.owner58);
  const other = buyers.find((b) => b !== owner);
  const proof = LP.proofOf(tree.leaves, Number(jw.ticketIndex));

  // Negative: someone else's winning ticket (valid proof for the owner's leaf).
  await ensureBalance(other, 2n * (await L.rentExempt(LP.CLAIM_LEN)) + RENT0, label);
  await tx(`${label}: ${other.name} claims ${owner.name}'s jackpot ticket`, "Claim", other, [ixClaim(other.key.publicKey, P.pool, 0n, jw.ticketIndex, jw.numbers, proof)], [], E("InvalidProof"));
  await claimAll(P, 0n, win, tree.leaves, label);
  // Negative: second claim of the same ticket (different CU limit so the signature differs).
  await tx(`${label}: ${owner.name} claims ticket ${jw.ticketIndex} again`, "Claim", owner, [ixClaim(owner.key.publicKey, P.pool, 0n, jw.ticketIndex, jw.numbers, proof)], [], E("AlreadyClaimed"), { cuLimit: 61_000 });
  // Negative: Settle while the claim window is open.
  await tx(`${label}: Settle during the claim window`, "Settle", creator, [ixSettle(P.pool, 0n)], [], E("ClaimWindowOpen"));

  await L.waitSlot(round.windowEnd + 1n, `${label} window end`);
  await tx(`${label}: Settle`, "Settle", creator, [ixSettle(P.pool, 0n)], [], "ok", { cuLimit: 30_000 });
  const exp = P.model.settle(round.prize, round.tier2Prize, 1n, 4n);
  const rs = LP.decodeRound((await L.getAccount(roundPda(P.pool, 0n))).data);
  ev.check(`${label}: share = whole jackpot, tier-2 share = tier-2 pool / 4`, rs.share === round.prize && rs.tier2Share === round.tier2Prize / 4n && rs.share === exp.share && rs.tier2Share === exp.share2, { share: rs.share, tier2Share: rs.tier2Share, prize: round.prize, tier2Prize: round.tier2Prize });
  pool = await econ(`${label}: after Settle (reserve seeds the next jackpot)`, P);
  ev.check(`${label}: after a win the next jackpot is seeded from the reserve`, pool.lastSettleWon && pool.jackpot > 0n, { jackpot: pool.jackpot, reserve: pool.reserve });
  await payAll(P, 0n, win, rs, label);
  await closeRound(P, 0n, label);
  await econ(`${label}: after payouts and CloseRound`, P);
  await withdrawAll(P, label);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  RENT0 = await L.rentExempt(0);
  POOL_RENT = await L.rentExempt(LP.POOL_LEN);
  const prog = await L.getAccount(PROGRAM_ID);
  ev.check("program account is executable", !!prog, { owner: prog?.owner });
  if (L.AIRDROP) {
    const b = await L.getBalance(creator.pk);
    if (b < 3_000_000_000n) await L.airdrop(creator.pk, 3_000_000_000n);
  }
  for (const w of wallets) {
    w.start = await L.getBalance(w.pk);
    w.low = w.start;
  }
  const minCreator = 900_000_000n;
  if (creator.start < minCreator) throw new Error(`creator ${creator.pk} has ${creator.start} lamports, needs about ${minCreator}`);
  console.log(`creator ${creator.pk} ${creator.start}; buyers ${buyers.map((b) => b.pk).join(", ")}`);

  await scenarioSmallPool();
  await scenarioGuaranteed();

  if (SWEEP) {
    for (const b of buyers) {
      const bal = await L.getBalance(b.pk);
      if (bal <= SIG_FEE) continue;
      const amt = bal - SIG_FEE;
      const sig = await L.fund(b.key, creator.pk, amt);
      const g = await L.readTx(sig);
      ev.step(`sweep ${b.name} -> creator`, g, { kind: "sweep", payer: b.name });
      ev.check(`sweep ${b.name} back to the creator`, g.err === null, { lamports: amt });
      b.fees += BigInt(g.fee ?? 0);
      b.fundedOut += amt;
      creator.fundedIn += amt;
    }
  }
}

let fatal = null;
try {
  await main();
} catch (e) {
  fatal = e;
  ev.check("script completed without exception", false, { error: String(e?.stack ?? e).slice(0, 800) });
}
for (const w of wallets) w.end = await L.getBalance(w.pk).catch(() => 0n);
ev.doc.summary = big({
  cu: Object.fromEntries(Object.entries(cuStats).map(([k, s]) => [k, { n: s.n, min: s.min, max: s.max, txCuMin: Math.min(...s.txCu), txCuMax: Math.max(...s.txCu) }])),
  feesTotal: ev.doc.steps.reduce((a, s) => a + (s.fee ?? 0), 0),
  txCount: ev.doc.steps.length,
  checks: ev.doc.checks.length,
});
ev.doc.solSpent = big(
  Object.fromEntries(
    wallets.map((w) => [w.name, { pubkey: w.pk, start: w.start, end: w.end, netSpent: w.start - w.end, fees: w.fees, fundedIn: w.fundedIn, fundedOut: w.fundedOut, peakOutlay: w.start - w.low }]),
  ),
);
ev.doc.solSpent.allWalletsNet = String(wallets.reduce((a, w) => a + (w.start - w.end), 0n));
console.log("CU:", JSON.stringify(ev.doc.summary.cu));
console.log("solSpent:", JSON.stringify(ev.doc.solSpent));
ev.save("lottery-pools.json");
if (fatal) console.error(fatal);
process.exit(ev.failures === 0 && !fatal ? 0 : 1);
