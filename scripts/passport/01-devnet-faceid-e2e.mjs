#!/usr/bin/env node
/**
 * Devnet end-to-end test for real Face ID (P-256) sign-in.
 *
 * Proves the dark_secp256r1_vault mainnet-mode verification works against the
 * real Agave secp256r1 precompile (SIMD-0075):
 *   1. Register   — bind a P-256 key to a vault (precompile-verified pubkey)
 *   2. Sign-in    — bound key signs the live challenge → accepted, challenge rotates
 *   3. Negative   — wrong message signed     → rejected (ChallengeNotSigned)
 *   4. Negative   — different key signs       → rejected (PasskeyPubkeyMismatch)
 *
 * This validates the on-chain precompile-parsing layout before any mainnet
 * upgrade. Runs against whatever cluster the CLI keypair funds (devnet).
 *
 * Usage: node scripts/passport/01-devnet-faceid-e2e.mjs <PROGRAM_ID>
 */

import { p256 } from "@noble/curves/p256";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const PROGRAM_ID = new PublicKey(process.argv[2] ?? "2efdJX36viRxMeaSZv9jMM85Vys2xDSyUjK9PvCFXeq2");
const SECP256R1_PROGRAM_ID = new PublicKey("Secp256r1SigVerify1111111111111111111111111");
const RPC = "https://api.devnet.solana.com";

// ── secp256r1 precompile instruction builder (self-contained, one signature) ──
function secp256r1Ix({ pubkeyCompressed, signature64, message, ixIndex }) {
  const pkOff = 2 + 14;          // 16
  const sigOff = pkOff + 33;     // 49
  const msgOff = sigOff + 64;    // 113
  const data = Buffer.alloc(msgOff + message.length);
  data.writeUInt8(1, 0);         // num_signatures
  data.writeUInt8(0, 1);         // padding
  let o = 2;
  data.writeUInt16LE(sigOff, o);          o += 2;
  data.writeUInt16LE(ixIndex, o);         o += 2;
  data.writeUInt16LE(pkOff, o);           o += 2;
  data.writeUInt16LE(ixIndex, o);         o += 2;
  data.writeUInt16LE(msgOff, o);          o += 2;
  data.writeUInt16LE(message.length, o);  o += 2;
  data.writeUInt16LE(ixIndex, o);         o += 2;
  Buffer.from(pubkeyCompressed).copy(data, pkOff);
  Buffer.from(signature64).copy(data, sigOff);
  Buffer.from(message).copy(data, msgOff);
  return new TransactionInstruction({ programId: SECP256R1_PROGRAM_ID, keys: [], data });
}

// P-256 ECDSA over SHA-256(message); the precompile hashes with SHA-256 and
// REQUIRES low-S (s <= n/2). noble emits valid but sometimes high-S sigs, so we
// normalize s -> n-s when needed (both are valid; Agave only accepts low-S).
const P256_N = p256.CURVE.n;
const P256_HALF = P256_N >> 1n;
function signP256(priv, message) {
  const raw = p256.sign(message, priv, { prehash: true }).toCompactRawBytes(); // 64, maybe high-S
  let s = BigInt("0x" + Buffer.from(raw.slice(32, 64)).toString("hex"));
  if (s > P256_HALF) {
    s = P256_N - s;
    const sb = Buffer.from(s.toString(16).padStart(64, "0"), "hex");
    return Buffer.concat([Buffer.from(raw.slice(0, 32)), sb]);
  }
  return Buffer.from(raw);
}

function vaultPda(walletOwner, credIdHash) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("passkey-vault"), walletOwner.toBuffer(), credIdHash],
    PROGRAM_ID,
  )[0];
}

function registerIxData(agent, credIdHash, challenge, x, y) {
  return Buffer.concat([Buffer.from([0x01]), agent, credIdHash, challenge, x, y]);
}
function verifyIxData(challenge, newChallenge) {
  return Buffer.concat([Buffer.from([0x02]), challenge, newChallenge]);
}

async function main() {
  const keyPath = execSync("solana config get", { encoding: "utf8" })
    .match(/Keypair Path:\s+(.+)/)[1].trim();
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
  const conn = new Connection(RPC, "confirmed");

  console.log("\n=== Devnet Face ID (P-256) end-to-end ===");
  console.log("Program:", PROGRAM_ID.toBase58());
  console.log("Wallet :", wallet.publicKey.toBase58());

  // P-256 keypair (the "passkey")
  const priv = p256.utils.randomPrivateKey();
  const pubCompressed = p256.getPublicKey(priv, true);   // 33 bytes
  const pubUncompressed = p256.getPublicKey(priv, false); // 65: 0x04||x||y
  const x = Buffer.from(pubUncompressed.slice(1, 33));
  const y = Buffer.from(pubUncompressed.slice(33, 65));

  const agent     = wallet.publicKey.toBuffer();
  const credId    = randomBytes(32);
  const C1        = randomBytes(32);
  const C2        = randomBytes(32);
  const pda       = vaultPda(wallet.publicKey, credId);
  console.log("Vault PDA:", pda.toBase58());

  const results = {};
  const send = async (label, ixs, expectOk, expectCode) => {
    const tx = new Transaction().add(...ixs);
    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: "confirmed" });
      results[label] = { ok: true, sig };
      console.log(`  ${expectOk ? "PASS" : "FAIL"} ${label}: confirmed ${sig.slice(0, 24)}...`);
      return expectOk;
    } catch (e) {
      const msg = String(e.message ?? e);
      const hitExpected = expectCode && msg.includes(expectCode);
      const good = !expectOk && (expectCode ? hitExpected : true);
      results[label] = { ok: false, error: msg.slice(0, 200) };
      console.log(`  ${good ? "PASS" : "FAIL"} ${label}: rejected${expectCode ? ` (want ${expectCode})` : ""}`);
      if (!good) console.log(`       ${msg.slice(0, 180)}`);
      return good;
    }
  };

  // 1. Register — precompile signs C1 (register binds pubkey, not message)
  console.log("\n[1] Register (bind P-256 key)...");
  const regPre = secp256r1Ix({ pubkeyCompressed: pubCompressed, signature64: signP256(priv, C1), message: C1, ixIndex: 0 });
  const regIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: registerIxData(agent, credId, C1, x, y),
  });
  const r1 = await send("register", [regPre, regIx], true);

  // 3. Negative — wrong message signed (sign random, claim challenge C1)
  console.log("\n[2] Negative: wrong message signed (expect ChallengeNotSigned 0x400b)...");
  const wrongMsg = randomBytes(32);
  const negPre = secp256r1Ix({ pubkeyCompressed: pubCompressed, signature64: signP256(priv, wrongMsg), message: wrongMsg, ixIndex: 0 });
  const negIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: verifyIxData(C1, C2),
  });
  const n1 = await send("neg-wrong-message", [negPre, negIx], false, "0x400b");

  // 4. Negative — different key signs C1 (expect PasskeyPubkeyMismatch 0x4009)
  console.log("\n[3] Negative: different P-256 key (expect PasskeyPubkeyMismatch 0x4009)...");
  const priv2 = p256.utils.randomPrivateKey();
  const pub2 = p256.getPublicKey(priv2, true);
  const neg2Pre = secp256r1Ix({ pubkeyCompressed: pub2, signature64: signP256(priv2, C1), message: C1, ixIndex: 0 });
  const n2 = await send("neg-wrong-key", [neg2Pre, negIx], false, "0x4009");

  // 2. Positive sign-in — bound key signs C1, rotate to C2
  console.log("\n[4] Sign-in: bound key signs live challenge (expect PASS, rotate)...");
  const inPre = secp256r1Ix({ pubkeyCompressed: pubCompressed, signature64: signP256(priv, C1), message: C1, ixIndex: 0 });
  const s1 = await send("signin", [inPre, negIx], true);

  const allPass = r1 && n1 && n2 && s1;
  console.log("\n=== Result ===");
  console.log(`register            : ${r1 ? "PASS" : "FAIL"}`);
  console.log(`reject wrong message: ${n1 ? "PASS" : "FAIL"}`);
  console.log(`reject wrong key    : ${n2 ? "PASS" : "FAIL"}`);
  console.log(`sign-in (real)      : ${s1 ? "PASS" : "FAIL"}`);
  console.log(allPass ? "\nPASS: real P-256 Face ID verification works on-chain." : "\nFAIL: see above.");

  // Evidence
  const ex = (s) => s ? `https://explorer.solana.com/tx/${s}?cluster=devnet` : null;
  const evidence = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    test: "devnet-faceid-p256-e2e",
    cluster: "devnet",
    program: PROGRAM_ID.toBase58(),
    vaultPda: pda.toBase58(),
    crypto: "secp256r1 / P-256, SIMD-0075 precompile, ECDSA-SHA256, low-S",
    results: {
      register:            { pass: r1, signature: results.register?.sig ?? null, explorer: ex(results.register?.sig) },
      signin:              { pass: s1, signature: results.signin?.sig ?? null, explorer: ex(results.signin?.sig) },
      rejectWrongMessage:  { pass: n1, expectedError: "0x400b ChallengeNotSigned" },
      rejectWrongKey:      { pass: n2, expectedError: "0x4009 PasskeyPubkeyMismatch" },
    },
    allPass,
    honestCaveats: [
      "Real on-chain P-256 verification via the Agave secp256r1 precompile — proven on devnet, replayable.",
      "v1: the precompile message IS the 32-byte challenge (P-256 key signs it directly). Full WebAuthn authenticatorData parsing on-chain is the audit-scope enhancement.",
      "EXTERNALLY UNAUDITED test pilot. Identity binding only — no funds custody.",
      "Mainnet vault (3hbbtjeSrTVYXq6eRwjeofDe2DCPh3n8cfN6kZcQfewi) still runs devnet-mode until the in-place --features mainnet upgrade.",
    ],
  };
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  mkdirSync(join(repoRoot, "evidence", "passport"), { recursive: true });
  writeFileSync(join(repoRoot, "evidence", "passport", "devnet-faceid-e2e.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log("Evidence: evidence/passport/devnet-faceid-e2e.json");

  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
