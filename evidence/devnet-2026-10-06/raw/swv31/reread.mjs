import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
const conn = new Connection(readFileSync("/w/keys/rpc.url", "utf8").trim(), "confirmed");
const ev = JSON.parse(readFileSync("/w/out/e2e.json", "utf8"));
const wallets = readdirSync("/w/wallets").map((f) => { const [tag, role, pk] = f.replace(/\.json$/, "").split("-"); return { role, pubkey: pk }; });
const sigs = new Map();
const add = (sig, label) => { if (sig && !sigs.has(sig)) sigs.set(sig, label); };
add(ev.initSig, "init");
for (const s of ev.scenarios) { if (s.sig) add(s.sig, s.name); for (const d of s.deposits ?? []) add(d, "deposit"); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const balances = {};
for (const w of wallets) {
  const list = await conn.getSignaturesForAddress(new PublicKey(w.pubkey), { limit: 100 });
  for (const x of list) add(x.signature, `touches ${w.role}`);
  balances[w.role] = { pubkey: w.pubkey, lamports: await conn.getBalance(new PublicKey(w.pubkey)) };
  await sleep(200);
}
const out = [];
for (const [sig, label] of sigs) {
  let t = null;
  for (let i = 0; i < 8 && !t; i++) { try { t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); } catch {} if (!t) await sleep(1500); }
  out.push({ sig, label, slot: t?.slot ?? null, err: t?.meta?.err ?? null, fee: t?.meta?.fee ?? null, found: !!t });
}
out.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
const res = { rereadAt: new Date().toISOString(), program: ev.program, poolConfig: ev.poolConfig, poolVault: ev.poolVault, vaultLamports: await conn.getBalance(new PublicKey(ev.poolVault)), childWalletBalances: balances, transactions: out, summary: { total: out.length, found: out.filter((x) => x.found).length, ok: out.filter((x) => x.found && !x.err).length, failed: out.filter((x) => x.err).length } };
writeFileSync("/w/out/sig-status.json", JSON.stringify(res, null, 2) + "\n");
console.log(JSON.stringify(res.summary), JSON.stringify(balances));
for (const x of out) console.log(x.slot, x.err ? JSON.stringify(x.err) : "ok", x.label, x.sig.slice(0, 12));
