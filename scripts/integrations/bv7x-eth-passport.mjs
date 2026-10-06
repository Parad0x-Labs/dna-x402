#!/usr/bin/env node
/**
 * BV-7X Dark Passport — ETH/Base wallet identity binding on Solana
 *
 * Any BV-7X participant with a MetaMask/Base wallet binds their
 * ETH address to a Solana identity PDA via dark_secp256k1_auth.
 *
 * SECP256K1_AUTH_PROGRAM_ID — dark_secp256k1_auth deployment to bind against (required:
 *                             the mainnet pilot program was retired on 2026-07-14)
 *
 * What it does:
 *   ETH address (Base wallet) → secp256k1 precompile → EthAgentRecord PDA
 *   The ETH wallet personal_signs a message naming the program id and the
 *   Solana key, so the signature cannot bind the address to another key.
 *
 * Use cases for BV-7X:
 *   - Arena agent credentials tied to ETH wallet
 *   - Sybil resistance: same ETH wallet can't register twice
 *   - Pseudonymous leaderboard: ETH address bound but not exposed
 *   - Cross-chain identity: Base wallet = Solana Dark Passport
 *
 * Run: node scripts/integrations/bv7x-eth-passport.mjs --test
 */

import {
  Connection, Keypair, PublicKey, Transaction,
} from "@solana/web3.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ethAddress, ethAgentPda, registerIx, signBinding } from "../passport/lib/eth-agent.mjs";

export { ethAddress };

if (!process.env.SECP256K1_AUTH_PROGRAM_ID) {
  console.error("ERROR: set SECP256K1_AUTH_PROGRAM_ID: the mainnet dark_secp256k1_auth pilot program was retired on 2026-07-14.");
  process.exit(2);
}
const SECP256K1_AUTH = new PublicKey(process.env.SECP256K1_AUTH_PROGRAM_ID);
const SOLANA_RPC     = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const clusterOf      = (rpc) => (rpc.includes("devnet") ? "devnet" : rpc.includes("testnet") ? "testnet" : "mainnet-beta");

// ── Register ──────────────────────────────────────────────────────────────────

export async function registerBV7XPassport(ethPriv, solanaPayer, rpcUrl = SOLANA_RPC) {
  const conn = new Connection(rpcUrl, "confirmed");

  // The ETH key personal_signs the canonical binding message, which names this
  // program id and the Solana key being bound (scripts/passport/lib/eth-agent.mjs).
  const authHash   = Buffer.alloc(32, 0x01);
  const domainHash = Buffer.alloc(32, 0x02);
  const signed = signBinding({
    programId: SECP256K1_AUTH, agent: solanaPayer.publicKey, ethPriv, domainHash, authHash,
  });
  const pda = ethAgentPda(SECP256K1_AUTH, signed.ethAddr);
  const regIx = registerIx({ ...signed, agent: solanaPayer.publicKey });

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: solanaPayer.publicKey })
    .add(signed.preIx, regIx);
  tx.sign(solanaPayer);

  const txSig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await conn.confirmTransaction({ signature: txSig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`RegisterEthAgent ${txSig} failed: ${JSON.stringify(conf.value.err)}`);

  return {
    tx:          txSig,
    pda:         pda.toBase58(),
    ethAddress:  `0x${signed.ethAddr.toString("hex")}`,
    explorerUrl: `https://explorer.solana.com/tx/${txSig}?cluster=${clusterOf(rpcUrl)}`,
  };
}

export async function lookupBV7XPassport(ethAddressHex, rpcUrl = SOLANA_RPC) {
  const conn    = new Connection(rpcUrl, "confirmed");
  const ethAddr = Buffer.from(ethAddressHex.replace("0x", ""), "hex");
  const pda     = ethAgentPda(SECP256K1_AUTH, ethAddr);
  const info = await conn.getAccountInfo(pda);
  return {
    registered:  info !== null,
    pda:         pda.toBase58(),
    explorerUrl: `https://explorer.solana.com/address/${pda.toBase58()}?cluster=${clusterOf(rpcUrl)}`,
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
    console.log("Registered.");
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
