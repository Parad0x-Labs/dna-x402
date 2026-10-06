import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { bls12_381 as bls } from "@noble/curves/bls12-381";
const commit = JSON.parse(readFileSync("/w/new/beacon-commit.json", "utf8"));
const C = commit.info.hash, R = commit.target_round;
const relays = ["https://api.drand.sh", "https://drand.cloudflare.com", "https://api2.drand.sh"];
async function get(base) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${base}/${C}/public/${R}`, { signal: AbortSignal.timeout(10000) }); if (r.ok) return await r.json(); } catch {}
    await new Promise((s) => setTimeout(s, 6000));
  }
  return null;
}
const out = {};
for (const b of relays) out[b] = await get(b);
const ref = out[relays[0]];
const agree = relays.filter((b) => out[b] && out[b].randomness === ref.randomness && out[b].signature === ref.signature);
const randOk = createHash("sha256").update(Buffer.from(ref.signature, "hex")).digest("hex") === ref.randomness;
// pedersen-bls-chained: msg = sha256(previous_signature || round as u64 BE), sig in G2, pk in G1
const rb = Buffer.alloc(8); rb.writeBigUInt64BE(BigInt(R));
const msg = createHash("sha256").update(Buffer.concat([Buffer.from(ref.previous_signature, "hex"), rb])).digest();
const sigOk = bls.verify(ref.signature, msg, commit.info.public_key);
const rec = { ...ref, chain: C, relays_agreeing: agree, randomness_is_sha256_of_signature: randOk, bls_signature_verified: sigOk, fetched_at: new Date().toISOString() };
writeFileSync("/w/new/beacon.json", JSON.stringify(rec, null, 2));
console.log(JSON.stringify(rec, null, 1));
