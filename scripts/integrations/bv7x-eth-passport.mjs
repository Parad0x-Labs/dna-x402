#!/usr/bin/env node
/**
 * BV-7X Dark Passport — ETH/Base wallet identity binding on Solana
 *
 * Any BV-7X participant with a MetaMask/Base wallet binds their
 * ETH address to a Solana identity PDA via dark_secp256k1_auth.
 *
 * dark_secp256k1_auth: AqwBbV13AoczhoELwP8oxT3nDqB6MsLWXauNzHkssZ9B (mainnet)
 *
 * What it does:
 *   ETH address (Base wallet) → secp256k1 precompile → EthAgentRecord PDA
 *
 * Use cases for BV-7X:
 *   - Arena agent credentials tied to ETH wallet
 *   - Sybil resistance: same ETH wallet can't register twice
 *   - Pseudonymous leaderboard: ETH address bound but not exposed
 *   - Cross-chain identity: Base wallet = Solana Dark Passport
 *
 * Run: node scripts/integrations/bv7x-eth-passport.mjs --test
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const SECP256K1_AUTH = new PublicKey("AqwBbV13AoczhoELwP8oxT3nDqB6MsLWXauNzHkssZ9B");
const SOLANA_RPC     = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

// ── ETH address ───────────────────────────────────────────────────────────────

export function ethAddress(privKey) {
  const pub = secp256k1.getPublicKey(privKey, false).slice(1);
  return Buffer.from(keccak_256(pub).slice(12));
}

// ── secp256k1 precompile instruction ─────────────────────────────────────────

function secp256k1Ix({ ethAddr, sig64, recovId, msgHash, ixIndex }) {
  const sigOff = 12, addrOff = sigOff + 65, msgOff = addrOff + 20;
  const data = Buffer.alloc(msgOff + 32);
  data[0] = 1;
  let o = 1;
  data.writeUInt16LE(sigOff, o);  o += 2;
  data[o++] = ixIndex & 0xff;
  data.writeUInt16LE(addrOff, o); o += 2;
  data[o++] = ixIndex & 0xff;
  data.writeUInt16LE(msgOff, o);  o += 2;
  data.writeUInt16LE(32, o);      o += 2;
  data[o++] = ixIndex & 0xff;
  Buffer.from(sig64).copy(data, sigOff);
  data[sigOff + 64] = recovId & 0xff;
  Buffer.from(ethAddr).copy(data, addrOff);
  Buffer.from(msgHash).copy(data, msgOff);
  return new TransactionInstruction({
    programId: new PublicKey("KeccakSecp256k11111111111111111111111111111"),
    keys: [], data,
  });
}

// ── Register ──────────────────────────────────────────────────────────────────

export async function registerBV7XPassport(ethPriv, solanaPayer, rpcUrl = SOLANA_RPC) {
  const conn    = new Connection(rpcUrl, "confirmed");
  const addr    = ethAddress(ethPriv);

  // Solana secp256k1 precompile hashes the message internally with keccak256.
  // Sign keccak256(rawMessage) but pass rawMessage to the precompile.
  const rawMsg    = Buffer.alloc(32, 0x42);
  const msgDigest = Buffer.from(keccak_256(rawMsg));

  // noble/curves v2: sign() returns raw 64-byte Uint8Array (r||s)
  // Use Signature.fromCompact + addRecoveryBit to find recovery id
  const sig64raw = secp256k1.sign(msgDigest, ethPriv);
  const r        = Buffer.from(sig64raw.slice(0, 32));
  const s        = Buffer.from(sig64raw.slice(32, 64));
  const sig64    = Buffer.concat([r, s]);
  // Find recovery bit by trying 0 and 1
  const pubKeyFull = secp256k1.getPublicKey(ethPriv, false);
  let recovId = 0;
  for (let bit = 0; bit < 2; bit++) {
    try {
      const rec = secp256k1.Signature.fromCompact(sig64raw)
        .addRecoveryBit(bit)
        .recoverPublicKey(msgDigest);
      if (Buffer.from(rec.toRawBytes(false)).equals(Buffer.from(pubKeyFull))) {
        recovId = bit; break;
      }
    } catch { /* try next */ }
  }

  const pdaSeed    = Buffer.concat([Buffer.alloc(12), addr]);
  const authHash   = Buffer.alloc(32, 0x01);
  const domainHash = Buffer.alloc(32, 0x02);

  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("eth-agent"), addr], SECP256K1_AUTH
  );

  const preIx = secp256k1Ix({ ethAddr: addr, sig64, recovId, msgHash: rawMsg, ixIndex: 0 });
  const regIx = new TransactionInstruction({
    programId: SECP256K1_AUTH,
    keys: [
      { pubkey: pda,                          isSigner: false, isWritable: true },
      { pubkey: solanaPayer.publicKey,        isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId,      isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,   isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from([0x01]), r, s, Buffer.from([recovId]),
      rawMsg, pdaSeed, authHash, domainHash,
    ]),
  });

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: solanaPayer.publicKey })
    .add(preIx, regIx);
  tx.sign(solanaPayer);

  const txSig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await conn.confirmTransaction({ signature: txSig, blockhash, lastValidBlockHeight }, "confirmed");

  return {
    tx:          txSig,
    pda:         pda.toBase58(),
    ethAddress:  `0x${addr.toString("hex")}`,
    explorerUrl: `https://explorer.solana.com/tx/${txSig}?cluster=mainnet-beta`,
  };
}

export async function lookupBV7XPassport(ethAddressHex, rpcUrl = SOLANA_RPC) {
  const conn    = new Connection(rpcUrl, "confirmed");
  const ethAddr = Buffer.from(ethAddressHex.replace("0x", ""), "hex");
  const [pda]   = PublicKey.findProgramAddressSync(
    [Buffer.from("eth-agent"), ethAddr], SECP256K1_AUTH
  );
  const info = await conn.getAccountInfo(pda);
  return {
    registered:  info !== null,
    pda:         pda.toBase58(),
    explorerUrl: `https://explorer.solana.com/address/${pda.toBase58()}?cluster=mainnet-beta`,
  };
}

// ── Test ──────────────────────────────────────────────────────────────────────

if (process.argv.includes("--test")) {
  console.log("BV-7X Dark Passport — ETH wallet binding\n");

  const keyPath = execSync("solana config get", { encoding: "utf8" })
    .match(/Keypair Path:\s+(.+)/)?.[1]?.trim();
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8")))
  );

  const ethPriv = randomBytes(32);
  const addr    = ethAddress(ethPriv);
  console.log(`ETH wallet:  0x${addr.toString("hex")}`);
  console.log(`Solana payer: ${payer.publicKey.toBase58()}`);
  console.log("Registering...\n");

  try {
    const result = await registerBV7XPassport(ethPriv, payer, SOLANA_RPC);
    console.log("✅ Registered!");
    console.log(`PDA:         ${result.pda}`);
    console.log(`Solana tx:   ${result.tx}`);
    console.log(`Explorer:    ${result.explorerUrl}`);

    mkdirSync("evidence/integrations", { recursive: true });
    const log = existsSync("evidence/integrations/bv7x-passports.json")
      ? JSON.parse(readFileSync("evidence/integrations/bv7x-passports.json"))
      : [];
    log.push({ ...result, registeredAt: new Date().toISOString() });
    writeFileSync("evidence/integrations/bv7x-passports.json",
      JSON.stringify(log, null, 2) + "\n");
    console.log("Evidence:    evidence/integrations/bv7x-passports.json");
  } catch (e) {
    console.error("Error:", e.message?.slice(0, 200));
    process.exit(1);
  }
}
