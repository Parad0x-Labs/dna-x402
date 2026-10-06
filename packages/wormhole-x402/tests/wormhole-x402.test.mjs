import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";

import {
  RECEIPT_ANCHOR_PROGRAM_ID,
  RECEIPT_ANCHOR_PROGRAM_IDS,
  WORMHOLE_CORE_BRIDGE_SOLANA,
  buildAnchorInstructionData,
  buildCrossChainIntent,
  buildPaymentInstructionData,
  buildReceiptAnchorInstruction,
  bucketIdForUnixSeconds,
  computeReceiptHash,
  deriveAnchorBucketPda,
  grossAmount,
  parseAnchorInstructionData,
  resolveReceiptAnchorProgramId,
  solveIntent,
  verifyCrossChainReceipt,
  verifyReceiptAnchorTransaction,
} from "../src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const SRC = join(HERE, "..", "src", "index.ts");
const readConfig = (name) => JSON.parse(readFileSync(join(REPO_ROOT, "configs", name), "utf8"));

const MAINNET_ANCHOR = RECEIPT_ANCHOR_PROGRAM_IDS["mainnet-beta"];
const DEVNET_ANCHOR = RECEIPT_ANCHOR_PROGRAM_IDS.devnet;
const BLOCKHASH = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
// Any valid key the caller names as its x402 payment program.
const X402_PROGRAM = Keypair.generate().publicKey.toBase58();

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest();

function makeVaa(body = "wormhole body") {
  // version=1, guardian set index=0, 0 signatures, then body bytes.
  return Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0]), Buffer.from(body)]).toString("base64");
}

function makeIntent(overrides = {}) {
  return {
    ...buildCrossChainIntent({
      sourceChain: "base",
      payerEthAddress: "0xAbCd1234567890abcdef1234567890ABCDEF1234",
      amountUsdc: 0.05,
      apiEndpoint: "https://api.example.com/premium",
    }),
    wormholeVaaBytes: makeVaa(),
    ...overrides,
  };
}

/** Connection double for sendAndConfirmTransaction: records every tx, never touches a network. */
function recordingConnection() {
  const sent = [];
  return {
    sent,
    async sendTransaction(tx, signers) {
      tx.recentBlockhash = BLOCKHASH;
      tx.sign(...signers);
      sent.push(tx);
      return `sig-${sent.length}`;
    },
    async confirmTransaction() {
      return { context: { slot: 1 }, value: { err: null } };
    },
  };
}

function txResponse(message, meta = {}) {
  return {
    transaction: { message, signatures: [] },
    meta: { err: null, loadedAddresses: { writable: [], readonly: [] }, ...meta },
  };
}

function legacyMessage(payer, ...ixs) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer;
  tx.recentBlockhash = BLOCKHASH;
  return tx.compileMessage();
}

function fakeRpc(response) {
  return { getTransaction: async () => response };
}

async function anchorIx({ programId = MAINNET_ANCHOR, payer, anchor, bucketId = 123n }) {
  return buildReceiptAnchorInstruction({ anchorProgramId: programId, payer: payer.toBase58(), anchor, bucketId });
}

const RECEIPT = { solanaTx: "payment-sig", receiptAnchorTx: "anchor-sig", vaaHash: "ab".repeat(32) };
const INTENT_ID = "intent-1";

// ── Program IDs come from the cluster configs ────────────────────────────────

test("receipt_anchor IDs mirror configs/*.oss.json programs.receiptAnchor", () => {
  assert.equal(MAINNET_ANCHOR, readConfig("mainnet.oss.json").programs.receiptAnchor);
  assert.equal(DEVNET_ANCHOR, readConfig("devnet.oss.json").programs.receiptAnchor);
  assert.equal(RECEIPT_ANCHOR_PROGRAM_ID, MAINNET_ANCHOR);
  assert.deepEqual(Object.keys(RECEIPT_ANCHOR_PROGRAM_IDS).sort(), ["devnet", "mainnet-beta"]);
  assert.ok(Object.isFrozen(RECEIPT_ANCHOR_PROGRAM_IDS));
});

test("every base58 pubkey literal in src is a configured program or the Wormhole bridge", () => {
  const src = readFileSync(SRC, "utf8");
  const allowed = new Set([
    ...Object.values(readConfig("mainnet.oss.json").programs),
    ...Object.values(readConfig("devnet.oss.json").programs),
    WORMHOLE_CORE_BRIDGE_SOLANA,
  ]);
  const literals = [...src.matchAll(/["'`]([1-9A-HJ-NP-Za-km-z]{32,44})["'`]/g)].map((m) => m[1]);
  const pubkeys = literals.filter((s) => {
    try {
      return new PublicKey(s).toBase58() === s;
    } catch {
      return false;
    }
  });
  assert.ok(pubkeys.length >= 3, "expected the vendored program IDs to be found");
  for (const key of pubkeys) assert.ok(allowed.has(key), `hardcoded program ID not in configs: ${key}`);
});

test("resolveReceiptAnchorProgramId: default, cluster, override, rejects unknown", () => {
  assert.equal(resolveReceiptAnchorProgramId(), MAINNET_ANCHOR);
  assert.equal(resolveReceiptAnchorProgramId({ cluster: "devnet" }), DEVNET_ANCHOR);
  assert.equal(resolveReceiptAnchorProgramId({ cluster: "devnet", anchorProgramId: X402_PROGRAM }), X402_PROGRAM);
  for (const cluster of ["testnet", "localnet", "__proto__", "toString", ""]) {
    assert.throws(() => resolveReceiptAnchorProgramId({ cluster }), /No receipt_anchor program/);
  }
  assert.throws(() => resolveReceiptAnchorProgramId({ anchorProgramId: "" }), /non-empty/);
});

// ── Instruction encoding ─────────────────────────────────────────────────────

test("buildAnchorInstructionData: [1][1][anchor32][bucket u64 LE], 42 bytes", () => {
  const anchor = sha256("x");
  const data = buildAnchorInstructionData(anchor, 0x0102030405060708n);
  assert.equal(data.length, 42);
  assert.deepEqual([...data.subarray(0, 2)], [1, 1]);
  assert.ok(data.subarray(2, 34).equals(anchor));
  assert.deepEqual([...data.subarray(34)], [8, 7, 6, 5, 4, 3, 2, 1]);
  assert.throws(() => buildAnchorInstructionData(new Uint8Array(31), 1n), /32 bytes/);
});

test("parseAnchorInstructionData mirrors the program's unpack_single rules", () => {
  const anchor = sha256("y");
  assert.deepEqual(parseAnchorInstructionData(buildAnchorInstructionData(anchor, 9n)), { anchor, bucketId: 9n });

  const implicit = Buffer.concat([Buffer.from([1, 0]), anchor]);
  assert.deepEqual(parseAnchorInstructionData(implicit), { anchor, bucketId: null });

  const badVersion = Buffer.from(implicit);
  badVersion[0] = 2;
  assert.equal(parseAnchorInstructionData(badVersion), null);

  const implicitWithFlag = Buffer.from(implicit);
  implicitWithFlag[1] = 1;
  assert.equal(parseAnchorInstructionData(implicitWithFlag), null);

  const explicitNoFlag = buildAnchorInstructionData(anchor, 9n);
  explicitNoFlag[1] = 0;
  assert.equal(parseAnchorInstructionData(explicitNoFlag), null);

  const batch = Buffer.concat([Buffer.from([1, 2]), anchor, anchor]);
  assert.equal(parseAnchorInstructionData(batch), null);
  assert.equal(parseAnchorInstructionData(new Uint8Array(33)), null);
  assert.equal(parseAnchorInstructionData(new Uint8Array(0)), null);

  // Works on a view into a larger buffer.
  const big = Buffer.concat([Buffer.alloc(5), buildAnchorInstructionData(anchor, 3n), Buffer.alloc(5)]);
  assert.deepEqual(parseAnchorInstructionData(big.subarray(5, 47)), { anchor, bucketId: 3n });
});

test("bucketIdForUnixSeconds matches the program's hourly window", () => {
  assert.equal(bucketIdForUnixSeconds(0), 0n);
  assert.equal(bucketIdForUnixSeconds(-5), 0n);
  assert.equal(bucketIdForUnixSeconds(3599.9), 0n);
  assert.equal(bucketIdForUnixSeconds(3600), 1n);
  assert.equal(bucketIdForUnixSeconds(1_760_000_000), 488_888n);
});

test("buildPaymentInstructionData: [0x02][u64 LE], rejects bad amounts", () => {
  const data = buildPaymentInstructionData(2 ** 40 + 5);
  assert.equal(data.length, 9);
  assert.equal(data[0], 0x02);
  assert.equal(data.readBigUInt64LE(1), 2n ** 40n + 5n);
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    assert.throws(() => buildPaymentInstructionData(bad), RangeError);
  }
});

test("computeReceiptHash = sha256(intentId:solanaTx:vaaHash)", () => {
  assert.ok(computeReceiptHash("a", "b", "c").equals(sha256("a:b:c")));
  assert.equal(computeReceiptHash("a", "b", "c").length, 32);
});

test("buildReceiptAnchorInstruction: payer signer+writable, bucket PDA writable, system program", async () => {
  const payer = Keypair.generate().publicKey;
  const anchor = sha256("z");
  const ix = await anchorIx({ payer, anchor, bucketId: 42n });
  assert.equal(ix.programId.toBase58(), MAINNET_ANCHOR);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bucket"), Buffer.from([42, 0, 0, 0, 0, 0, 0, 0])],
    new PublicKey(MAINNET_ANCHOR)
  );
  assert.equal(await deriveAnchorBucketPda(MAINNET_ANCHOR, 42n), pda.toBase58());
  assert.deepEqual(
    ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [payer.toBase58(), true, true],
      [pda.toBase58(), false, true],
      [SystemProgram.programId.toBase58(), false, false],
    ]
  );
  assert.deepEqual(parseAnchorInstructionData(ix.data), { anchor, bucketId: 42n });
});

// ── solveIntent ──────────────────────────────────────────────────────────────

test("solveIntent requires x402ProgramId and sends nothing without it", async () => {
  const conn = recordingConnection();
  const payer = Keypair.generate();
  for (const options of [undefined, {}, { x402ProgramId: "" }, { x402ProgramId: 42 }]) {
    await assert.rejects(solveIntent(makeIntent(), payer, conn, options), /x402ProgramId/);
  }
  await assert.rejects(solveIntent(makeIntent(), payer, conn, { x402ProgramId: "not-base58!" }));
  await assert.rejects(
    solveIntent(makeIntent(), payer, conn, { x402ProgramId: MAINNET_ANCHOR }),
    /must differ/
  );
  await assert.rejects(
    solveIntent(makeIntent(), payer, conn, { x402ProgramId: X402_PROGRAM, cluster: "testnet" }),
    /No receipt_anchor program/
  );
  assert.equal(conn.sent.length, 0);
});

test("solveIntent pays via the named x402 program and anchors the receipt hash", async () => {
  const conn = recordingConnection();
  const payer = Keypair.generate();
  const intent = makeIntent();
  const before = bucketIdForUnixSeconds(Date.now() / 1000);
  const result = await solveIntent(intent, payer, conn, { x402ProgramId: X402_PROGRAM });
  const after = bucketIdForUnixSeconds(Date.now() / 1000);

  assert.equal(conn.sent.length, 2);
  assert.equal(result.solanaTx, "sig-1");
  assert.equal(result.receiptAnchorTx, "sig-2");

  const [payment] = conn.sent[0].instructions;
  assert.equal(payment.programId.toBase58(), X402_PROGRAM);
  assert.equal(payment.data[0], 0x02);
  assert.equal(payment.data.readBigUInt64LE(1), BigInt(Math.round(grossAmount(0.05) * 1_000_000)));

  const [anchor] = conn.sent[1].instructions;
  assert.equal(anchor.programId.toBase58(), MAINNET_ANCHOR);
  const decoded = parseAnchorInstructionData(anchor.data);
  assert.ok(decoded.anchor.equals(computeReceiptHash(intent.intentId, result.solanaTx, result.vaaHash)));
  assert.ok(decoded.bucketId >= before && decoded.bucketId <= after);
  assert.equal(anchor.keys[1].pubkey.toBase58(), await deriveAnchorBucketPda(MAINNET_ANCHOR, decoded.bucketId));
  assert.equal(anchor.keys.length, 3);

  // Round-trip: the anchor tx solveIntent sent verifies against the same receipt.
  const rpc = fakeRpc(txResponse(conn.sent[1].compileMessage()));
  assert.equal(await verifyCrossChainReceipt(result, intent.intentId, rpc), true);
  assert.equal(await verifyCrossChainReceipt(result, "other-intent", rpc), false);
  assert.equal(await verifyCrossChainReceipt(result, intent.intentId, rpc, { cluster: "devnet" }), false);
});

test("solveIntent targets the devnet receipt_anchor program when cluster is devnet", async () => {
  const conn = recordingConnection();
  const intent = makeIntent();
  const result = await solveIntent(intent, Keypair.generate(), conn, {
    x402ProgramId: X402_PROGRAM,
    cluster: "devnet",
  });
  assert.equal(conn.sent[1].instructions[0].programId.toBase58(), DEVNET_ANCHOR);
  const rpc = fakeRpc(txResponse(conn.sent[1].compileMessage()));
  assert.equal(await verifyCrossChainReceipt(result, intent.intentId, rpc, { cluster: "devnet" }), true);
  // Default (mainnet-beta) expectation must not accept a devnet anchor.
  assert.equal(await verifyCrossChainReceipt(result, intent.intentId, rpc), false);
});

// ── verifyCrossChainReceipt ──────────────────────────────────────────────────

const expectedAnchor = computeReceiptHash(INTENT_ID, RECEIPT.solanaTx, RECEIPT.vaaHash);

test("verify: matching anchor instruction in a legacy message", async () => {
  const payer = Keypair.generate().publicKey;
  const msg = legacyMessage(payer, await anchorIx({ payer, anchor: expectedAnchor }));
  assert.equal(await verifyCrossChainReceipt(RECEIPT, INTENT_ID, fakeRpc(txResponse(msg))), true);
});

test("verify: missing, failed, or meta-less transactions are rejected", async () => {
  const payer = Keypair.generate().publicKey;
  const msg = legacyMessage(payer, await anchorIx({ payer, anchor: expectedAnchor }));
  assert.equal(await verifyCrossChainReceipt(RECEIPT, INTENT_ID, fakeRpc(null)), false);
  assert.equal(
    await verifyCrossChainReceipt(RECEIPT, INTENT_ID, fakeRpc(txResponse(msg, { err: { InstructionError: [0, "Custom"] } }))),
    false
  );
  assert.equal(
    await verifyCrossChainReceipt(RECEIPT, INTENT_ID, fakeRpc({ transaction: { message: msg }, meta: null })),
    false
  );
});

test("verify: anchor program present only as an account (the old check) is rejected", async () => {
  const payer = Keypair.generate().publicKey;
  // A different program is invoked; the anchor program is merely listed as an account.
  // Data, hash, and bucket PDA are all correct, so only the program-target check rejects it.
  const decoy = new TransactionInstruction({
    programId: new PublicKey(X402_PROGRAM),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(await deriveAnchorBucketPda(MAINNET_ANCHOR, 123n)), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(MAINNET_ANCHOR), isSigner: false, isWritable: false },
    ],
    data: buildAnchorInstructionData(expectedAnchor, 123n),
  });
  const msg = legacyMessage(payer, decoy);
  assert.ok(msg.accountKeys.some((k) => k.toBase58() === MAINNET_ANCHOR));
  assert.equal(await verifyCrossChainReceipt(RECEIPT, INTENT_ID, fakeRpc(txResponse(msg))), false);
});

test("verify: wrong hash, wrong receipt fields, or wrong program are rejected", async () => {
  const payer = Keypair.generate().publicKey;
  const wrongHash = legacyMessage(payer, await anchorIx({ payer, anchor: sha256("unrelated") }));
  assert.equal(await verifyCrossChainReceipt(RECEIPT, INTENT_ID, fakeRpc(txResponse(wrongHash))), false);

  const good = fakeRpc(txResponse(legacyMessage(payer, await anchorIx({ payer, anchor: expectedAnchor }))));
  assert.equal(await verifyCrossChainReceipt({ ...RECEIPT, solanaTx: "other" }, INTENT_ID, good), false);
  assert.equal(await verifyCrossChainReceipt({ ...RECEIPT, vaaHash: "cd".repeat(32) }, INTENT_ID, good), false);
  assert.equal(await verifyCrossChainReceipt(RECEIPT, INTENT_ID, good, { cluster: "devnet" }), false);
  assert.equal(await verifyCrossChainReceipt(RECEIPT, INTENT_ID, good, { anchorProgramId: X402_PROGRAM }), false);
});

test("verify: bucket account must be the PDA for the encoded bucket id", async () => {
  const payer = Keypair.generate().publicKey;
  const ix = await anchorIx({ payer, anchor: expectedAnchor, bucketId: 5n });
  ix.keys[1] = { ...ix.keys[1], pubkey: new PublicKey(await deriveAnchorBucketPda(MAINNET_ANCHOR, 6n)) };
  const msg = legacyMessage(payer, ix);
  assert.equal(await verifyCrossChainReceipt(RECEIPT, INTENT_ID, fakeRpc(txResponse(msg))), false);
});

test("verify: malformed anchor data or too few accounts are rejected", async () => {
  const payer = Keypair.generate().publicKey;
  const badVersion = await anchorIx({ payer, anchor: expectedAnchor });
  badVersion.data = Buffer.from(badVersion.data);
  badVersion.data[0] = 2;
  assert.equal(
    await verifyCrossChainReceipt(RECEIPT, INTENT_ID, fakeRpc(txResponse(legacyMessage(payer, badVersion)))),
    false
  );

  const oneAccount = new TransactionInstruction({
    programId: new PublicKey(MAINNET_ANCHOR),
    keys: [{ pubkey: payer, isSigner: true, isWritable: true }],
    data: Buffer.concat([Buffer.from([1, 0]), expectedAnchor]),
  });
  assert.equal(
    await verifyCrossChainReceipt(RECEIPT, INTENT_ID, fakeRpc(txResponse(legacyMessage(payer, oneAccount)))),
    false
  );
});

test("verify: implicit-bucket form and a match after an unrelated instruction", async () => {
  const payer = Keypair.generate().publicKey;
  const unrelated = SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  const implicit = new TransactionInstruction({
    programId: new PublicKey(MAINNET_ANCHOR),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(await deriveAnchorBucketPda(MAINNET_ANCHOR, 1n)), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([1, 0]), expectedAnchor]),
  });
  const msg = legacyMessage(payer, unrelated, implicit);
  assert.equal(await verifyCrossChainReceipt(RECEIPT, INTENT_ID, fakeRpc(txResponse(msg))), true);
});

test("verify: v0 message, including a bucket PDA loaded from a lookup table", async () => {
  const payer = Keypair.generate().publicKey;
  const ix = await anchorIx({ payer, anchor: expectedAnchor, bucketId: 77n });

  const plain = new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: [ix] }).compileToV0Message();
  assert.equal(await verifyReceiptAnchorTransaction(txResponse(plain), { anchorProgramId: MAINNET_ANCHOR, expectedAnchor }), true);

  const bucketPda = new PublicKey(await deriveAnchorBucketPda(MAINNET_ANCHOR, 77n));
  const lut = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [bucketPda] },
  });
  const withLut = new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: [ix] }).compileToV0Message([lut]);
  assert.equal(withLut.addressTableLookups.length, 1, "bucket PDA should be loaded via the lookup table");

  const loaded = { writable: [bucketPda], readonly: [] };
  assert.equal(
    await verifyReceiptAnchorTransaction(txResponse(withLut, { loadedAddresses: loaded }), { anchorProgramId: MAINNET_ANCHOR, expectedAnchor }),
    true
  );
  // Without the loaded addresses the keys cannot be resolved: reject rather than guess.
  assert.equal(
    await verifyReceiptAnchorTransaction(txResponse(withLut, { loadedAddresses: undefined }), { anchorProgramId: MAINNET_ANCHOR, expectedAnchor }),
    false
  );
});
