#!/usr/bin/env node
/**
 * verify-wiring.mjs — READ-ONLY proof that the ported SDK math matches live
 * mainnet. NOTHING is sent. This re-implements the exact derivations the TS
 * SDK uses (same constants, same seeds, same sha256-of-padName64) and checks:
 *
 *   1. configPda() === BQTxsYx… (the live v2 config PDA)
 *   2. the live config account exists, is 122 bytes, disc 0x52, and decodes to
 *      sol_fee / null_fee / null_mint / treasury at the documented offsets
 *   3. domainPda("chat") matches whatever the live registrar has for chat.null,
 *      AND that account exists on-chain (chat.null is registered) → proves the
 *      name-hash + domain-PDA derivation is byte-correct.
 *   4. domainPda(<random unused name>) → getAccountInfo returns null (AVAILABLE)
 *
 * Usage:  node scripts/verify-wiring.mjs    [RPC_URL=…]
 */
import { createHash } from "crypto";
import { Connection, PublicKey } from "@solana/web3.js";

const RPC_URL = process.env.RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || "https://api.mainnet-beta.solana.com";

// ── constants (must match apps/null-portal/lib/null-sdk.ts EXACTLY) ───────────
const REGISTRAR_PROGRAM = new PublicKey("H4wbFJucY9shJt95N8Bra532Z4nnkKhGEfqWvLcYfuDm");
const CONFIG_PDA_EXPECTED = new PublicKey("BQTxsYxocM2ZC3Wb2pVdnyzTPduBcNhKojhBenR6AXYG");
const NULL_MINT = new PublicKey("8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump");
const REGISTRY_SEED = Buffer.from("null-registry");
const DOMAIN_SEED = Buffer.from("null-domain");
const REGISTRY_CONFIG_SIZE = 122;
const REGISTRY_CONFIG_DISC = 0x52;
const RC_OFF_SOL_FEE = 33, RC_OFF_NULL_FEE = 41, RC_OFF_NULL_MINT = 49, RC_OFF_TREASURY = 81;

const padName64 = (name) => {
  const b = Buffer.alloc(64, 0);
  Buffer.from(name, "utf8").copy(b, 0);
  return b;
};
const nameHash = (name) => createHash("sha256").update(padName64(name)).digest();
const configPda = () => PublicKey.findProgramAddressSync([REGISTRY_SEED], REGISTRAR_PROGRAM)[0];
const domainPda = (name) => PublicKey.findProgramAddressSync([DOMAIN_SEED, nameHash(name)], REGISTRAR_PROGRAM)[0];

const OK = "[OK]", BAD = "[XX]";
let failed = 0;
const add = (label, pass, extra = "") => {
  if (!pass) failed++;
  console.log(`  ${pass ? OK : BAD} ${label}${extra ? " — " + extra : ""}`);
};

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  console.log("=".repeat(72));
  console.log(".null PORTAL — verify-wiring (read-only, NOTHING sent)");
  console.log(`RPC: ${RPC_URL}`);
  console.log("=".repeat(72));

  // 1) config PDA derivation
  const derivedCfg = configPda();
  add(
    `configPda() === ${CONFIG_PDA_EXPECTED.toBase58()}`,
    derivedCfg.equals(CONFIG_PDA_EXPECTED),
    `derived ${derivedCfg.toBase58()}`,
  );

  // 2) live config account decode
  const cfgInfo = await conn.getAccountInfo(derivedCfg);
  add("config account exists on mainnet", !!cfgInfo);
  if (cfgInfo) {
    const d = cfgInfo.data;
    add(`config is ${REGISTRY_CONFIG_SIZE} bytes`, d.length === REGISTRY_CONFIG_SIZE, `got ${d.length}`);
    add("config disc === 0x52 ('R')", d[0] === REGISTRY_CONFIG_DISC, `got 0x${d[0].toString(16)}`);
    const solFee = d.readBigUInt64LE(RC_OFF_SOL_FEE);
    const nullFee = d.readBigUInt64LE(RC_OFF_NULL_FEE);
    const nullMint = new PublicKey(d.subarray(RC_OFF_NULL_MINT, RC_OFF_NULL_MINT + 32));
    const treasury = new PublicKey(d.subarray(RC_OFF_TREASURY, RC_OFF_TREASURY + 32));
    console.log(`     sol_fee=${solFee} (${Number(solFee) / 1e9} SOL)`);
    console.log(`     null_fee=${nullFee} atomic (~${(Number(nullFee) / 1e6).toFixed(0)} NULL)`);
    console.log(`     null_mint=${nullMint.toBase58()}`);
    console.log(`     treasury=${treasury.toBase58()}`);
    add("sol_fee > 0", solFee > 0n);
    add("null_fee > 0", nullFee > 0n);
    add("null_mint === real $NULL (8EeDd…pump)", nullMint.equals(NULL_MINT));
  }

  // 3) domainPda("chat") — chat.null is a known REGISTERED name → account must exist
  const chatPda = domainPda("chat");
  console.log(`\n  domainPda("chat") = ${chatPda.toBase58()}`);
  const chatInfo = await conn.getAccountInfo(chatPda);
  add(
    'domainPda("chat") resolves to an existing, registrar-owned account (chat.null is TAKEN)',
    !!chatInfo && chatInfo.owner.equals(REGISTRAR_PROGRAM) && chatInfo.data.length > 0 && chatInfo.data[0] === 0x4e,
    chatInfo ? `owner ${chatInfo.owner.toBase58().slice(0, 8)}… disc 0x${chatInfo.data[0]?.toString(16)}` : "no account",
  );
  if (chatInfo && chatInfo.data.length >= 97) {
    const owner = new PublicKey(chatInfo.data.subarray(65, 97));
    console.log(`     chat.null owner @offset65 = ${owner.toBase58()}`);
  }

  // 4) a random unused name → AVAILABLE (no account)
  const rnd = "portal-verify-" + Math.random().toString(36).slice(2, 10);
  const rndPda = domainPda(rnd);
  const rndInfo = await conn.getAccountInfo(rndPda);
  add(`domainPda("${rnd}") is unregistered → AVAILABLE`, !rndInfo, `pda ${rndPda.toBase58().slice(0, 8)}…`);

  console.log("\n" + "=".repeat(72));
  if (failed === 0) {
    console.log(`${OK} WIRING VERIFIED — ported PDA/SDK math matches live mainnet. No tx sent.`);
  } else {
    console.log(`${BAD} ${failed} check(s) failed — review above.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
