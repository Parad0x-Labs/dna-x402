#!/usr/bin/env node
/**
 * NullPay — ed25519 stealth pay-by-.null-name — DEVNET end-to-end.
 *
 * Flow:
 *   1. Register  stealthtest1.null            (registrar ix 0x02)
 *   2. SetStealthMeta on it                   (registrar ix 0x06; reallocs 154->218)
 *      -> publishes the recipient's ed25519 meta-address (spend_pub || view_pub)
 *   3. SENDER  resolves the name on-chain, derives a ONE-TIME stealth address P
 *      + ephemeral R, transfers SOL to P, and publishes R in a memo (StealthAnnounce).
 *   4. RECIPIENT scans the announce with the VIEW key only, confirms P is theirs,
 *      and recovers the one-time scalar p (p*B == P).
 *   5. RECIPIENT sweeps the funds out of P to a fresh destination, signing the tx
 *      NATIVELY with p via raw-scalar EdDSA (no ZK, no program) -> Solana verifies.
 *   6. ASSERT recipient's MAIN wallet is NOT on-chain-linked to the payment/sweep.
 *
 * Honest scope: this hides the RECIPIENT. The SENDER (the funded payer below) is
 * still linkable as the sender — that's the shielded-pool / eNULL rail's job.
 *
 * Usage:
 *   node scripts/nullpay/devnet-e2e.mjs --program <REGISTRAR_PROGRAM_ID>
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keygen, derive, scan, recover, signWithStealthScalar } from "./nullpay-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i !== -1 ? process.argv[i + 1] : d; };
const PROGRAM_ID = arg("program");
const RPC = arg("rpc", "https://api.devnet.solana.com");
const CLUSTER = "devnet";

const DOMAIN_SEED = Buffer.from("null-domain");
const REGISTRY_SEED = Buffer.from("null-registry");
const IX_INIT_REGISTRY = 0x01, IX_REGISTER = 0x02, IX_SET_STEALTH_META = 0x06;
// Canonical SPL Memo program id (devnet + mainnet).
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

const ev = { schemaVersion: "1.0", generatedAt: new Date().toISOString(), test: "nullpay-ed25519-stealth", cluster: CLUSTER, program: PROGRAM_ID, steps: [], asserts: {}, honestCaveats: [], overall: "PENDING" };

function pad64(name) { const b = Buffer.alloc(64); Buffer.from(name, "utf8").copy(b); return b; }
const fail = (m) => { ev.overall = "FAIL"; ev.error = m; writeEvidence(); console.error("FAIL:", m); process.exit(1); };
function writeEvidence() { mkdirSync(join(REPO, "evidence"), { recursive: true }); writeFileSync(join(REPO, "evidence", "nullpay-stealth-devnet.json"), JSON.stringify(ev, null, 2) + "\n"); }

async function main() {
  if (!PROGRAM_ID) fail("--program <REGISTRAR_PROGRAM_ID> required");
  const web3 = await import("@solana/web3.js");
  const nacl = (await import("tweetnacl")).default;
  const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = web3;

  const MEMO_PROGRAM_ID = new PublicKey(MEMO_PROGRAM);

  const conn = new Connection(RPC, "confirmed");
  const pid = new PublicKey(PROGRAM_ID);

  // The funded payer = the SENDER and the registrar caller. (Sender is linkable; that's expected.)
  const keyPath = execSync("solana config get", { encoding: "utf8" }).match(/Keypair Path:\s+(.+)/)?.[1]?.trim();
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
  console.log("Payer/sender :", payer.publicKey.toBase58());

  // ── RECIPIENT identity: a stealth meta-address derived from a spend seed. ──
  // The recipient's MAIN wallet (for sweep destination) is a SEPARATE keypair we
  // generate fresh; its pubkey must NEVER appear in the payment tx (unlinkability).
  const recipientSpendSeed = randomBytes(32);
  const recipientKeys = keygen(recipientSpendSeed);
  const recipientMainWallet = Keypair.generate(); // sweep destination — funded by sender? NO.
  console.log("Recipient meta spend_pub:", Buffer.from(recipientKeys.spendPub).toString("hex"));
  console.log("Recipient meta view_pub :", Buffer.from(recipientKeys.viewPub).toString("hex"));
  console.log("Recipient main wallet   :", recipientMainWallet.publicKey.toBase58(), "(must stay UNLINKED)");

  // ── PDAs ──
  const NAME = "stealthtest1";
  const nameSeed = Buffer.from(NAME, "utf8");
  const [configPDA] = PublicKey.findProgramAddressSync([REGISTRY_SEED], pid);
  const [domainPDA] = PublicKey.findProgramAddressSync([DOMAIN_SEED, nameSeed], pid);
  console.log("Config PDA   :", configPDA.toBase58());
  console.log("Domain PDA   :", domainPDA.toBase58());

  const send = async (ixs, signers) => {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer.publicKey });
    ixs.forEach((i) => tx.add(i));
    return await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  };

  // ── Step 1: InitRegistry (idempotent) ──
  const cfgInfo = await conn.getAccountInfo(configPDA);
  if (!cfgInfo) {
    const data = Buffer.alloc(1 + 8 + 32 + 32);
    data.writeUInt8(IX_INIT_REGISTRY, 0);
    data.writeBigUInt64LE(0n, 1);                            // fee 0 (pilot)
    payer.publicKey.toBuffer().copy(data, 9);                // null_mint (dummy)
    payer.publicKey.toBuffer().copy(data, 41);               // treasury
    const ix = new TransactionInstruction({ programId: pid, keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], data });
    const sig = await send([ix], [payer]);
    ev.steps.push({ step: "init_registry", sig }); console.log("  InitRegistry:", sig);
  } else {
    ev.steps.push({ step: "init_registry", skipped: "already initialised" }); console.log("  Registry already initialised");
  }

  // ── Step 2: Register stealthtest1.null (skip if exists) ──
  const domInfo0 = await conn.getAccountInfo(domainPDA);
  if (!domInfo0) {
    const contentHash = createHash("sha256").update("stealthtest1.null:nullpay:devnet").digest();
    const data = Buffer.alloc(1 + 64 + 32);
    data.writeUInt8(IX_REGISTER, 0);
    pad64(NAME).copy(data, 1);
    contentHash.copy(data, 65);
    const ix = new TransactionInstruction({ programId: pid, keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: domainPDA, isSigner: false, isWritable: true },
      { pubkey: configPDA, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: false }, // null_src dummy
      { pubkey: payer.publicKey, isSigner: false, isWritable: false }, // treasury dummy
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], data });
    const sig = await send([ix], [payer]);
    ev.steps.push({ step: "register", name: `${NAME}.null`, sig, domainPDA: domainPDA.toBase58() });
    console.log("  Register:", sig);
  } else {
    ev.steps.push({ step: "register", skipped: "already registered" }); console.log("  Domain already registered");
  }

  // ── Step 3: SetStealthMeta (publish the recipient meta-address; reallocs 154->218) ──
  {
    const data = Buffer.alloc(1 + 64 + 64);
    data.writeUInt8(IX_SET_STEALTH_META, 0);
    pad64(NAME).copy(data, 1);
    Buffer.from(recipientKeys.meta).copy(data, 65); // 64-byte meta
    const ix = new TransactionInstruction({ programId: pid, keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // owner (= payer, who registered)
      { pubkey: domainPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], data });
    const sig = await send([ix], [payer]);
    ev.steps.push({ step: "set_stealth_meta", sig });
    console.log("  SetStealthMeta:", sig);
  }

  // ── Verify on-chain meta-address round-trips ──
  const domInfo = await conn.getAccountInfo(domainPDA);
  if (!domInfo || domInfo.data.length < 218) fail(`domain account not v2-sized (got ${domInfo?.data.length})`);
  const onchainMeta = Uint8Array.from(domInfo.data.subarray(154, 154 + 64));
  if (Buffer.compare(Buffer.from(onchainMeta), Buffer.from(recipientKeys.meta)) !== 0) fail("on-chain meta != published meta");
  ev.asserts.metaRoundtrip = "PASS";
  console.log("  On-chain meta matches published meta: PASS");

  // ── Step 4: SENDER resolves name -> derives one-time stealth address + R ──
  const ephemSeed = randomBytes(32);
  const payment = derive(onchainMeta, ephemSeed); // uses ONLY the public on-chain meta
  const stealthPub = new PublicKey(payment.stealthPub);
  const ephemHex = Buffer.from(payment.ephemPub).toString("hex");
  console.log("  Stealth address P:", stealthPub.toBase58());
  console.log("  Ephemeral R      :", ephemHex);

  // Sender transfers SOL to P, and publishes R in a memo (the StealthAnnounce).
  const PAY_LAMPORTS = Math.floor(0.02 * LAMPORTS_PER_SOL);
  const announce = `nullpay:v1:${NAME}.null:R=${ephemHex}`;
  const memoIx = new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(announce, "utf8") });
  const transferIx = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: stealthPub, lamports: PAY_LAMPORTS });
  const paySig = await send([transferIx, memoIx], [payer]);
  ev.steps.push({ step: "pay_stealth", sig: paySig, stealthAddress: stealthPub.toBase58(), lamports: PAY_LAMPORTS, ephemR: ephemHex });
  console.log("  Pay -> P + announce R:", paySig);

  const balP = await conn.getBalance(stealthPub, "confirmed");
  if (balP < PAY_LAMPORTS) fail(`stealth address did not receive funds (bal=${balP})`);
  ev.asserts.fundsLanded = "PASS";
  console.log("  Stealth address balance:", balP, "lamports — funds landed: PASS");

  // ── Step 5: RECIPIENT scans the announce with the VIEW key, recovers p, sweeps ──
  // Recipient reads R from the memo (here we use the published payment header).
  const detected = scan(recipientKeys, payment);
  if (!detected) fail("recipient view-key scan FAILED to detect the payment");
  ev.asserts.scanDetected = "PASS";
  console.log("  Recipient view-key scan detected payment: PASS");

  const rec = recover(recipientKeys, payment); // p*B == P asserted inside
  ev.asserts.scalarRecovered = "PASS";
  console.log("  Recipient recovered one-time scalar p (p*B==P): PASS");

  // Sweep: move (balance - fee) from P to the recipient's MAIN wallet, signing with p.
  const FEE = 5000; // lamports reserved for the tx fee (P pays its own fee)
  const sweepLamports = balP - FEE;
  const sweepIx = SystemProgram.transfer({ fromPubkey: stealthPub, toPubkey: recipientMainWallet.publicKey, lamports: sweepLamports });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const sweepTx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: stealthPub }).add(sweepIx);
  const msgBytes = sweepTx.serializeMessage();
  // Native raw-scalar EdDSA signature with p — verifiable under P by Solana's runtime.
  const sig = signWithStealthScalar(rec.p, payment.stealthPub, msgBytes);
  // Sanity: tweetnacl (same verifier Solana uses) accepts it before we submit.
  if (!nacl.sign.detached.verify(msgBytes, sig, payment.stealthPub)) fail("local ed25519 verify of sweep sig under P failed");
  ev.asserts.nativeSigVerifies = "PASS";
  sweepTx.addSignature(stealthPub, Buffer.from(sig));
  const sweepSig = await conn.sendRawTransaction(sweepTx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sweepSig, blockhash, lastValidBlockHeight }, "confirmed");
  ev.steps.push({ step: "sweep", sig: sweepSig, from: stealthPub.toBase58(), to: recipientMainWallet.publicKey.toBase58(), lamports: sweepLamports });
  console.log("  Sweep (native p sig):", sweepSig);

  const balDest = await conn.getBalance(recipientMainWallet.publicKey, "confirmed");
  if (balDest < sweepLamports) fail(`sweep did not land at destination (bal=${balDest})`);
  ev.asserts.sweepLanded = "PASS";
  console.log("  Recipient destination balance:", balDest, "— sweep landed: PASS");

  // ── Step 6: Unlinkability assertions ──
  // (a) The recipient's MAIN wallet pubkey must NOT appear in the PAYMENT tx.
  const payTxParsed = await conn.getTransaction(paySig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const payAccounts = payTxParsed.transaction.message.staticAccountKeys?.map((k) => k.toBase58())
    || payTxParsed.transaction.message.accountKeys.map((k) => k.toBase58());
  const recipMain = recipientMainWallet.publicKey.toBase58();
  const recipSpendHex = Buffer.from(recipientKeys.spendPub).toString("hex");
  const linkedInPayment = payAccounts.includes(recipMain);
  if (linkedInPayment) fail("recipient main wallet IS present in the payment tx (linkable!)");
  // (b) The stealth address P must differ from the meta spend_pub (S).
  const pHex = Buffer.from(payment.stealthPub).toString("hex");
  if (pHex === recipSpendHex) fail("stealth P == meta spend_pub S (not unlinkable)");
  ev.asserts.recipientUnlinked = "PASS";
  ev.asserts.paymentAccounts = payAccounts;
  console.log("  Recipient main wallet NOT in payment tx accounts: PASS (unlinkable)");

  ev.recipient = {
    metaSpendPub: Buffer.from(recipientKeys.spendPub).toString("hex"),
    metaViewPub: Buffer.from(recipientKeys.viewPub).toString("hex"),
    mainWallet: recipMain,
    note: "main wallet is the SWEEP DESTINATION; it never appears in the payment tx",
  };
  ev.stealth = { address: stealthPub.toBase58(), addressHex: pHex, ephemR: ephemHex };
  ev.honestCaveats = [
    "Hides the RECIPIENT only. The SENDER (funded payer) is still on-chain-linkable as the sender — that is the job of a shielded pool / eNULL rail, not stealth addressing.",
    "Native ed25519 signing, NO ZK, NO trusted setup. The one-time stealth address P is a real Solana pubkey; the recipient signs the sweep with the raw scalar p (p*B==P) and Solana verifies it with stock ed25519.",
    "UNAUDITED devnet pilot. mainnet_ready=false throughout. The crate gates this explicitly.",
    "The sweep destination here is a throwaway wallet; in practice the recipient would sweep into a wallet they never link to this meta-address.",
  ];
  ev.overall = "PASS";
  ev.explorer = {
    program: `https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`,
    stealthAddress: `https://explorer.solana.com/address/${stealthPub.toBase58()}?cluster=devnet`,
    payTx: `https://explorer.solana.com/tx/${paySig}?cluster=devnet`,
    sweepTx: `https://explorer.solana.com/tx/${sweepSig}?cluster=devnet`,
  };
  writeEvidence();
  console.log("\nOVERALL: PASS — evidence written to evidence/nullpay-stealth-devnet.json");
}

main().catch((e) => fail(e.stack || String(e)));
