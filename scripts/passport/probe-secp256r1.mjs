#!/usr/bin/env node
// Probe the Agave secp256r1 precompile in isolation to find the exact
// signing/hashing convention it accepts. Sends a bare [precompile] tx per mode.

import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const SECP256R1 = new PublicKey("Secp256r1SigVerify1111111111111111111111111");
const RPC = "https://api.devnet.solana.com";

function buildIx(pubkeyCompressed, signature64, message, ixIndex) {
  const pkOff = 16, sigOff = 49, msgOff = 113;
  const data = Buffer.alloc(msgOff + message.length);
  data.writeUInt8(1, 0); data.writeUInt8(0, 1);
  let o = 2;
  data.writeUInt16LE(sigOff, o); o += 2;
  data.writeUInt16LE(ixIndex, o); o += 2;
  data.writeUInt16LE(pkOff, o); o += 2;
  data.writeUInt16LE(ixIndex, o); o += 2;
  data.writeUInt16LE(msgOff, o); o += 2;
  data.writeUInt16LE(message.length, o); o += 2;
  data.writeUInt16LE(ixIndex, o); o += 2;
  Buffer.from(pubkeyCompressed).copy(data, pkOff);
  Buffer.from(signature64).copy(data, sigOff);
  Buffer.from(message).copy(data, msgOff);
  return new TransactionInstruction({ programId: SECP256R1, keys: [], data });
}

async function main() {
  const keyPath = execSync("solana config get", { encoding: "utf8" }).match(/Keypair Path:\s+(.+)/)[1].trim();
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
  const conn = new Connection(RPC, "confirmed");

  const priv = p256.utils.randomPrivateKey();
  const pub = p256.getPublicKey(priv, true);
  const msg = randomBytes(32);

  // Candidate signing conventions
  const modes = {
    "A: prehash sha256 (precompile hashes)": () => p256.sign(msg, priv, { prehash: true }).toCompactRawBytes(),
    "B: raw msg as digest (no hash)":        () => p256.sign(msg, priv).toCompactRawBytes(),
    "C: sign sha256(msg) explicitly":        () => p256.sign(sha256(msg), priv).toCompactRawBytes(),
  };
  const idxModes = { "ixIndex=0": 0, "ixIndex=0xFFFF": 0xffff };

  for (const [mlabel, signer] of Object.entries(modes)) {
    let sig;
    try { sig = signer(); } catch (e) { console.log(`${mlabel}: sign error ${e.message}`); continue; }
    for (const [ilabel, ix] of Object.entries(idxModes)) {
      const tx = new Transaction().add(buildIx(pub, sig, msg, ix));
      try {
        const s = await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: "confirmed", skipPreflight: false });
        console.log(`CONFIRMED  ${mlabel} | ${ilabel}  -> ${s.slice(0, 20)}...`);
      } catch (e) {
        const m = String(e.message ?? e);
        const code = m.match(/custom program error: (0x[0-9a-f]+)/)?.[1] ?? m.match(/Custom\((\d+)\)/)?.[1] ?? "?";
        console.log(`rejected   ${mlabel} | ${ilabel}  -> err ${code}`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
