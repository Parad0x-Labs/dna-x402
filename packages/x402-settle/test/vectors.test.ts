// Recompute programs/x402_settle/tests/vectors/x402_settle_v1.json (written by
// the Rust test tests/vectors.rs) and compare byte for byte.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  b58decode,
  b58encode,
  batchLeaf,
  batchPda,
  batchTree,
  bookPda,
  buildV1Transaction,
  channelPda,
  compileMessage,
  decodeBatch,
  decodeChannel,
  decodeLedger,
  encodeWireClose,
  encodeWireVoucher,
  escrowPda,
  foldProof,
  fromHex,
  keypairFromSeed,
  ledgerPda,
  ledgerSalt,
  sha256,
  SOL_MINT,
  toHex,
  TOKEN_PROGRAM_ID,
  u64le,
  v1Size,
  vaultPda,
  verifyEd25519,
  voucherMessage,
  zeroRoot,
  KIND_TOKEN,
  ERROR_BASE,
  type Instruction,
} from "../src/index.ts";
import * as ix from "../src/instructions.ts";

const V = JSON.parse(readFileSync(new URL("../../../programs/x402_settle/tests/vectors/x402_settle_v1.json", import.meta.url), "utf8"));

const enc = (s: string) => new TextEncoder().encode(s);
const h32 = (tag: string, i: bigint | number) => sha256(enc(tag), u64le(BigInt(i)));
const pid = b58decode(V.program_id);
const payer = keypairFromSeed(fromHex(V.keys.payer.seed));
const payee = keypairFromSeed(fromHex(V.keys.payee.seed));
const feePayer = keypairFromSeed(fromHex(V.keys.fee_payer.seed));
const mint = b58decode(V.mint);
const salt = fromHex(V.salt);

test("keys from seeds", () => {
  assert.equal(b58encode(payer.publicKey), V.keys.payer.pubkey);
  assert.equal(b58encode(payee.publicKey), V.keys.payee.pubkey);
  assert.equal(b58encode(feePayer.publicKey), V.keys.fee_payer.pubkey);
  assert.equal(toHex(h32("mint", 1)), toHex(mint));
  assert.equal(V.constants.error_base, ERROR_BASE);
});

test("cluster salt", () => {
  for (const c of V.salt_cases) {
    const s = ledgerSalt(fromHex(c.program_id), fromHex(c.mint), BigInt(c.slot), fromHex(c.slot_hash));
    assert.equal(toHex(s), c.salt);
  }
});

test("voucher message, signature, wire, leaf", () => {
  for (const c of V.vouchers) {
    const fields = {
      programId: pid,
      mint,
      salt,
      payer: payer.publicKey,
      payee: payee.publicKey,
      scope: BigInt(c.scope),
      cumulative: BigInt(c.cumulative),
      expirySlot: BigInt(c.expiry_slot),
      quoteHash: fromHex(c.quote_hash),
    };
    const msg = voucherMessage(fields);
    assert.equal(toHex(msg), c.message);
    const sig = payer.sign(msg);
    assert.equal(toHex(sig), c.signature);
    assert.ok(verifyEd25519(payer.publicKey, msg, sig));
    const w = c.wire;
    const v = { cumulative: fields.cumulative, expirySlot: fields.expirySlot, quoteHash: fields.quoteHash, signature: sig };
    assert.equal(toHex(encodeWireVoucher({ escrowIx: w.escrow_ix, pairIx: w.pair_ix, bookIx: w.book_ix, slot: w.slot }, v)), w.hex);
    const cw = c.close_wire;
    assert.equal(toHex(encodeWireClose({ channelIx: cw.channel_ix, bookIx: cw.book_ix, slot: cw.slot }, v)), cw.hex);
    assert.equal(toHex(batchLeaf(BigInt(c.delta), msg)), c.leaf);
  }
});

test("batch tree: zeros, chunk roots, root, proofs", () => {
  const m = V.merkle;
  m.zeros.forEach((z: string, h: number) => assert.equal(toHex(zeroRoot(h)), z));
  const leaves = m.leaves.map(fromHex);
  const t = batchTree(leaves, m.chunk_log, m.chunk_size);
  assert.deepEqual(t.chunkRoots.map(toHex), m.chunk_roots);
  assert.equal(t.depth, m.depth);
  assert.equal(toHex(t.root), m.root);
  t.chunkRoots.forEach((r, c) => {
    assert.deepEqual(t.proof(c).map(toHex), m.proofs[c]);
    assert.equal(toHex(foldProof(r, c, t.proof(c))), m.root);
  });
});

const [ledgerSol, b0] = ledgerPda(pid, SOL_MINT);
const [ledger, b1] = ledgerPda(pid, mint);
const [vault, b2] = vaultPda(pid, ledger);
const [escrow, b3] = escrowPda(pid, ledger, payer.publicKey);
const [book, b4] = bookPda(pid, ledger, 3);
const [channel, b5] = channelPda(pid, ledger, payer.publicKey, payee.publicKey, 5n);
const [batch, b6] = batchPda(pid, ledger, 9n);

test("PDAs", () => {
  const p = V.pdas;
  const chk = (got: [Uint8Array, number], want: { address: string; bump: number }) => {
    assert.equal(b58encode(got[0]), want.address);
    assert.equal(got[1], want.bump);
  };
  chk([ledgerSol, b0], p.ledger_sol);
  chk([ledger, b1], p.ledger);
  chk([vault, b2], p.vault);
  chk([escrow, b3], p.escrow);
  chk([book, b4], p.book_3);
  chk([channel, b5], p.channel_5);
  chk([batch, b6], p.batch_9);
});

test("instruction data and accounts", () => {
  const w0 = V.vouchers[0];
  const wire0 = fromHex(w0.wire.hex);
  const close0 = fromHex(w0.close_wire.hex);
  const spl = { vault, mint, tokenProgram: TOKEN_PROGRAM_ID };
  const root = fromHex(V.merkle.root);
  const cr0 = fromHex(V.merkle.chunk_roots[0]);
  const P = payer.publicKey;
  const Q = payee.publicKey;
  const F = feePayer.publicKey;
  const built: Record<string, Instruction> = {
    init_ledger_sol: ix.initLedgerSol(pid, F),
    init_ledger_spl: ix.initLedgerSpl(pid, F, mint, TOKEN_PROGRAM_ID, KIND_TOKEN),
    open_escrow: ix.openEscrow(pid, ledger, P, 8),
    grow_escrow: ix.growEscrow(pid, ledger, P, 9),
    deposit_sol: ix.deposit(pid, ledgerSol, P, P, 123_456n),
    deposit_spl: ix.deposit(pid, ledger, P, P, 123_456n, { source: h32("src", 0), ...spl }),
    request_exit: ix.requestExit(pid, ledger, P, 77n),
    withdraw_escrow: ix.withdrawEscrow(pid, ledger, P, P, spl),
    close_escrow: ix.closeEscrow(pid, ledger, P),
    create_book: ix.createBook(pid, ledger, F, 3),
    register_payee: ix.registerPayee(pid, book, Q, 4),
    withdraw_payee: ix.withdrawPayee(pid, ledger, book, Q, 4, 999n, Q),
    settle: ix.settle(pid, ledger, [escrow, book], [wire0]),
    open_channel: ix.openChannel(pid, ledger, P, Q, 5n, 50_000n, 400_100_000n),
    close_channels: ix.closeChannels(pid, ledger, [channel, book], [Q], [close0]),
    request_channel_close: ix.requestChannelClose(pid, ledger, P, channel),
    finalize_channel: ix.finalizeChannel(pid, channel, { book, slot: 4 }, Q),
    reclaim_channel: ix.reclaimChannel(pid, ledger, channel, P),
    begin_batch: ix.beginBatch(pid, ledger, F, 9n, root, 11, 5_000n, 2, 3),
    stage_chunk: ix.stageChunk(pid, ledger, batch, [escrow], [book], 1, [root, cr0], [wire0]),
    commit_batch: ix.commitBatch(pid, batch, [book]),
    abort_batch: ix.abortBatch(pid, batch, F),
    resolve_staged: ix.resolveStaged(pid, batch, [escrow], [[1, 0]]),
    close_batch: ix.closeBatch(pid, batch, F),
  };
  assert.equal(Object.keys(built).length, V.instructions.length);
  for (const c of V.instructions) {
    const i = built[c.name];
    assert.ok(i, c.name);
    assert.equal(toHex(i.data), c.data, c.name);
    assert.deepEqual(
      i.keys.map((k) => ({ pubkey: b58encode(k.pubkey), signer: k.isSigner, writable: k.isWritable })),
      c.accounts,
      c.name,
    );
  }
});

test("account layouts decode", () => {
  const lg = decodeLedger(fromHex(V.layouts.ledger));
  assert.equal(lg.liabilities, 9_876_543_210n);
  assert.equal(lg.nextScope, 42n);
  assert.equal(lg.decimals, 6);
  assert.equal(toHex(lg.salt), V.salt);
  assert.equal(b58encode(lg.vault), b58encode(vault));
  const ch = decodeChannel(fromHex(V.layouts.channel));
  assert.equal(ch.status, 2);
  assert.equal(ch.balance, 40_000n);
  assert.equal(ch.bestCumulative, 10_000n);
  assert.equal(ch.disputeEndSlot, 400_001_500n);
  const bh = decodeBatch(fromHex(V.layouts.batch_hdr));
  assert.equal(bh.numChunks, 4);
  assert.equal(bh.outstanding, 3);
  assert.equal(bh.held, 1_200n);
  assert.equal(bh.count, 11);
  assert.equal(toHex(bh.root), V.merkle.root);
});

test("V1 settle transaction is byte-identical", () => {
  const t = V.v1_settle;
  const wires = V.vouchers.map((c: { wire: { hex: string } }) => fromHex(c.wire.hex));
  const i = ix.settle(pid, ledger, t.accounts.map(b58decode), wires);
  const tx = buildV1Transaction(feePayer, [i], b58decode(t.blockhash), [], { computeUnitLimit: t.cu_limit, loadedAccountsDataSize: t.loaded_bytes });
  assert.equal(toHex(tx), t.tx);
  const s = v1Size(feePayer.publicKey, [i]);
  assert.equal(s.bytes, t.size);
  assert.equal(s.addresses, t.addresses);
  assert.equal(s.signatures, t.signatures);
  assert.equal(compileMessage(feePayer.publicKey, [i]).accountKeys.length, t.addresses);
});
