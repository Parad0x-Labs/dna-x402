import { Connection, Keypair, Transaction } from "@solana/web3.js";
import fs from "node:fs";
export const conn = new Connection("https://api.devnet.solana.com", "confirmed");
export const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/w/keys/payer.json", "utf8"))));
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const results = [];
export const saveKp = (tag, kp) => fs.writeFileSync(`/w/wallets/${tag}-${kp.publicKey.toBase58()}.json`, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
// expect: "ok" | {custom:n} | {errIncludes:s}. Always lands the tx (skipPreflight) and reads status back from the ledger.
export async function send(label, ixs, signers, expect, feePayer = payer) {
  await sleep(900);
  let bh; for (let i = 0; !bh; i++) { try { bh = await conn.getLatestBlockhash("confirmed"); } catch (e) { if (i > 8) throw e; await sleep(2000 * (i + 1)); } }
  const { blockhash, lastValidBlockHeight } = bh;
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: feePayer.publicKey }).add(...ixs);
  const uniq = [feePayer, ...signers.filter(s => !s.publicKey.equals(feePayer.publicKey))]; tx.sign(...uniq);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  try { await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed"); } catch {}
  let t = null; for (let i = 0; i < 20 && !t?.meta; i++) { try { t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); } catch { t = null; } if (!t?.meta) await sleep(1500 + 500 * i); }
  const err = t?.meta ? t.meta.err : "NOT_FOUND"; const logs = t?.meta?.logMessages ?? [];
  const es = JSON.stringify(err ?? "");
  const pass = expect === "ok" ? err === null : expect.custom !== undefined ? es.includes(`"Custom":${expect.custom}`) : es.includes(expect.errIncludes);
  results.push({ label, expected: expect === "ok" ? "success" : expect, pass, sig, slot: t?.slot ?? null, err, explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`, logs: logs.filter(l => !/ComputeBudget|invoke \[|success$/.test(l)).slice(-4) });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${label}  err=${es}  ${sig}`);
  return { sig, err };
}
export function finish(name, extra = {}) {
  fs.writeFileSync(`/w/logs/${name}.json`, JSON.stringify({ ...extra, results }, null, 2));
  const n = results.filter(r => r.pass).length; console.log(`RESULT ${n}/${results.length} PASS`); process.exit(n === results.length ? 0 : 1);
}
