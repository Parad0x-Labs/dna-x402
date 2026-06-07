#!/usr/bin/env node
/**
 * Multi-party Groth16 phase-2 ceremony orchestrator (snarkjs).
 *
 * DEMO MODE (this script as-is): simulates N sequential contributions + a beacon to PROVE the
 * machinery end-to-end — produces a verifiable final zkey + a transcript. It is NOT a trustless
 * ceremony, because one party (me) ran every contribution.
 *
 * A REAL ceremony replaces:
 *   - the simulated contributions → independent humans, each running ONE `snarkjs zkey contribute`
 *     on their OWN machine and publishing their contribution hash (see ceremony/README.md);
 *   - the demo beacon → a PRE-COMMITTED future randomness (a Solana block hash at height H, or a
 *     drand round R, announced before the ceremony starts);
 *   - the local pot16 → a public phase-1 ptau (Hermez / PSE Perpetual PoT). Never run your own phase-1.
 *
 * Usage: node ceremony/run-ceremony.mjs --circuit track_record --ptau circuits/out/pot16_final.ptau --contribs 3
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNARKJS = join(REPO, ".tools", "external", "dark-null-protocol", "node_modules", "snarkjs", "build", "cli.cjs");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i !== -1 ? process.argv[i + 1] : d; };
const CIRCUIT = arg("circuit", "track_record");
const PTAU = arg("ptau", join(REPO, "circuits", "out", "pot16_final.ptau"));
const CONTRIBS = parseInt(arg("contribs", "3"), 10);
const BEACON = arg("beacon", "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"); // DEMO placeholder

const OUT = join(REPO, "ceremony", "transcript", CIRCUIT);
const R1CS = join(REPO, "circuits", "out", `${CIRCUIT}.r1cs`);
const sj = (...a) => execFileSync(process.execPath, [SNARKJS, ...a], { stdio: "pipe" }).toString();
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

if (!existsSync(R1CS)) throw new Error(`missing ${R1CS} — compile the circuit first`);
mkdirSync(OUT, { recursive: true });
const T = {
  circuit: CIRCUIT, r1cs_sha256: sha(R1CS), ptau: PTAU.split(/[\\/]/).pop(),
  mode: "DEMO — simulated contributors + placeholder beacon. A trustless ceremony needs independent humans + a committed beacon (see README).",
  contributions: [],
};

console.log(`ceremony (DEMO) — ${CIRCUIT}  (r1cs sha ${T.r1cs_sha256.slice(0, 12)}…)`);
let cur = join(OUT, `${CIRCUIT}_0000.zkey`);
sj("groth16", "setup", R1CS, PTAU, cur);
console.log(`  setup -> 0000.zkey`);

for (let i = 1; i <= CONTRIBS; i++) {
  const next = join(OUT, `${CIRCUIT}_${String(i).padStart(4, "0")}.zkey`);
  const name = `Contributor ${i}`;
  sj("zkey", "contribute", cur, next, `--name=${name}`, `-e=${randomBytes(32).toString("hex")}`);
  T.contributions.push({ index: i, name, zkey_sha256: sha(next) });
  console.log(`  contribution ${i} (${name})  zkey sha ${sha(next).slice(0, 12)}…`);
  cur = next;
}

const fin = join(OUT, `${CIRCUIT}_final.zkey`);
sj("zkey", "beacon", cur, fin, BEACON, "10", "-n=Final Beacon");
T.beacon = { hex: BEACON, iterations: 10, note: "DEMO placeholder — production: a PRE-COMMITTED future Solana block hash or drand round" };
T.final_zkey_sha256 = sha(fin);
console.log(`  beacon -> final.zkey  sha ${T.final_zkey_sha256.slice(0, 12)}…`);

const ver = sj("zkey", "verify", R1CS, PTAU, fin);
const ok = /ZKey Ok!/.test(ver);
T.verify = ok ? "ZKey Ok!" : "FAILED";
console.log(`  snarkjs zkey verify: ${ok ? "ZKey Ok! ✓" : "FAILED ✗"}`);

const vk = join(OUT, `${CIRCUIT}_vk.json`);
sj("zkey", "export", "verificationkey", fin, vk);
T.vk_sha256 = sha(vk);

writeFileSync(join(OUT, "transcript.json"), JSON.stringify(T, null, 2) + "\n");
console.log(`\nTranscript: ceremony/transcript/${CIRCUIT}/transcript.json  (${CONTRIBS} contributions + beacon; ${T.verify})`);
if (!ok) process.exit(1);
