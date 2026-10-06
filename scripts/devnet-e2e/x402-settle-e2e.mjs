// End-to-end run of the x402_settle program on a live cluster (local Agave
// validator for the rehearsal, devnet for the real run). Every outcome is read
// back from the ledger (getTransaction: err, logs, CU, fee) and checked.
//
//   RPC_URL=...  FUNDER_KEY=<keypair>  PAYEE_KEYS=<k1>,<k2>  WALLETS_FILE=<json>  \
//   node --experimental-strip-types scripts/devnet-e2e/x402-settle-e2e.mjs
//
// Env:
//   PROGRAM_ID     default DFt7SG4WUiy6qpYJRLTKdcx4dvSHE1dVG5sbTfXWbfZE
//   FUNDER_KEY     pays fees, rent and deposits (required unless AIRDROP=1 with KEY_DIR)
//   PAYEE_KEYS     two payee keypairs (they register book slots and withdraw)
//   WALLETS_FILE   JSON file holding the generated payer keys, so escrow funds
//                  stay recoverable (PHASE=cleanup withdraws them after the
//                  9,000-slot exit delay). Created if missing (mode 600).
//   PAYERS         number of payer escrows (default 26; B2 max needs 25)
//   PHASE          "main" (default) or "cleanup"
//   EVIDENCE_DIR   where x402-settle.json is written
//
// The SOL ledger is created once per program id (InitLedger); a second run
// reuses it, its book pages and registered payee slots.

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import * as L from "./lib.mjs";
import * as X from "../../packages/x402-settle/src/index.ts";

const PROGRAM_ID = process.env.PROGRAM_ID ?? "DFt7SG4WUiy6qpYJRLTKdcx4dvSHE1dVG5sbTfXWbfZE";
const KEY_DIR = process.env.KEY_DIR ?? "./keys";
const PID = L.b58decode(PROGRAM_ID);
const PHASE = process.env.PHASE ?? "main";
const NPAY = Number(process.env.PAYERS ?? 26);
const WALLETS_FILE = process.env.WALLETS_FILE ?? `${L.EVIDENCE_DIR}/x402-settle-wallets.json`;

const funder = L.loadKey(process.env.FUNDER_KEY ?? `${KEY_DIR}/payer1.json`);
const [payeeA, payeeB] = (process.env.PAYEE_KEYS ?? `${KEY_DIR}/payee1.json,${KEY_DIR}/payee2.json`).split(",").map(L.loadKey);

const ev = new L.Evidence("x402-settle", { programId: PROGRAM_ID, phase: PHASE, funder: funder.pk, payees: [payeeA.pk, payeeB.pk] });
const [LEDGER] = X.ledgerPda(PID, X.SOL_MINT);
const SOL0 = X.SOL_MINT;
const quote = (s) => createHash("sha256").update(`x402-quote:${s}`).digest();
const E = (n) => X.ERROR_BASE + n;
const ERR = Object.fromEntries(X.ERROR_NAMES.map((n, i) => [n, X.ERROR_BASE + i]));

// ── V1 transactions ─────────────────────────────────────────────────────────

async function sendV1(feePayer, ixs, signers = [], opts = {}) {
  const bh = await L.latestBlockhash();
  const cfg = { computeUnitLimit: opts.cu ?? 1_400_000, loadedAccountsDataSize: opts.loaded ?? 1 << 20 };
  const tx = X.buildV1Transaction(feePayer, ixs, bh.bytes, signers, cfg);
  const msg = X.compileMessage(feePayer.publicKey, ixs);
  const n = msg.numRequiredSignatures;
  const sig = L.b58encode(tx.slice(tx.length - 64 * n, tx.length - 64 * (n - 1)));
  return L.sendRaw(tx, sig, opts);
}

/** Sends, reads back, records; `expect` is "ok" or an error code. Adds V1 size info. */
async function tx(label, feePayer, ixs, signers = [], expect = "ok", opts = {}) {
  const size = X.v1Size(feePayer.publicKey, ixs);
  const g = await L.run(ev, label, () => sendV1(feePayer, ixs, signers, { skipPreflight: expect !== "ok", ...opts }), expect, { v1: size, ...(opts.extra ?? {}) });
  return g;
}

const cuRows = [];
function cuRow(name, g, n = 1, readme) {
  if (!g || g.err) return;
  const prog = g.ixCu.filter((x) => x.program === PROGRAM_ID).map((x) => x.cu);
  const total = prog.reduce((a, b) => a + b, 0);
  cuRows.push({ instruction: name, count: n, cu: total, perItem: n > 1 ? Math.round(total / n) : undefined, readmeClusterEstimate: readme, fee: g.fee, signature: g.signature });
}

// ── state readers ───────────────────────────────────────────────────────────

const acct = async (k) => (await L.getAccount(k))?.data ?? null;
const ledger = async () => X.decodeLedger(await acct(LEDGER));
const escrowOf = async (payer) => {
  const d = await acct(X.escrowPda(PID, LEDGER, payer.publicKey)[0]);
  return d ? X.decodeEscrow(d) : null;
};
const book = async (page) => X.decodeBook(await acct(X.bookPda(PID, LEDGER, page)[0]));

/** Solvency: liabilities == sum of every entry of the ledger (escrows, channels,
 *  batch holds, book slots, read with getProgramAccounts) == SOL holdings
 *  (ledger lamports - rent). */
async function solvency(label) {
  const l = await ledger();
  const la = await L.getAccount(LEDGER);
  const holdings = la.lamports - (await L.rentExempt(X.LEDGER_LEN));
  const all = await L.rpc("getProgramAccounts", [PROGRAM_ID, { encoding: "base64", commitment: "confirmed" }]);
  const lk = L.b58encode(LEDGER);
  let sum = 0n;
  const counts = {};
  for (const a of all) {
    const d = Uint8Array.from(Buffer.from(a.account.data[0], "base64"));
    const disc = Buffer.from(d.subarray(0, 8)).toString();
    counts[disc] = (counts[disc] ?? 0) + 1;
    if (disc === "x4sESCRW") { const e = X.decodeEscrow(d); if (L.b58encode(e.ledger) === lk) sum += e.balance; }
    else if (disc === "x4sCHANL") { const c = X.decodeChannel(d); if (L.b58encode(c.ledger) === lk) sum += c.balance; }
    else if (disc === "x4sBATCH") { const b = X.decodeBatch(d); if (L.b58encode(b.ledger) === lk) sum += b.held; }
    else if (disc === "x4sBOOK_") { const b = X.decodeBook(d); if (L.b58encode(b.ledger) === lk) for (const s of b.slots) sum += s.balance; }
  }
  ev.check(`solvency ${label}: holdings >= liabilities`, holdings >= l.liabilities, { holdings, liabilities: l.liabilities });
  ev.check(`solvency ${label}: liabilities == sum of entries`, l.liabilities === sum, { liabilities: l.liabilities, entries: sum, accounts: counts });
  return { liabilities: l.liabilities, holdings, entries: sum };
}

// ── wallets ─────────────────────────────────────────────────────────────────

function loadWallets() {
  if (existsSync(WALLETS_FILE)) {
    const j = JSON.parse(readFileSync(WALLETS_FILE, "utf8"));
    return j.payers.map((s) => L.keyFromSecret(Uint8Array.from(s)));
  }
  const payers = Array.from({ length: NPAY }, () => L.freshKey());
  writeFileSync(WALLETS_FILE, JSON.stringify({ programId: PROGRAM_ID, payers: payers.map((p) => [...p.secretKey]) }));
  chmodSync(WALLETS_FILE, 0o600);
  return payers;
}

// ── setup ───────────────────────────────────────────────────────────────────

async function ensureLedger() {
  if (!(await acct(LEDGER))) {
    const g = await tx("InitLedger (SOL)", funder, [X.initLedgerSol(PID, funder.publicKey)]);
    cuRow("InitLedger (SOL)", g, 1, 6196);
  }
  const l = await ledger();
  ev.doc.ledger = { address: L.b58encode(LEDGER), salt: Buffer.from(l.salt).toString("hex"), exitDelaySlots: l.exitDelaySlots, disputeSlots: l.disputeSlots, batchTimeoutSlots: l.batchTimeoutSlots };
  return l;
}

async function ensureBookSlot(page, payee) {
  const [bk] = X.bookPda(PID, LEDGER, page);
  if (!(await acct(bk))) {
    const g = await tx(`CreateBook page ${page}`, funder, [X.createBook(PID, LEDGER, funder.publicKey, page)]);
    cuRow("CreateBook", g, 1, 8422);
  }
  let b = await book(page);
  let slot = b.slots.findIndex((s) => L.b58encode(s.owner) === payee.pk);
  if (slot < 0) {
    slot = b.slots.findIndex((s) => s.owner.every((x) => x === 0));
    const g = await tx(`RegisterPayee page ${page} slot ${slot}`, funder, [X.registerPayee(PID, bk, payee.publicKey, slot)], [payee]);
    cuRow("RegisterPayee", g, 1, 2254);
  }
  return { book: bk, slot, page };
}

async function setupPayers(payers, depositEach) {
  const escRent = await L.rentExempt(X.ESCROW_HDR + 4 * X.PAIR_LEN);
  const chRent = await L.rentExempt(X.CHANNEL_LEN);
  const need = escRent + 3n * chRent + 10_000n;
  // Fund payers (one V1 multi-transfer), then open + deposit in groups of 10 signers.
  const transfers = [];
  for (const p of payers) {
    const bal = await L.getBalance(p.pk);
    if (bal < need) transfers.push(sysTransfer(funder.publicKey, p.publicKey, need - bal));
  }
  for (let i = 0; i < transfers.length; i += 40) await tx(`fund ${transfers.slice(i, i + 40).length} payers (V1 multi-transfer)`, funder, transfers.slice(i, i + 40));
  const opens = [];
  for (const p of payers) {
    const e = await escrowOf(p);
    if (!e) opens.push(p);
  }
  for (let i = 0; i < opens.length; i += 10) {
    const grp = opens.slice(i, i + 10);
    const ixs = grp.flatMap((p) => [X.openEscrow(PID, LEDGER, p.publicKey, 4), X.deposit(PID, LEDGER, funder.publicKey, p.publicKey, depositEach)]);
    const g = await tx(`OpenEscrow+Deposit x${grp.length}`, funder, ixs, grp);
    if (g && !g.err) {
      const per = g.ixCu.filter((x) => x.program === PROGRAM_ID).map((x) => x.cu);
      cuRows.push({ instruction: "OpenEscrow (4 pairs)", count: grp.length, cu: Math.max(...per.filter((_, j) => j % 2 === 0)), min: Math.min(...per.filter((_, j) => j % 2 === 0)), readmeClusterEstimate: 7099 });
      cuRows.push({ instruction: "Deposit (SOL)", count: grp.length, cu: Math.max(...per.filter((_, j) => j % 2 === 1)), min: Math.min(...per.filter((_, j) => j % 2 === 1)), readmeClusterEstimate: 6782 });
    }
  }
  // Top up escrows that are below the deposit target (reruns).
  const tops = [];
  for (const p of payers) {
    const e = await escrowOf(p);
    if (e && e.balance < depositEach / 2n) tops.push(X.deposit(PID, LEDGER, funder.publicKey, p.publicKey, depositEach - e.balance));
  }
  for (let i = 0; i < tops.length; i += 20) await tx(`Deposit top-up x${tops.slice(i, i + 20).length}`, funder, tops.slice(i, i + 20));
}

function sysTransfer(from, to, lamports) {
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true);
  new DataView(data.buffer).setBigUint64(4, BigInt(lamports), true);
  return { programId: X.SYSTEM_PROGRAM_ID, keys: [{ pubkey: from, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }], data };
}

// ── vouchers ────────────────────────────────────────────────────────────────

let salt;
let quoteN = 0;
/** Signed voucher from `payer` to `payee` raising the pair by `amount`, against the on-chain escrow state
 *  (plus `bump` already used in this transaction for the same pair). */
async function voucher(payer, payee, dest, amount, expiry, opts = {}) {
  const e = opts.escrow ?? (await escrowOf(payer));
  const pi = X.pairIndexFor(e, payee.publicKey);
  const base = (opts.base ?? pi.settled) + (opts.bump ?? 0n);
  const cumulative = base + amount;
  const fields = { programId: PID, mint: SOL0, salt, payer: payer.publicKey, payee: payee.publicKey, scope: opts.scope ?? e.scope, cumulative, expirySlot: expiry, quoteHash: quote(++quoteN) };
  const v = X.signVoucher(payer, fields);
  return {
    item: { escrow: X.escrowPda(PID, LEDGER, payer.publicKey)[0], pairIndex: opts.pairIndex ?? pi.index, book: dest.book, slot: dest.slot, voucher: v },
    fields: { ...fields },
    delta: cumulative - pi.settled,
    pairIndex: pi.index,
    append: pi.append,
  };
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const payers = loadWallets();
  ev.doc.payers = payers.map((p) => p.pk);
  const startBal = await L.getBalance(funder.pk);
  ev.doc.funderStart = startBal;
  const l0 = await ensureLedger();
  salt = l0.salt;
  const dA = await ensureBookSlot(0, payeeA);
  const dB = await ensureBookSlot(0, payeeB);
  ev.doc.bookSlots = { payeeA: dA.slot, payeeB: dB.slot };
  await setupPayers(payers, 3_000_000n);
  await solvency("after setup");
  const slot0 = await L.getSlot();
  const exp = slot0 + 20_000n;
  const escrowKeys = payers.map((p) => p.publicKey);

  // ── two-phase batch that will be aborted: begin + stage chunk 0 of 2 early,
  // so its 1,500-slot deadline runs while the other lanes execute.
  const abortSet = payers.slice(14, 20);
  const abortItems = [];
  for (const p of abortSet) {
    const v = await voucher(p, payeeA, dA, 1_000n, exp);
    abortItems.push({ ...v.item, fields: v.fields, delta: v.delta });
  }
  const abortId = BigInt(Date.now()) * 1000n + 7n;
  const abortPlan = X.buildTwoPhase({ programId: PID, ledger: LEDGER, submitter: funder.publicKey, batchId: abortId, items: abortItems, chunkSize: 3 });
  let g = await tx("2PC-abort: BeginBatch", funder, [abortPlan.begin]);
  cuRow("BeginBatch", g, 1, 11767);
  g = await tx("2PC-abort: StageChunk 0 of 2", funder, [abortPlan.stages[0]]);
  cuRow("StageChunk (3 vouchers)", g, 3);
  const abortHdr = X.decodeBatch(await acct(abortPlan.batch));
  ev.doc.abortBatch = { batch: L.b58encode(abortPlan.batch), deadlineSlot: abortHdr.deadlineSlot, numChunks: abortHdr.numChunks };
  // Staged pairs are locked: a direct settle of one of them must fail with PairPending.
  {
    const p = abortSet[0];
    const e = await escrowOf(p);
    const v = await voucher(p, payeeA, dA, 500n, exp, { escrow: e, base: e.pairs[abortItems[0].pairIndex].settled });
    await tx("negative: settle a pair staged in an open batch", funder, [X.settleInstruction(PID, LEDGER, [v.item])], [], ERR.PairPending);
  }
  // Abort before the deadline by someone other than the submitter fails.
  await tx("negative: AbortBatch by non-submitter before deadline", payeeB, [X.abortBatch(PID, abortPlan.batch, payeeB.publicKey)], [], ERR.BatchNotTimedOut);

  // ── channel in dispute: open, close by a non-payee (opens the window), supersede.
  const disputePayer = payers[20];
  const chId = BigInt(Date.now());
  const chExp = (await L.getSlot()) + 50_000n;
  g = await tx("C: OpenChannel (dispute case)", funder, [X.openChannel(PID, LEDGER, disputePayer.publicKey, payeeB.publicKey, chId, 500_000n, chExp)], [disputePayer]);
  cuRow("OpenChannel", g, 1, 16801);
  const [chD] = X.channelPda(PID, LEDGER, disputePayer.publicKey, payeeB.publicKey, chId);
  const chDscope = X.decodeChannel(await acct(chD)).scope;
  const cv = (payer, payee, scope, cum, e2 = chExp) =>
    X.signVoucher(payer, { programId: PID, mint: SOL0, salt, payee: payee.publicKey, scope, cumulative: cum, expirySlot: e2, quoteHash: quote(++quoteN) });
  const v1 = cv(disputePayer, payeeB, chDscope, 100_000n);
  g = await tx("C: CloseChannels by facilitator (opens dispute window)", funder, [X.closeChannelsInstruction(PID, LEDGER, [{ channel: chD, slot: 0, voucher: v1 }], [])]);
  const v2 = cv(disputePayer, payeeB, chDscope, 250_000n);
  g = await tx("C: CloseChannels with a higher voucher (supersede inside the window)", funder, [X.closeChannelsInstruction(PID, LEDGER, [{ channel: chD, slot: 0, voucher: v2 }], [])]);
  await tx("negative: CloseChannels with the older voucher (stale)", funder, [X.closeChannelsInstruction(PID, LEDGER, [{ channel: chD, slot: 0, voucher: v1 }], [])], [], ERR.StaleVoucher);
  await tx("negative: FinalizeChannel inside the dispute window", funder, [X.finalizeChannel(PID, chD, { book: dB.book, slot: dB.slot })], [], ERR.DisputeOpen);
  const chDhdr = X.decodeChannel(await acct(chD));
  ev.check("C: dispute channel is CLOSING with best voucher 250,000", chDhdr.status === X.CH_CLOSING && chDhdr.bestCumulative === 250_000n, { status: chDhdr.status, best: chDhdr.bestCumulative, disputeEnd: chDhdr.disputeEndSlot });

  // ── channel for expiry refund (short expiry).
  const expPayer = payers[21];
  const chE_id = chId + 1n;
  const chE_exp = (await L.getSlot()) + 150n;
  await tx("C: OpenChannel (expiry case, 150-slot expiry)", funder, [X.openChannel(PID, LEDGER, expPayer.publicKey, payeeB.publicKey, chE_id, 400_000n, chE_exp)], [expPayer]);
  const [chE] = X.channelPda(PID, LEDGER, expPayer.publicKey, payeeB.publicKey, chE_id);

  // ── channel closed on the payer's request, answered by the payee.
  const reqPayer = payers[22];
  const chR_id = chId + 2n;
  await tx("C: OpenChannel (payer close request case)", funder, [X.openChannel(PID, LEDGER, reqPayer.publicKey, payeeB.publicKey, chR_id, 300_000n, chExp)], [reqPayer]);
  const [chR] = X.channelPda(PID, LEDGER, reqPayer.publicKey, payeeB.publicKey, chR_id);
  await tx("C: RequestChannelClose (payer)", funder, [X.requestChannelClose(PID, LEDGER, reqPayer.publicKey, chR)], [reqPayer]);
  const chRscope = X.decodeChannel(await acct(chR)).scope;
  const vR = cv(reqPayer, payeeB, chRscope, 120_000n);
  g = await tx("C: payee answers the close request with its voucher (signs, final at once)", payeeB, [X.closeChannelsInstruction(PID, LEDGER, [{ channel: chR, book: dB.book, slot: dB.slot, voucher: vR }], [payeeB.publicKey])]);
  const chRhdr = X.decodeChannel(await acct(chR));
  ev.check("C: request-close channel CLOSED, payee credited 120,000", chRhdr.status === X.CH_CLOSED && chRhdr.balance === 180_000n, { status: chRhdr.status, balance: chRhdr.balance });
  g = await tx("C: ReclaimChannel (closed channel, rest to escrow, rent to payer)", funder, [X.reclaimChannel(PID, LEDGER, chR, reqPayer.publicKey)]);
  cuRow("ReclaimChannel", g, 1, 4564);

  // ── lane B2: single voucher, two vouchers, then max per V1 transaction.
  const bookA0 = (await book(0)).slots[dA.slot].balance;
  {
    const v = await voucher(payers[25 % payers.length], payeeA, dA, 1_234n, exp);
    g = await tx("B2: Settle 1 voucher", funder, [X.settleInstruction(PID, LEDGER, [v.item])]);
    cuRow("Settle, 1 voucher", g, 1, 15404);
    const a = await voucher(payers[23], payeeB, dB, 1_000n, exp);
    const b = await voucher(payers[24], payeeB, dB, 1_000n, exp);
    g = await tx("B2: Settle 2 vouchers (distinct payers)", funder, [X.settleInstruction(PID, LEDGER, [a.item, b.item])]);
    cuRow("Settle, 2 vouchers", g, 2, 15404 + 11198);
  }
  // Max distinct payers: payers 0..24 -> payeeA (fresh pair each).
  const distinct = [];
  for (let i = 0; i < 25; i++) {
    if (i >= 14 && i < 20) continue; // pairs locked by the open abort batch
    distinct.push((await voucher(payers[i], payeeA, dA, 2_000n + BigInt(i), exp)).item);
  }
  // Fill up to 25 with payeeB pairs of the locked payers (distinct escrows, other pair).
  for (let i = 14; i < 20 && distinct.length < 25; i++) distinct.push((await voucher(payers[i], payeeB, dB, 2_000n, exp)).item);
  let packs = X.packSettle(PID, LEDGER, funder.publicKey, distinct);
  ev.check("B2: 25 distinct-payer vouchers fit one V1 transaction", packs.length === 1, { txs: packs.length, size: X.v1Size(funder.publicKey, [packs[0]]) });
  for (const [i, p] of packs.entries()) {
    g = await tx(`B2: Settle ${distinct.length} vouchers, distinct payers (pack ${i})`, funder, [p]);
    cuRow(`Settle, ${distinct.length} vouchers, distinct payers`, g, distinct.length, 284140);
  }
  // Max one escrow: payer 0 -> payeeA rising cumulative, 32 vouchers.
  {
    const p = payers[0];
    const e = await escrowOf(p);
    const items = [];
    for (let i = 0; i < 32; i++) items.push((await voucher(p, payeeA, dA, 10n, exp, { escrow: e, bump: 10n * BigInt(i) })).item);
    packs = X.packSettle(PID, LEDGER, funder.publicKey, items);
    ev.check("B2: 32 one-escrow vouchers fit one V1 transaction", packs.length === 1, { txs: packs.length, size: X.v1Size(funder.publicKey, [packs[0]]) });
    for (const [i, pk] of packs.entries()) {
      g = await tx(`B2: Settle 32 vouchers, one escrow (pack ${i})`, funder, [pk]);
      cuRow("Settle, 32 vouchers, one escrow", g, 32, 302987);
    }
  }
  // Negatives: tampered voucher, replay, duplicate pair.
  {
    const p = payers[1];
    const v = await voucher(p, payeeA, dA, 777n, exp);
    const bad = { ...v.item, voucher: { ...v.item.voucher, cumulative: v.item.voucher.cumulative + 1n } };
    await tx("negative: tampered voucher (amount raised after signing)", funder, [X.settleInstruction(PID, LEDGER, [bad])], [], ERR.BadSignature);
    const sigBad = Uint8Array.from(v.item.voucher.signature);
    sigBad[5] ^= 1;
    await tx("negative: tampered voucher (signature bit flip)", funder, [X.settleInstruction(PID, LEDGER, [{ ...v.item, voucher: { ...v.item.voucher, signature: sigBad } }])], [], ERR.BadSignature);
    g = await tx("B2: settle the untampered voucher", funder, [X.settleInstruction(PID, LEDGER, [v.item])]);
    await tx("negative: replay of the settled voucher", funder, [X.settleInstruction(PID, LEDGER, [v.item])], [], ERR.StaleVoucher);
    const e = await escrowOf(p);
    const dup = await voucher(p, payeeA, dA, 5n, exp, { escrow: e, pairIndex: e.pairCount, base: 0n });
    await tx("negative: duplicate pair (second entry for an existing payee)", funder, [X.settleInstruction(PID, LEDGER, [dup.item])], [], ERR.DuplicatePair);
    const exp2 = (await L.getSlot()) - 1n;
    const old = await voucher(p, payeeA, dA, 5n, exp2);
    await tx("negative: expired voucher", funder, [X.settleInstruction(PID, LEDGER, [old.item])], [], ERR.VoucherExpired);
    const wrongScope = await voucher(p, payeeA, dA, 5n, exp, { scope: e.scope + 1n });
    await tx("negative: voucher for another scope", funder, [X.settleInstruction(PID, LEDGER, [wrongScope.item])], [], ERR.BadSignature);
  }
  const bookA1 = (await book(0)).slots[dA.slot].balance;
  ev.check("B2: payee A book balance rose", bookA1 > bookA0, { before: bookA0, after: bookA1 });

  // ── lane C: max channel closes per V1 transaction (payee signs).
  {
    const chans = [];
    const base = BigInt(Date.now()) * 10n;
    const opens = [];
    for (let i = 0; i < 25; i++) opens.push(X.openChannel(PID, LEDGER, payers[i].publicKey, payeeA.publicKey, base + BigInt(i), 20_000n, chExp));
    for (let i = 0; i < 25; i += 10) await tx(`C: OpenChannel x${opens.slice(i, i + 10).length}`, funder, opens.slice(i, i + 10), payers.slice(i, i + 10));
    for (let i = 0; i < 25; i++) {
      const [c] = X.channelPda(PID, LEDGER, payers[i].publicKey, payeeA.publicKey, base + BigInt(i));
      const sc = X.decodeChannel(await acct(c)).scope;
      chans.push({ channel: c, book: dA.book, slot: dA.slot, voucher: cv(payers[i], payeeA, sc, 5_000n + BigInt(i)) });
    }
    const cpacks = X.packCloseChannels(PID, LEDGER, payeeA.publicKey, chans);
    ev.check("C: 25 payee-signed closes fit one V1 transaction", cpacks.length === 1, { txs: cpacks.length, size: X.v1Size(payeeA.publicKey, [cpacks[0]]) });
    for (const [i, p] of cpacks.entries()) {
      g = await tx(`C: CloseChannels x${chans.length} (payee signs, pack ${i})`, payeeA, [p]);
      cuRow(`CloseChannels, ${chans.length} channels`, g, chans.length, 280961);
    }
    // Reclaim all closed channels (rest to escrow, rent to payer).
    const recl = chans.map((c, i) => X.reclaimChannel(PID, LEDGER, c.channel, payers[i].publicKey));
    for (let i = 0; i < recl.length; i += 12) await tx(`C: ReclaimChannel x${recl.slice(i, i + 12).length}`, funder, recl.slice(i, i + 12));
  }

  // ── two-phase batch with commit across 3 StageChunk transactions.
  {
    const set = payers.slice(0, 14);
    const items = [];
    for (const p of set) {
      const v = await voucher(p, payeeB, dB, 3_000n, exp);
      items.push({ ...v.item, fields: v.fields, delta: v.delta });
    }
    const bid = BigInt(Date.now()) * 1000n + 11n;
    const plan = X.buildTwoPhase({ programId: PID, ledger: LEDGER, submitter: funder.publicKey, batchId: bid, items, chunkSize: 5 });
    ev.check("2PC-commit: plan has 3 chunks", plan.stages.length === 3, { chunks: plan.stages.length, chunkSize: plan.chunkSize, count: plan.count, total: plan.total });
    const bookB0 = (await book(0)).slots[dB.slot].balance;
    await tx("2PC-commit: BeginBatch", funder, [plan.begin]);
    await tx("negative: CommitBatch before every chunk is staged", funder, [plan.commit], [], ERR.BatchIncomplete);
    for (const [i, s] of plan.stages.entries()) {
      g = await tx(`2PC-commit: StageChunk ${i}`, funder, [s]);
      cuRow(`StageChunk (${Math.min(plan.chunkSize, items.length - i * plan.chunkSize)} vouchers)`, g, Math.min(plan.chunkSize, items.length - i * plan.chunkSize));
    }
    await tx("negative: StageChunk 0 again", funder, [plan.stages[0]], [], ERR.ChunkAlreadyStaged);
    g = await tx("2PC-commit: CommitBatch", funder, [plan.commit]);
    cuRow("CommitBatch, 1 payee slot", g, 1, 4515);
    const bookB1 = (await book(0)).slots[dB.slot].balance;
    ev.check("2PC-commit: payee B credited exactly the batch total", bookB1 - bookB0 === plan.total, { credited: bookB1 - bookB0, total: plan.total });
    for (const [i, r] of plan.resolves.entries()) {
      g = await tx(`2PC-commit: ResolveStaged ${i}`, funder, [r]);
      cuRow(`ResolveStaged, ${items.length} pairs`, g, items.length, 51062);
    }
    g = await tx("2PC-commit: CloseBatch", funder, [plan.close]);
    cuRow("CloseBatch", g, 1, 2474);
    for (const it of items.slice(0, 3)) {
      const e = X.decodeEscrow(await acct(it.escrow));
      ev.check("2PC-commit: pair settled advanced, no pending", e.pairs[it.pairIndex].settled === it.fields.cumulative && e.pairs[it.pairIndex].pendingBatch === 0n, { settled: e.pairs[it.pairIndex].settled });
    }
  }

  // ── fan-out: client V1 multi-transfer, 60 TransferChecked in one transaction.
  await fanOut();

  // ── payee withdraws (SOL).
  {
    const b = await book(0);
    const bal = b.slots[dA.slot].balance;
    const before = await L.getBalance(payeeA.pk);
    g = await tx("WithdrawPayee (SOL), payee A", payeeA, [X.withdrawPayee(PID, LEDGER, dA.book, payeeA.publicKey, dA.slot, bal, payeeA.publicKey)]);
    cuRow("WithdrawPayee (SOL)", g, 1, 4961);
    const after = await L.getBalance(payeeA.pk);
    ev.check("WithdrawPayee: payee A received its book balance (minus its fee)", after - before === bal - BigInt(g?.fee ?? 0), { bal, delta: after - before, fee: g?.fee });
  }

  // ── wait out the expiry, dispute window and batch deadline.
  const chEhdr = X.decodeChannel(await acct(chE));
  await L.waitSlot(chEhdr.expirySlot, "channel expiry");
  {
    const e0 = (await escrowOf(expPayer)).balance;
    g = await tx("C: ReclaimChannel after expiry (full refund)", funder, [X.reclaimChannel(PID, LEDGER, chE, expPayer.publicKey)]);
    const e1 = (await escrowOf(expPayer)).balance;
    ev.check("C: expiry refund returned the full deposit to the escrow", e1 - e0 === 400_000n, { refunded: e1 - e0 });
  }
  const dHdr = X.decodeChannel(await acct(chD));
  await L.waitSlot(dHdr.disputeEndSlot + 1n, "dispute window");
  {
    const b0 = (await book(0)).slots[dB.slot].balance;
    g = await tx("C: FinalizeChannel after the dispute window", funder, [X.finalizeChannel(PID, chD, { book: dB.book, slot: dB.slot })]);
    cuRow("FinalizeChannel", g, 1);
    const b1 = (await book(0)).slots[dB.slot].balance;
    ev.check("C: dispute finalized with the superseding voucher (250,000)", b1 - b0 === 250_000n, { credited: b1 - b0 });
    await tx("C: ReclaimChannel (finalized channel)", funder, [X.reclaimChannel(PID, LEDGER, chD, disputePayer.publicKey)]);
  }
  await L.waitSlot(abortHdr.deadlineSlot + 1n, "abort batch deadline");
  {
    await tx("negative: StageChunk after the batch deadline", funder, [abortPlan.stages[1]], [], ERR.BatchDeadline);
    const before = [];
    for (const it of abortItems) before.push(X.decodeEscrow(await acct(it.escrow)).balance);
    g = await tx("2PC-abort: AbortBatch by a non-submitter after the deadline", payeeB, [X.abortBatch(PID, abortPlan.batch, payeeB.publicKey)]);
    cuRow("AbortBatch", g, 1);
    const staged = abortItems.slice(0, abortPlan.chunkSize);
    const resolve = X.resolveStaged(PID, abortPlan.batch, staged.map((it) => it.escrow), staged.map((it, i) => [1 + i, it.pairIndex]));
    g = await tx("2PC-abort: ResolveStaged (returns reservations)", funder, [resolve]);
    cuRow(`ResolveStaged, ${staged.length} pairs (after abort)`, g, staged.length);
    let ok = true;
    for (const [i, it] of abortItems.entries()) {
      const e = X.decodeEscrow(await acct(it.escrow));
      const want = before[i] + (i < staged.length ? it.delta : 0n);
      if (e.balance !== want || e.pairs[it.pairIndex].pendingBatch !== 0n) ok = false;
    }
    ev.check("2PC-abort: every staged reservation returned, pairs unlocked", ok);
    await tx("2PC-abort: CloseBatch", funder, [abortPlan.close]);
  }

  await solvency("end of main phase");

  // Start the exit timer for every payer so PHASE=cleanup can withdraw after 9,000 slots.
  const exits = [];
  for (const p of payers) {
    const e = await escrowOf(p);
    if (e && e.balance > 0n && e.exitAmount === 0n) exits.push([p, e.balance]);
  }
  for (let i = 0; i < exits.length; i += 10) {
    const grp = exits.slice(i, i + 10);
    g = await tx(`RequestExit x${grp.length}`, funder, grp.map(([p, b]) => X.requestExit(PID, LEDGER, p.publicKey, b)), grp.map(([p]) => p));
  }
  ev.doc.exitReadySlot = (await escrowOf(payers[0]))?.exitReadySlot;
  ev.doc.funderEnd = await L.getBalance(funder.pk);
  ev.doc.funderSpent = startBal - ev.doc.funderEnd;
}

// ── fan-out helpers (SPL Token, accounts at seed-derived addresses so reruns reuse them)

const TOKEN = X.TOKEN_PROGRAM_ID;
function seedAddress(base, seed, owner) {
  return Uint8Array.from(createHash("sha256").update(Buffer.concat([Buffer.from(base), Buffer.from(seed), Buffer.from(owner)])).digest());
}
function createWithSeed(from, to, seed, lamports, space, owner) {
  const s = Buffer.from(seed);
  const data = Buffer.alloc(4 + 32 + 8 + s.length + 8 + 8 + 32);
  let o = 0;
  data.writeUInt32LE(3, o); o += 4;
  Buffer.from(from).copy(data, o); o += 32;
  data.writeBigUInt64LE(BigInt(s.length), o); o += 8;
  s.copy(data, o); o += s.length;
  data.writeBigUInt64LE(BigInt(lamports), o); o += 8;
  data.writeBigUInt64LE(BigInt(space), o); o += 8;
  Buffer.from(owner).copy(data, o);
  return { programId: X.SYSTEM_PROGRAM_ID, keys: [{ pubkey: from, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }], data: Uint8Array.from(data) };
}
const tokIx = (keys, data) => ({ programId: TOKEN, keys, data: Uint8Array.from(data) });
const w = (k, s = false) => ({ pubkey: k, isSigner: s, isWritable: true });
const r = (k, s = false) => ({ pubkey: k, isSigner: s, isWritable: false });

async function fanOut() {
  const N = 60;
  const mint = seedAddress(funder.publicKey, "x4fan-mint", TOKEN);
  const src = seedAddress(funder.publicKey, "x4fan-src", TOKEN);
  const dests = Array.from({ length: N }, (_, i) => seedAddress(funder.publicKey, `x4fan-${i}`, TOKEN));
  const mintRent = await L.rentExempt(82);
  const accRent = await L.rentExempt(165);
  const setup = [];
  if (!(await L.getAccount(mint))) {
    setup.push(createWithSeed(funder.publicKey, mint, "x4fan-mint", mintRent, 82, TOKEN));
    setup.push(tokIx([w(mint)], [20, 6, ...funder.publicKey, 0]));
  }
  if (!(await L.getAccount(src))) {
    setup.push(createWithSeed(funder.publicKey, src, "x4fan-src", accRent, 165, TOKEN));
    setup.push(tokIx([w(src), r(mint)], [18, ...funder.publicKey]));
  }
  if (setup.length) await tx("fan-out setup: mint + source account", funder, setup);
  const mk = [];
  for (const [i, d] of dests.entries()) {
    if (!(await L.getAccount(d))) mk.push(createWithSeed(funder.publicKey, d, `x4fan-${i}`, accRent, 165, TOKEN), tokIx([w(d), r(mint)], [18, ...payeeA.publicKey]));
  }
  for (let i = 0; i < mk.length; i += 30) await tx(`fan-out setup: ${mk.slice(i, i + 30).length / 2} destination token accounts`, funder, mk.slice(i, i + 30));
  const amt = new Uint8Array(9);
  amt[0] = 7;
  new DataView(amt.buffer).setBigUint64(1, BigInt(N) * 1_000n, true);
  await tx("fan-out setup: MintTo source", funder, [tokIx([w(mint), w(src), r(funder.publicKey, true)], amt)]);
  const txs = X.packFanOut(funder.publicKey, TOKEN, mint, src, 6, dests.map((d) => ({ destination: d, amount: 1_000n })));
  ev.check("fan-out: 60 TransferChecked fit one V1 transaction", txs.length === 1, { txs: txs.length, size: X.v1Size(funder.publicKey, txs[0]) });
  for (const [i, ixs] of txs.entries()) {
    const g = await tx(`fan-out: V1 multi-transfer, ${ixs.length} TransferChecked (tx ${i})`, funder, ixs);
    if (g && !g.err) cuRows.push({ instruction: `Fan-out V1 multi-transfer (${ixs.length} TransferChecked)`, count: ixs.length, cu: g.cu, fee: g.fee, perPaymentFee: g.fee / ixs.length, signature: g.signature });
  }
  let ok = true;
  for (const d of dests) {
    const a = await L.getAccount(d);
    const bal = new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true);
    if (bal < 1_000n) ok = false;
  }
  ev.check("fan-out: every destination holds its transfer", ok);
  // Cleanup: send the tokens back and close the 60 accounts (rent back to the funder).
  const back = [];
  for (const d of dests) {
    const a = await L.getAccount(d);
    const bal = new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true);
    if (bal > 0n) back.push(X.transferChecked(TOKEN, d, mint, src, payeeA.publicKey, bal, 6));
    back.push(tokIx([w(d), w(funder.publicKey), r(payeeA.publicKey, true)], [9]));
  }
  for (let i = 0; i < back.length; i += 40) await tx(`fan-out cleanup: return + close ${back.slice(i, i + 40).length / 2} accounts`, funder, back.slice(i, i + 40), [payeeA]);
}

// ── cleanup phase: withdraw escrows after the exit delay, close them, return SOL.

async function cleanup() {
  const payers = loadWallets();
  const l = await ledger();
  salt = l.salt;
  const now = await L.getSlot();
  let g;
  for (const p of payers) {
    const e = await escrowOf(p);
    if (!e) continue;
    if (e.exitAmount > 0n && now >= e.exitReadySlot) {
      g = await tx(`WithdrawEscrow ${p.pk.slice(0, 6)}`, funder, [X.withdrawEscrow(PID, LEDGER, p.publicKey, p.publicKey)], [p]);
      cuRow("WithdrawEscrow (SOL)", g, 1, 5159);
    } else if (e.exitAmount > 0n) {
      ev.check(`exit not ready for ${p.pk.slice(0, 6)} (ready at ${e.exitReadySlot}, now ${now})`, false);
      continue;
    }
    const e2 = await escrowOf(p);
    if (e2 && e2.balance === 0n && e2.pendingCount === 0 && e2.openChannels === 0) {
      g = await tx(`CloseEscrow ${p.pk.slice(0, 6)}`, funder, [X.closeEscrow(PID, LEDGER, p.publicKey)], [p]);
    }
    const bal = await L.getBalance(p.pk);
    if (bal > 0n) await tx(`return SOL from ${p.pk.slice(0, 6)}`, p, [sysTransfer(p.publicKey, funder.publicKey, bal - 5_000n)]);
  }
  const b = await book(0);
  for (const pe of [payeeA, payeeB]) {
    const slot = b.slots.findIndex((s) => L.b58encode(s.owner) === pe.pk);
    if (slot >= 0 && b.slots[slot].balance > 0n) await tx(`WithdrawPayee ${pe.pk.slice(0, 6)}`, pe, [X.withdrawPayee(PID, LEDGER, X.bookPda(PID, LEDGER, 0)[0], pe.publicKey, slot, b.slots[slot].balance, pe.publicKey)]);
  }
}

try {
  if (L.AIRDROP && (await L.getBalance(funder.pk)) < 50_000_000_000n) await L.airdrop(funder.pk, 100_000_000_000n);
  for (const pe of [payeeA, payeeB]) {
    if ((await L.getBalance(pe.pk)) < 20_000_000n) {
      if (L.AIRDROP) await L.airdrop(pe.pk, 1_000_000_000n);
      else await L.fund(funder, pe.pk, 20_000_000n);
    }
  }
  if (PHASE === "cleanup") await cleanup();
  else await main();
} catch (e) {
  ev.check("script completed without exception", false, { error: String(e.stack ?? e).slice(0, 1500) });
}
ev.doc.cu = cuRows;
console.table(cuRows.map((r) => ({ instruction: r.instruction, n: r.count, cu: r.cu, perItem: r.perItem, readme: r.readmeClusterEstimate, fee: r.fee })));
ev.save(PHASE === "cleanup" ? "x402-settle-cleanup.json" : "x402-settle.json");
process.exit(ev.failures ? 1 : 0);
