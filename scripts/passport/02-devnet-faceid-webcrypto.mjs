#!/usr/bin/env node
/**
 * Devnet end-to-end using the WebCrypto ceremony — the EXACT crypto path the
 * browser runs (crypto.subtle P-256). Proves the website's Face ID flow works
 * on-chain without a browser or wallet extension.
 *
 * Usage: node scripts/passport/02-devnet-faceid-webcrypto.mjs <PROGRAM_ID>
 */

import { Connection, Keypair, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  generateP256Passkey, signChallenge, secp256r1Ix, deriveVaultPda, registerIx, verifySignalIx,
} from "./lib/faceid.mjs";
import { PublicKey } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey(process.argv[2] ?? "2efdJX36viRxMeaSZv9jMM85Vys2xDSyUjK9PvCFXeq2");
const RPC = process.env.FACEID_RPC ?? "https://api.devnet.solana.com";
const CLUSTER = RPC.includes("mainnet") ? "mainnet-beta" : "devnet";

async function main() {
  const keyPath = execSync("solana config get", { encoding: "utf8" }).match(/Keypair Path:\s+(.+)/)[1].trim();
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
  const conn = new Connection(RPC, "confirmed");

  console.log(`\n=== Face ID via WebCrypto (browser ceremony) — ${CLUSTER} ===`);
  console.log("Program:", PROGRAM_ID.toBase58());

  // The browser ceremony: generate a P-256 passkey (biometric-gated in-browser).
  const pk = await generateP256Passkey();
  const agent = wallet.publicKey.toBuffer();
  const credId = randomBytes(32);
  const C1 = randomBytes(32);
  const C2 = randomBytes(32);
  const pda = deriveVaultPda(PROGRAM_ID, wallet.publicKey, credId);
  console.log("Vault PDA:", pda.toBase58());

  const results = {};
  const send = async (label, ixs, expectOk, code) => {
    try {
      const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [wallet], { commitment: "confirmed" });
      results[label] = sig;
      console.log(`  ${expectOk ? "PASS" : "FAIL"} ${label}: ${sig.slice(0, 22)}...`);
      return expectOk;
    } catch (e) {
      const m = String(e.message ?? e);
      const good = !expectOk && (code ? m.includes(code) : true);
      console.log(`  ${good ? "PASS" : "FAIL"} ${label}: rejected${code ? ` (want ${code})` : ""}`);
      if (!good) console.log("     ", m.slice(0, 160));
      return good;
    }
  };

  // Register
  console.log("\n[1] Register (WebCrypto P-256)...");
  const regPre = secp256r1Ix({ pubkeyCompressed: pk.compressed, signature64: await signChallenge(pk.keyPair.privateKey, C1), message: C1 });
  const reg = registerIx({ programId: PROGRAM_ID, vaultPda: pda, walletOwner: wallet.publicKey, agent, credIdHash: credId, challenge: C1, x: pk.x, y: pk.y });
  const r1 = await send("register", [regPre, reg], true);

  // Negative: wrong key
  console.log("\n[2] Negative: different passkey (expect 0x4009)...");
  const pk2 = await generateP256Passkey();
  const badPre = secp256r1Ix({ pubkeyCompressed: pk2.compressed, signature64: await signChallenge(pk2.keyPair.privateKey, C1), message: C1 });
  const verIx = verifySignalIx({ programId: PROGRAM_ID, vaultPda: pda, walletOwner: wallet.publicKey, challenge: C1, newChallenge: C2 });
  const n1 = await send("neg-wrong-key", [badPre, verIx], false, "0x4009");

  // Sign-in (real)
  console.log("\n[3] Sign-in (bound passkey signs live challenge)...");
  const inPre = secp256r1Ix({ pubkeyCompressed: pk.compressed, signature64: await signChallenge(pk.keyPair.privateKey, C1), message: C1 });
  const s1 = await send("signin", [inPre, verIx], true);

  const allPass = r1 && n1 && s1;
  console.log(`\n${allPass ? "PASS" : "FAIL"}: WebCrypto (browser) Face ID ceremony verified on-chain.`);
  if (results.register) console.log("register:", `https://explorer.solana.com/tx/${results.register}?cluster=${CLUSTER}`);
  if (results.signin) console.log("signin  :", `https://explorer.solana.com/tx/${results.signin}?cluster=${CLUSTER}`);
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
