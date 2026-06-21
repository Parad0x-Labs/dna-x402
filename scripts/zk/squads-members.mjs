#!/usr/bin/env node
/**
 * Resolve a Squads v4 multisig's members + threshold from its VAULT address,
 * by locating the multisig config account via the vault's tx history.
 * Usage: node scripts/zk/squads-members.mjs <vaultPubkey>
 */
const RPC = "https://solana-rpc.publicnode.com";
const SQUADS = {
  "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf": "v4",
  "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu": "v3",
};
const KNOWN = {
  "2Rhe5AyEPYk3Y2bvxuiGhqbX9UivM6Q3ztr5xELvxcDB": "mainnet-deployer",
  "8fWzmPQhRMnkZo6k26XaywAFgbhHF6FRyTnBwZ6P3N9u": "fee-treasury",
  "7wWKi3S3HVxPqNRfhP1DhicCfiK55oPwEv7b6S1FyKkZ": "receipt-anchor",
};

const VAULT = process.argv[2] || "9M949AfyYCHp9hUk7crZZx3N6Y8sigyWBN6RM6tFq1q5";
// wallets that likely CREATED the multisig (vault has no tx history of its own)
const CREATORS = [
  "2Rhe5AyEPYk3Y2bvxuiGhqbX9UivM6Q3ztr5xELvxcDB",
  VAULT,
];

const { Connection, PublicKey } = await import("@solana/web3.js");
const conn = new Connection(RPC, "confirmed");
const V4 = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");

function vaultMatches(multisigPubkey) {
  for (let idx = 0; idx < 4; idx++) {
    const [v] = PublicKey.findProgramAddressSync(
      [Buffer.from("multisig"), new PublicKey(multisigPubkey).toBytes(), Buffer.from("vault"), Buffer.from([idx])], V4);
    if (v.toBase58() === VAULT) return idx;
  }
  return -1;
}

function decodeV4(d) {
  // anchor disc(8) create_key(32) config_authority(32) threshold(u16) time_lock(u32)
  // transaction_index(u64) stale_index(u64) rent_collector Option<Pubkey> bump(1) members(Vec)
  const threshold = d.readUInt16LE(72);
  let p = 94;
  const tag = d[p]; p += 1;
  if (tag === 1) p += 32; // Some(rent_collector)
  p += 1;                 // bump
  const n = d.readUInt32LE(p); p += 4;
  const members = [];
  for (let i = 0; i < n && p + 33 <= d.length; i++) {
    members.push(new PublicKey(d.slice(p, p + 32)).toBase58());
    p += 33; // 32 key + 1 permissions
  }
  return { threshold, members };
}

const seen = new Set();
for (const addr of CREATORS) {
  let sigs = [];
  try { sigs = await conn.getSignaturesForAddress(new PublicKey(addr), { limit: 60 }); } catch (_) {}
  console.log(`scan ${addr} — ${sigs.length} txns`);
  for (const s of sigs) {
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx) continue;
    const keys = (tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys || [])
      .map((k) => (k.toBase58 ? k.toBase58() : k));
    if (!keys.some((k) => SQUADS[k])) continue;
    for (const k of keys) {
      if (SQUADS[k] || seen.has(k)) continue;
      seen.add(k);
      const info = await conn.getAccountInfo(new PublicKey(k));
      if (!info || !SQUADS[info.owner.toBase58()] || info.data.length <= 80) continue;
      const idx = vaultMatches(k);
      if (idx < 0) continue; // a Squads config, but not OUR vault's multisig
      try {
        const { threshold, members } = decodeV4(info.data);
        console.log(`\n✅ FOUND your multisig config: ${k}`);
        console.log(`   vault index ${idx} -> ${VAULT}`);
        console.log(`   THRESHOLD: ${threshold}-of-${members.length}\n`);
        members.forEach((m, i) => console.log(`   ${i + 1}. ${m}${KNOWN[m] ? "   <= " + KNOWN[m] : ""}`));
        const matched = members.filter((m) => KNOWN[m]).length;
        console.log(`\n   (${matched}/${members.length} match wallets we know — parse ${matched > 0 ? "validated ✓" : "unverified"})`);
        process.exit(0);
      } catch (_) {}
    }
  }
}
console.log("\ncould not locate the multisig config from the deployer wallets' recent history");
