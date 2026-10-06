#!/usr/bin/env node
/**
 * devnet e2e: MetaMask-style ETH address binding via the secp256k1 precompile
 *
 * Proves dark_secp256k1_auth (precompile binding, every build):
 *   1. An ephemeral secp256k1 key (like MetaMask) personal_signs the canonical
 *      binding message for this program and the Solana wallet (agent)
 *   2. RegisterEthAgent + precompile                         → ACCEPTED
 *   3. Precompile ETH address != claimed address             → REJECTED (0x5008)
 *   4. msg_hash != keccak256(signed message)                 → REJECTED (0x5009)
 *   5. Squat: a second Solana key submits a signature made
 *      for the wallet, signing as the agent                   → REJECTED (0x500A)
 *   6. The wallet then registers that same ETH address        → ACCEPTED
 *   7. Pre-fix message format (bare 32 bytes, no agent)       → REJECTED (0x500A)
 *
 * Every outcome is read back from the ledger (getTransaction meta.err).
 *
 * Run: node scripts/passport/03-devnet-metamask-e2e.mjs <PROGRAM_ID>
 */

import { secp256k1 } from "@noble/curves/secp256k1.js"; // @noble/curves 2.x (repo pin)
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
} from "@solana/web3.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  ethAddress, ethAgentPda, registerIx, secp256k1PrecompileIx, signBinding, signRecoverable,
} from "./lib/eth-agent.mjs";

const PROGRAM_ID = new PublicKey(process.argv[2] ?? "7eQZxFw1ygDV38VzBsmHEbFfoyAfBw7XQ4dF9yto1nrZ");
const RPC = process.env.FACEID_RPC ?? "https://api.devnet.solana.com";
const CLUSTER = RPC.includes("mainnet") ? "mainnet-beta" : "devnet";

const randomEthKey = () => (secp256k1.utils.randomSecretKey ?? secp256k1.utils.randomPrivateKey)();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString("hex");

async function main() {
  console.log(`\n=== MetaMask ETH binding e2e (${CLUSTER}) ===`);
  console.log("Program:", PROGRAM_ID.toBase58());

  const keyPath = execSync("solana config get", { encoding: "utf8" })
    .match(/Keypair Path:\s+(.+)/)?.[1]?.trim();
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8")))
  );
  const conn = new Connection(RPC, "confirmed");
  const authHash   = Buffer.alloc(32, 0x01);
  const domainHash = Buffer.alloc(32, 0x02);

  const results = {};
  const rows = [];
  // Land the tx (skipPreflight) and grade it from the ledger.
  const send = async (label, ixs, signers, expectCode /* null = success */) => {
    await sleep(800);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: signers[0].publicKey }).add(...ixs);
    tx.sign(...signers);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    try { await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed"); } catch { /* read below */ }
    let t = null;
    for (let i = 0; i < 20 && !t?.meta; i++) {
      try { t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); } catch { t = null; }
      if (!t?.meta) await sleep(1500 + 500 * i);
    }
    const err = t?.meta ? t.meta.err : "NOT_FOUND";
    const es = JSON.stringify(err);
    const pass = expectCode == null ? err === null : es.includes(`"Custom":${expectCode}`);
    results[label] = sig;
    rows.push({ label, sig, slot: t?.slot ?? null, err, expected: expectCode == null ? "success" : `0x${expectCode.toString(16)}`, pass });
    console.log(`  ${pass ? "PASS" : "FAIL"} ${label}: err=${es} ${sig}`);
    return pass;
  };

  // [1] Register: ETH key signs the binding message for (program, wallet).
  console.log("\n[1] Register with the canonical binding message...");
  const ethPriv = randomEthKey();
  const b = signBinding({ programId: PROGRAM_ID, agent: wallet.publicKey, ethPriv, domainHash, authHash });
  console.log(`ETH address: 0x${hex(b.ethAddr)}`);
  console.log(`Record PDA:  ${ethAgentPda(PROGRAM_ID, b.ethAddr).toBase58()}`);
  const r1 = await send("register", [b.preIx, registerIx({ ...b, agent: wallet.publicKey })], [wallet], null);

  // [2] Precompile verified a different ETH address than the one claimed in pda_seed.
  console.log("\n[2] Wrong ETH address in precompile (expect 0x5008 EthAddressMismatch)...");
  const fake = signBinding({ programId: PROGRAM_ID, agent: wallet.publicKey, ethPriv: randomEthKey(), domainHash, authHash });
  const freshEthAddr = ethAddress(randomEthKey());
  const n1 = await send("wrong-eth-addr",
    [fake.preIx, registerIx({ ...fake, claimedEthAddr: freshEthAddr, agent: wallet.publicKey })], [wallet], 0x5008);

  // [3] msg_hash is not keccak256 of the signed message.
  console.log("\n[3] msg_hash != keccak256(signed message) (expect 0x5009 MessageMismatch)...");
  const mm = signBinding({ programId: PROGRAM_ID, agent: wallet.publicKey, ethPriv: randomEthKey(), domainHash, authHash });
  const n2 = await send("msg-mismatch",
    [mm.preIx, registerIx({ ...mm, msgHash: Buffer.alloc(32, 0x43), agent: wallet.publicKey })], [wallet], 0x5009);

  // [4] Squat: the ETH key signed for the wallet; another Solana key (funded so it
  //     could pay the record rent) replays that signature as its own agent.
  console.log("\n[4] Replay a signature made for another agent (expect 0x500A BindingMessageMismatch)...");
  const squatter = Keypair.generate();
  const fund = await send("fund-squatter",
    [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: squatter.publicKey, lamports: 5_000_000 })], [wallet], null);
  const victim = signBinding({ programId: PROGRAM_ID, agent: wallet.publicKey, ethPriv: randomEthKey(), domainHash, authHash });
  const n3 = await send("squat-replay",
    [victim.preIx, registerIx({ ...victim, agent: squatter.publicKey })], [squatter], 0x500A);
  const squatted = (await conn.getAccountInfo(ethAgentPda(PROGRAM_ID, victim.ethAddr))) !== null;
  console.log(`  record after squat attempt: ${squatted ? "EXISTS (FAIL)" : "absent (PASS)"}`);

  // [5] The agent the ETH key signed for registers the same address afterwards.
  console.log("\n[5] Intended agent registers the same ETH address...");
  const r2 = await send("victim-register-after-squat",
    [victim.preIx, registerIx({ ...victim, agent: wallet.publicKey })], [wallet], null);
  const rec = await conn.getAccountInfo(ethAgentPda(PROGRAM_ID, victim.ethAddr));
  const boundTo = rec ? new PublicKey(rec.data.subarray(21, 53)).toBase58() : null;
  const boundOk = boundTo === wallet.publicKey.toBase58();
  console.log(`  record agent: ${boundTo} (${boundOk ? "PASS" : "FAIL"})`);

  // [6] Pre-fix format: a bare 32-byte message that names no agent or program.
  console.log("\n[6] Legacy unbound 32-byte message (expect 0x500A)...");
  const lgPriv = randomEthKey();
  const lgAddr = ethAddress(lgPriv);
  const lgMsg = Buffer.alloc(32, 0x42);
  const lgHash = Buffer.from(keccak_256(lgMsg));
  const lgSig = signRecoverable(lgHash, lgPriv);
  const n4 = await send("legacy-unbound-message", [
    secp256k1PrecompileIx({ ethAddr: lgAddr, sig64: lgSig.sig64, recovId: lgSig.recovId, message: lgMsg }),
    registerIx({ programId: PROGRAM_ID, agent: wallet.publicKey, claimedEthAddr: lgAddr, ...lgSig, msgHash: lgHash, authHash, domainHash }),
  ], [wallet], 0x500A);

  // Return the squatter's SOL.
  const bal = await conn.getBalance(squatter.publicKey);
  if (bal > 5000) {
    await send("sweep-squatter",
      [SystemProgram.transfer({ fromPubkey: squatter.publicKey, toPubkey: wallet.publicKey, lamports: bal - 5000 })], [squatter], null);
  }

  const allPass = r1 && n1 && n2 && fund && n3 && !squatted && r2 && boundOk && n4;
  console.log(`\n${allPass ? "PASS" : "FAIL"}: MetaMask ETH binding verified on-chain.`);
  if (results.register)
    console.log("TX:", `https://explorer.solana.com/tx/${results.register}?cluster=${CLUSTER}`);

  mkdirSync("evidence/passport", { recursive: true });
  writeFileSync("evidence/passport/metamask-eth-binding-e2e.json", JSON.stringify({
    schemaVersion: "1.1",
    generatedAt: new Date().toISOString(),
    test: `metamask-eth-binding-${CLUSTER}`,
    cluster: CLUSTER,
    program: PROGRAM_ID.toBase58(),
    results: {
      register:              { pass: r1, signature: results.register ?? null },
      rejectWrong:           { pass: n1, expectedError: "0x5008 EthAddressMismatch" },
      rejectMessageMismatch: { pass: n2, expectedError: "0x5009 MessageMismatch" },
      rejectSquatReplay:     { pass: n3 && !squatted, expectedError: "0x500A BindingMessageMismatch" },
      intendedAgentRegisters:{ pass: r2 && boundOk, signature: results["victim-register-after-squat"] ?? null },
      rejectLegacyMessage:   { pass: n4, expectedError: "0x500A BindingMessageMismatch" },
    },
    transactions: rows,
    allPass,
    notes: [
      "The ETH key personal_signs a message naming the program id, the Solana agent key, the ETH address, domain_hash and auth_hash; the program rebuilds it on-chain and requires the precompile-verified message to equal it.",
      "Identity binding only, no funds.",
    ],
  }, null, 2) + "\n");
  console.log("Evidence: evidence/passport/metamask-eth-binding-e2e.json");
  process.exit(allPass ? 0 : 1);
}
main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
