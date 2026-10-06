#!/usr/bin/env node
/**
 * devnet e2e: real MetaMask ETH address binding via secp256k1 precompile
 *
 * Proves dark_secp256k1_auth (precompile binding, every build) correctly:
 *   1. Generates an ephemeral secp256k1 keypair (like MetaMask)
 *   2. Signs a message → builds the Solana secp256k1 precompile instruction
 *   3. Submits RegisterEthAgent + precompile to the program
 *   4. Verifies: correct ETH address → ACCEPTED
 *   5. Verifies: wrong ETH address → REJECTED (0x5008)
 *   6. Verifies: msg_hash that differs from the signed message → REJECTED (0x5009)
 *
 * Run: node scripts/passport/03-devnet-metamask-e2e.mjs <PROGRAM_ID>
 */

import { secp256k1 } from "@noble/curves/secp256k1.js"; // @noble/curves 2.x (repo pin)
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const PROGRAM_ID = new PublicKey(process.argv[2] ?? "7eQZxFw1ygDV38VzBsmHEbFfoyAfBw7XQ4dF9yto1nrZ");
const RPC = process.env.FACEID_RPC ?? "https://api.devnet.solana.com";
const CLUSTER = RPC.includes("mainnet") ? "mainnet-beta" : "devnet";

const randomEthKey = () => (secp256k1.utils.randomSecretKey ?? secp256k1.utils.randomPrivateKey)();

// Sign a 32-byte digest (no prehash) and find the recovery id: noble 2.x returns
// compact r||s bytes without the recovery bit.
function signRecoverable(digest, priv) {
  const sig64 = secp256k1.sign(digest, priv, { prehash: false });
  const pub = Buffer.from(secp256k1.getPublicKey(priv, false));
  for (const bit of [0, 1]) {
    try {
      const rec = secp256k1.Signature.fromBytes(sig64, "compact").addRecoveryBit(bit).recoverPublicKey(digest);
      if (Buffer.from(rec.toBytes(false)).equals(pub)) {
        return { r: Buffer.from(sig64.slice(0, 32)), s: Buffer.from(sig64.slice(32, 64)), sig64: Buffer.from(sig64), recovId: bit };
      }
    } catch { /* try next */ }
  }
  throw new Error("recovery id not found");
}

// ── ETH address derivation ────────────────────────────────────────────────────
function ethAddress(privKey) {
  const pub = secp256k1.getPublicKey(privKey, false).slice(1); // 64 bytes uncompressed without prefix
  const hash = keccak_256(pub);
  return hash.slice(12); // last 20 bytes
}

// ── secp256k1 precompile instruction builder ──────────────────────────────────
function secp256k1Ix({ ethAddr, sig64, recovId, msgHash, ixIndex }) {
  // Solana secp256k1 precompile offsets struct (11 bytes, u8 for ix fields):
  //   [sig_off:u16][sig_ix:u8][addr_off:u16][addr_ix:u8][msg_off:u16][msg_sz:u16][msg_ix:u8]
  // Signature = r(32)||s(32)||recovery_id(1) = 65 bytes
  // DATA_START = 1 (num_sigs) + 11 (offsets) = 12
  const sigOff  = 12;
  const addrOff = sigOff + 65;
  const msgOff  = addrOff + 20;
  const data = Buffer.alloc(msgOff + 32);
  data[0] = 1; // num_signatures
  let o = 1;
  data.writeUInt16LE(sigOff, o);  o += 2; // sig_offset
  data[o++] = ixIndex & 0xff;             // sig_ix (u8)
  data.writeUInt16LE(addrOff, o); o += 2; // addr_offset
  data[o++] = ixIndex & 0xff;             // addr_ix (u8)
  data.writeUInt16LE(msgOff, o);  o += 2; // msg_offset
  data.writeUInt16LE(32, o);      o += 2; // msg_size
  data[o++] = ixIndex & 0xff;             // msg_ix (u8)
  Buffer.from(sig64).copy(data, sigOff);
  data[sigOff + 64] = recovId & 0xff;     // recovery_id byte
  Buffer.from(ethAddr).copy(data, addrOff);
  Buffer.from(msgHash).copy(data, msgOff);
  return new TransactionInstruction({
    programId: new PublicKey("KeccakSecp256k11111111111111111111111111111"),
    keys: [], data,
  });
}

// RegisterEthAgent (0x01) instruction data
function registerIxData(r, s, recovId, msgHash, pdaSeed, authHash, domainHash) {
  return Buffer.concat([
    Buffer.from([0x01]), r, s, Buffer.from([recovId]),
    msgHash, pdaSeed, authHash, domainHash,
  ]);
}

function pdaFromEthAddr(ethAddr) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("eth-agent"), ethAddr], PROGRAM_ID
  )[0];
}

async function main() {
  console.log(`\n=== MetaMask ETH binding e2e (${CLUSTER}) ===`);
  console.log("Program:", PROGRAM_ID.toBase58());

  const keyPath = execSync("solana config get", { encoding: "utf8" })
    .match(/Keypair Path:\s+(.+)/)?.[1]?.trim();
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8")))
  );
  const conn = new Connection(RPC, "confirmed");

  // Generate ephemeral ETH key (like MetaMask)
  const ethPriv    = randomEthKey();
  const ethAddr    = ethAddress(ethPriv);
  const authHash   = Buffer.alloc(32, 0x01);
  const domainHash = Buffer.alloc(32, 0x02);

  // Solana secp256k1 precompile hashes the message bytes with keccak256 internally.
  // So: pass rawMessage to the precompile, sign keccak256(rawMessage).
  const rawMessage = Buffer.alloc(32, 0x42); // arbitrary message bytes
  const msgDigest  = Buffer.from(keccak_256(rawMessage)); // precompile computes this internally
  const msgHash    = rawMessage; // what we give the precompile (it will keccak it)

  const { r, s, sig64, recovId } = signRecoverable(msgDigest, ethPriv); // sign the digest the precompile will compute

  // pda_seed: 12 zero bytes + eth_address (20 bytes)
  const pdaSeed = Buffer.concat([Buffer.alloc(12), Buffer.from(ethAddr)]);
  const pda = pdaFromEthAddr(ethAddr);

  console.log(`ETH address: 0x${Buffer.from(ethAddr).toString("hex")}`);
  console.log(`Vault PDA:   ${pda.toBase58()}`);

  const results = {};
  const send = async (label, ixs, expectOk, code) => {
    try {
      const sig = await sendAndConfirmTransaction(
        conn, new Transaction().add(...ixs), [wallet],
        { commitment: "confirmed", skipPreflight: true }
      );
      results[label] = sig;
      console.log(`  ${expectOk ? "PASS" : "FAIL"} ${label}: ${sig.slice(0, 20)}...`);
      return expectOk;
    } catch (e) {
      const m = String(e.message ?? JSON.stringify(e));
      // Match hex "0x5008" OR decimal "20488" (parseInt("5008",16)) OR logs
      const codeDecimal = code ? String(parseInt(code.replace("0x",""), 16)) : "";
      const good = !expectOk && (code
        ? (m.includes(code) || m.includes(codeDecimal) || (e.logs ?? []).some(l => l.includes(code)))
        : true);
      console.log(`  ${good ? "PASS" : "FAIL"} ${label}: rejected${code ? ` (want ${code})` : ""}`);
      if (!good) console.log("    ", m.slice(0, 160));
      return good;
    }
  };

  // 1. Register with correct ETH address
  console.log("\n[1] Register correct ETH address...");
  const preCix = secp256k1Ix({ ethAddr, sig64, recovId, msgHash, ixIndex: 0 });
  const regIx  = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: pda,               isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey,  isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: registerIxData(r, s, recovId, msgHash, pdaSeed, authHash, domainHash),
  });
  const r1 = await send("register", [preCix, regIx], true);

  // 2. Wrong ETH address rejected: precompile has fakeEthAddr, but we claim
  //    the real ethAddr in pda_seed. PDA is correctly derived from real ethAddr.
  //    Program: PDA check passes, then ETH mismatch check fires → 0x5008.
  console.log("\n[2] Wrong ETH address in precompile (expect 0x5008 EthAddressMismatch)...");
  const fakeEthPriv = randomEthKey();
  const fakeEthAddr = ethAddress(fakeEthPriv);
  const fakeSig     = signRecoverable(msgDigest, fakeEthPriv);
  const fakeSig64   = fakeSig.sig64;
  // Use a fresh target ETH addr — precompile signs with fakeEthAddr, but instruction
  // claims freshEthAddr (different). PDA is derived from freshEthAddr so PDA check passes.
  // Then ETH mismatch (fakeEthAddr ≠ freshEthAddr) → 0x5008.
  const freshEthPriv = randomEthKey();
  const freshEthAddr = ethAddress(freshEthPriv);
  const freshPda     = pdaFromEthAddr(freshEthAddr);
  const freshPdaSeed = Buffer.concat([Buffer.alloc(12), Buffer.from(freshEthAddr)]);
  // Precompile has FAKE eth addr, instruction claims FRESH eth addr → mismatch
  const wrongPreIx  = secp256k1Ix({ ethAddr: fakeEthAddr, sig64: fakeSig64, recovId: fakeSig.recovId, msgHash, ixIndex: 0 });
  const wrongRegIx  = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: freshPda, isSigner: false, isWritable: true },  // PDA for freshEthAddr
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: registerIxData(r, s, recovId, msgHash, freshPdaSeed, authHash, domainHash),
  });
  const n1 = await send("wrong-eth-addr", [wrongPreIx, wrongRegIx], false, "0x5008");

  // 3. msg_hash in the instruction differs from the message the precompile verified.
  console.log("\n[3] msg_hash != signed message (expect 0x5009 MessageMismatch)...");
  const mmEthPriv = randomEthKey();
  const mmEthAddr = ethAddress(mmEthPriv);
  const mmSig     = signRecoverable(msgDigest, mmEthPriv);
  const mmPdaSeed = Buffer.concat([Buffer.alloc(12), Buffer.from(mmEthAddr)]);
  const mmPre     = secp256k1Ix({ ethAddr: mmEthAddr, sig64: mmSig.sig64, recovId: mmSig.recovId, msgHash, ixIndex: 0 });
  const mmRegIx   = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: pdaFromEthAddr(mmEthAddr), isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: registerIxData(mmSig.r, mmSig.s, mmSig.recovId, Buffer.alloc(32, 0x43), mmPdaSeed, authHash, domainHash),
  });
  const n2 = await send("msg-mismatch", [mmPre, mmRegIx], false, "0x5009");

  const allPass = r1 && n1 && n2;
  console.log(`\n${allPass ? "PASS" : "FAIL"}: MetaMask ETH binding verified on-chain.`);
  if (results.register)
    console.log("TX:", `https://explorer.solana.com/tx/${results.register}?cluster=${CLUSTER}`);

  // Evidence
  mkdirSync("evidence/passport", { recursive: true });
  writeFileSync("evidence/passport/metamask-eth-binding-e2e.json", JSON.stringify({
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    test: `metamask-eth-binding-${CLUSTER}`,
    cluster: CLUSTER,
    program: PROGRAM_ID.toBase58(),
    results: {
      register:    { pass: r1, signature: results.register ?? null },
      rejectWrong: { pass: n1, expectedError: "0x5008 EthAddressMismatch" },
      rejectMessageMismatch: { pass: n2, expectedError: "0x5009 MessageMismatch" },
    },
    allPass,
    notes: [
      "secp256k1 signature verified by the precompile; the program binds the verified ETH address, message and signature in every build.",
      "Identity binding only, no funds.",
    ],
  }, null, 2) + "\n");
  console.log("Evidence: evidence/passport/metamask-eth-binding-e2e.json");
  process.exit(allPass ? 0 : 1);
}
main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
