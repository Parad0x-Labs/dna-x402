#!/usr/bin/env node
/**
 * Multi-party Groth16 phase-2 ceremony for shielded_withdraw_v3 (DARK RELAY RAIL).
 *
 * This is the pipeline that makes the V3 verifying key TRUSTLESS:
 *
 *   Phase 1 — ingest a PUBLIC Perpetual Powers of Tau (Hermez powersOfTau28_hez).
 *             We DOWNLOAD it (default: power 14) and `snarkjs powersoftau verify` it.
 *             We never run our own phase-1.
 *   Phase 2 — MULTIPLE independent `snarkjs zkey contribute` steps. In a REAL run each
 *             step is a different human on their own machine publishing a contribution
 *             hash (see ceremony/CONTRIBUTING_V3.md). This DRY RUN simulates N
 *             independent contributors locally (each with fresh OS entropy) to prove
 *             the machinery + transcript end-to-end.
 *   Beacon  — a PUBLIC RANDOM BEACON finalisation using a REAL drand round fetched live
 *             from the League of Entropy (api.drand.sh). In a real run the round is
 *             PRE-COMMITTED (announced before the ceremony) so no one can grind it.
 *
 * Output: a candidate trustless VK + a verifiable transcript (r1cs/zkey/vk sha256,
 * every contribution hash, the drand round + randomness, the ZKey-Ok result).
 *
 * Honest scope: the contributions here are simulated-independent (one operator), so
 * this DRY RUN is not yet trustless — it becomes trustless when the simulated steps
 * are replaced by independent humans. The drand beacon IS real.
 *
 * Usage:
 *   node ceremony/run-ceremony-v3.mjs --contribs 3 [--power 14] [--ptau <path-or-url>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNARKJS = join(REPO, "build", "zk", "node_modules", "snarkjs", "build", "cli.cjs");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i !== -1 ? process.argv[i + 1] : d; };

const CIRCUIT = "shielded_withdraw_v3";
const CONTRIBS = parseInt(arg("contribs", "3"), 10);
const POWER = parseInt(arg("power", "14"), 10); // 2^14 = 16384 >= 5676 constraints
// Hermez Perpetual Powers of Tau (54 contributions). Public, reusable phase-1.
const HERMEZ_URL = `https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_${POWER}.ptau`;
const PTAU_ARG = arg("ptau", null);

const OUT = join(REPO, "ceremony", CIRCUIT);
mkdirSync(OUT, { recursive: true });
const R1CS = join(REPO, "build", "zk", "out", `${CIRCUIT}.r1cs`);
if (!existsSync(R1CS)) throw new Error(`missing ${R1CS} — compile circuits/${CIRCUIT}.circom first (see build/zk/README.md)`);

const sj = (...a) => execFileSync(process.execPath, [SNARKJS, ...a], { stdio: "pipe" }).toString();
const sjInherit = (...a) => execFileSync(process.execPath, [SNARKJS, ...a], { stdio: "inherit" });
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

async function fetchDrand() {
  // League of Entropy default chain (chained pedersen-bls). Live, public randomness.
  const CHAIN = "8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce";
  const info = await (await fetch(`https://api.drand.sh/${CHAIN}/info`)).json();
  const latest = await (await fetch(`https://api.drand.sh/${CHAIN}/public/latest`)).json();
  return {
    source: "drand / League of Entropy (default chain)",
    chain: CHAIN,
    round: latest.round,
    randomness: latest.randomness, // 32-byte hex — used directly as the beacon hex
    signature: latest.signature,
    period: info.period,
    genesis_time: info.genesis_time,
    note: "REAL drand round fetched live at finalisation. A trustless run PRE-COMMITS the round number before the ceremony starts so it cannot be ground.",
  };
}

async function downloadPtau(dest) {
  if (PTAU_ARG && existsSync(PTAU_ARG)) { console.log(`  using local ptau ${PTAU_ARG}`); return PTAU_ARG; }
  if (existsSync(dest)) { console.log(`  ptau already present: ${dest}`); return dest; }
  const url = PTAU_ARG ?? HERMEZ_URL;
  console.log(`  downloading public ptau: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ptau download failed: ${res.status} ${res.statusText} (${url})`);
  await pipeline(res.body, createWriteStream(dest));
  return dest;
}

async function main() {
  console.log(`\n=== TRUSTLESS ceremony pipeline — ${CIRCUIT} (DRY RUN: simulated-independent contributors + REAL drand beacon) ===`);
  console.log(`r1cs sha256: ${sha(R1CS)}`);

  // ── Phase 1: public ptau ────────────────────────────────────────────────────
  console.log(`\n[phase-1] ingest PUBLIC Perpetual Powers of Tau (power ${POWER})`);
  const ptau = await downloadPtau(join(OUT, `powersOfTau28_hez_final_${POWER}.ptau`));
  console.log(`  verifying ptau (snarkjs powersoftau verify)...`);
  const ptauVer = sj("powersoftau", "verify", ptau);
  const ptauOk = /Powers Of Tau Ok!/.test(ptauVer);
  console.log(`  ptau verify: ${ptauOk ? "Powers Of Tau Ok! ✓" : "FAILED ✗"}`);
  if (!ptauOk) { console.error(ptauVer.slice(-500)); process.exit(1); }

  const T = {
    circuit: CIRCUIT,
    mode: "DRY RUN — simulated-independent phase-2 contributors + REAL drand beacon. Becomes trustless when the simulated steps are replaced by independent humans (see ceremony/CONTRIBUTING_V3.md).",
    phase1: { source: "Hermez Perpetual Powers of Tau", power: POWER, ptau: ptau.split(/[\\/]/).pop(), ptau_sha256: sha(ptau), verify: ptauOk ? "Powers Of Tau Ok!" : "FAILED" },
    r1cs_sha256: sha(R1CS),
    contributions: [],
  };

  // ── Phase 2: groth16 setup + N independent contributions ─────────────────────
  console.log(`\n[phase-2] groth16 setup (r1cs + public ptau -> 0000.zkey)`);
  let cur = join(OUT, `${CIRCUIT}_0000.zkey`);
  sjInherit("groth16", "setup", R1CS, ptau, cur);
  T.setup_zkey_sha256 = sha(cur);

  for (let i = 1; i <= CONTRIBS; i++) {
    const next = join(OUT, `${CIRCUIT}_${String(i).padStart(4, "0")}.zkey`);
    const name = `Contributor ${i} (simulated-independent)`;
    // Each contribution uses fresh entropy. In a real run this is a different human.
    sj("zkey", "contribute", cur, next, `--name=${name}`, `-e=${randomBytes(64).toString("hex")}`);
    const contribHash = sha(next);
    T.contributions.push({ index: i, name, zkey_sha256: contribHash });
    console.log(`  contribution ${i}/${CONTRIBS}  zkey sha ${contribHash.slice(0, 16)}…`);
    cur = next;
  }

  // ── Beacon: REAL drand round ─────────────────────────────────────────────────
  console.log(`\n[beacon] fetching a REAL drand round (League of Entropy)...`);
  const beacon = await fetchDrand();
  console.log(`  drand round ${beacon.round}  randomness ${beacon.randomness.slice(0, 16)}…`);
  const fin = join(OUT, `${CIRCUIT}_final.zkey`);
  sj("zkey", "beacon", cur, fin, beacon.randomness, "10", "-n=drand Final Beacon");
  T.beacon = { ...beacon, iterations: 10 };
  T.final_zkey_sha256 = sha(fin);
  console.log(`  beacon -> final.zkey  sha ${T.final_zkey_sha256.slice(0, 16)}…`);

  // ── Verify + export VK ───────────────────────────────────────────────────────
  console.log(`\n[verify] snarkjs zkey verify (anyone can reproduce)`);
  const ver = sj("zkey", "verify", R1CS, ptau, fin);
  const ok = /ZKey Ok!/.test(ver);
  T.verify = ok ? "ZKey Ok!" : "FAILED";
  console.log(`  zkey verify: ${ok ? "ZKey Ok! ✓" : "FAILED ✗"}`);

  const vk = join(OUT, `${CIRCUIT}_vk.json`);
  sj("zkey", "export", "verificationkey", fin, vk);
  T.vk_sha256 = sha(vk);
  const vkJson = JSON.parse(readFileSync(vk, "utf8"));
  T.n_public = vkJson.nPublic;
  T.generatedAt = new Date().toISOString();

  writeFileSync(join(OUT, "transcript_v3.json"), JSON.stringify(T, null, 2) + "\n");
  console.log(`\nTranscript: ceremony/${CIRCUIT}/transcript_v3.json`);
  console.log(`  ${CONTRIBS} contributions + REAL drand round ${beacon.round}; ${T.verify}; nPublic=${T.n_public}`);
  console.log(`  candidate trustless VK: ceremony/${CIRCUIT}/${CIRCUIT}_vk.json (vk_sha256 ${T.vk_sha256.slice(0, 16)}…)`);
  console.log(`\nNEXT: node build/zk/vk-to-rust-v3.mjs ceremony/${CIRCUIT}/${CIRCUIT}_vk.json "<ceremony label>"`);
  if (!ok || T.n_public !== 7) process.exit(1);
}

main().catch((e) => { console.error("\nFATAL:", e.message); process.exit(1); });
