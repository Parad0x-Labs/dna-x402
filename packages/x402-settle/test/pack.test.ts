// Packing limits must match the Rust capacity test (tests/cu.rs): 25 B2
// vouchers from distinct payers, 32 from one escrow, 25 channel closes, 24
// staged vouchers at proof depth 3 (25 at depth 1), 60 fan-out transfers per
// V1 tx.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTwoPhase,
  createB2FlushSink,
  ESCROW_HDR,
  escrowPda,
  fitsV1,
  keypairFromSeed,
  latestPerPair,
  packCloseChannels,
  packFanOut,
  packSettle,
  PAIR_LEN,
  sha256,
  signVoucher,
  toNettingVoucher,
  TOKEN_PROGRAM_ID,
  u64le,
  v1Size,
  voucherMessage,
  type BatchItem,
  type CloseItem,
  type SettleItem,
} from "../src/index.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const k = (tag: string, i: number) => sha256(enc(tag), u64le(BigInt(i)));
const pid = k("program", 0);
const ledger = k("ledger", 0);
const book = k("book", 0);
const fee = keypairFromSeed(k("fee", 0)).publicKey;
const sig = new Uint8Array(64).fill(9);
const voucher = (c: number) => ({ cumulative: BigInt(c), expirySlot: 1_000n, quoteHash: k("q", c), signature: sig });

test("B2: 25 distinct payers or 32 vouchers of one escrow per V1 transaction", () => {
  const distinct: SettleItem[] = Array.from({ length: 60 }, (_, i) => ({ escrow: k("escrow", i), pairIndex: 0, book, slot: 0, voucher: voucher(i + 1) }));
  const ixs = packSettle(pid, ledger, fee, distinct);
  assert.deepEqual(ixs.map((i) => i.data[1]), [25, 25, 10]);
  for (const i of ixs) assert.ok(fitsV1(v1Size(fee, [i])));
  const same: SettleItem[] = Array.from({ length: 40 }, (_, i) => ({ escrow: k("escrow", 0), pairIndex: 0, book, slot: 0, voucher: voucher(i + 1) }));
  assert.deepEqual(packSettle(pid, ledger, fee, same).map((i) => i.data[1]), [32, 8]);
  // Only the latest voucher per pair is needed.
  const latest = latestPerPair(same);
  assert.equal(latest.length, 1);
  assert.equal(latest[0]!.voucher.cumulative, 40n);
});

test("C: 25 payee-signed closes per V1 transaction", () => {
  const payee = keypairFromSeed(k("payee", 0)).publicKey;
  const items: CloseItem[] = Array.from({ length: 30 }, (_, i) => ({ channel: k("channel", i), book, slot: 0, voucher: voucher(i + 1) }));
  const ixs = packCloseChannels(pid, ledger, payee, items);
  assert.deepEqual(ixs.map((i) => i.data[1]), [25, 5]);
});

test("fan-out: 60 TransferChecked per V1 transaction", () => {
  const owner = keypairFromSeed(k("owner", 0)).publicKey;
  const txs = packFanOut(owner, TOKEN_PROGRAM_ID, k("mint", 0), k("src", 0), 6, Array.from({ length: 100 }, (_, i) => ({ destination: k("dst", i), amount: 1n })));
  assert.deepEqual(txs.map((t) => t.length), [60, 40]);
});

test("two-phase: chunk size, stages fit, root and totals", () => {
  const payers = Array.from({ length: 40 }, (_, i) => keypairFromSeed(k("payer", i)));
  const payee = keypairFromSeed(k("payee", 0)).publicKey;
  const salt = k("salt", 0);
  const items: BatchItem[] = payers.map((p, i) => {
    const sv = signVoucher(p, { programId: pid, mint: new Uint8Array(32), salt, payee, scope: BigInt(i + 1), cumulative: BigInt(100 + i), expirySlot: 5_000n, quoteHash: k("quote", i) });
    const [escrow] = escrowPda(pid, ledger, p.publicKey);
    return { escrow, pairIndex: 0, book, slot: 0, voucher: sv, fields: sv, delta: sv.cumulative };
  });
  const plan = buildTwoPhase({ programId: pid, ledger, submitter: fee, batchId: 7n, items });
  assert.equal(plan.chunkSize, 25);
  assert.equal(plan.chunkLog, 5);
  assert.equal(plan.stages.length, 2);
  assert.equal(plan.total, items.reduce((s, it) => s + it.delta, 0n));
  for (const s of plan.stages) assert.ok(fitsV1(v1Size(fee, [s])));
  assert.equal(plan.resolves.length, 2);
  assert.throws(() => buildTwoPhase({ programId: pid, ledger, submitter: fee, batchId: 8n, items: [items[0]!, items[0]!] }), /one voucher per escrow pair/);
  // The leaf binds the signed message.
  assert.equal(voucherMessage(items[0]!.fields).length, 224);
});

function escrowBytes(payer: Uint8Array, scope: bigint, pairs: { payee: Uint8Array; settled: bigint }[], capacity = 4): Uint8Array {
  const d = new Uint8Array(ESCROW_HDR + capacity * PAIR_LEN);
  d.set(enc("x4sESCRW"), 0);
  d[10] = capacity;
  d[11] = pairs.length;
  d.set(ledger, 16);
  d.set(payer, 48);
  d.set(u64le(scope), 80);
  d.set(u64le(1_000_000n), 88);
  pairs.forEach((p, i) => {
    d.set(p.payee, ESCROW_HDR + i * PAIR_LEN);
    d.set(u64le(p.settled), ESCROW_HDR + i * PAIR_LEN + 32);
  });
  return d;
}

test("netting flush sink: pair indexes, appends, settled skip, one tx per pack", async () => {
  const payer = keypairFromSeed(k("payer", 1));
  const payees = [0, 1, 2].map((i) => keypairFromSeed(k("payee", i)).publicKey);
  const [escrow] = escrowPda(pid, ledger, payer.publicKey);
  const data = escrowBytes(payer.publicKey, 3n, [{ payee: payees[0]!, settled: 500n }]);
  const sent: Uint8Array[] = [];
  const sink = createB2FlushSink({
    programId: pid,
    ledger,
    feePayer: keypairFromSeed(k("fee", 0)),
    getAccountData: async (key) => (Buffer.compare(Buffer.from(key), Buffer.from(escrow)) === 0 ? data : null),
    getLatestBlockhash: async () => k("bh", 0),
    sendTransaction: async (tx) => {
      sent.push(tx);
      return `sig${sent.length}`;
    },
    payeeSlot: async (p) => ({ book, slot: payees.findIndex((x) => Buffer.compare(Buffer.from(x), Buffer.from(p)) === 0) }),
  });
  const mk = (payee: Uint8Array, cum: bigint) =>
    toNettingVoucher(signVoucher(payer, { programId: pid, mint: new Uint8Array(32), salt: k("salt", 0), payee, scope: 3n, cumulative: cum, expirySlot: 9n, quoteHash: k("q", Number(cum)) }));
  const vs = [mk(payees[0]!, 400n), mk(payees[0]!, 900n), mk(payees[1]!, 10n), mk(payees[2]!, 20n), mk(payees[1]!, 30n)];
  const items = await sink.plan(vs);
  // payee 0: 400 is below settled 500 (skipped), 900 kept; payee 1 appends
  // at index 1 (latest 30); payee 2 appends at index 2.
  assert.deepEqual(items.map((i) => [i.pairIndex, i.slot, i.voucher.cumulative]), [[0, 0, 900n], [1, 1, 30n], [2, 2, 20n]]);
  const r = await sink.submit(vs);
  assert.deepEqual(r.signatures, ["sig1"]);
  assert.equal(sent[0]![0], 129);
  await assert.rejects(sink.submit([{ ...mk(payees[0]!, 1_000n), scope: "4" }]), /scope/);
});
