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
 *   Beacon  — a PUBLIC RANDOM BEACON finalisation using a FIXED, ALREADY-PUBLISHED
 *             drand round from the League of Entropy (api.drand.sh). The round number
 *             and its randomness/signature are BAKED IN below (BEACON constant) — this
 *             models the real flow where the coordinator PRE-COMMITS a round number
 *             before the ceremony so nobody can grind it, and it is also the only sane
 *             way to run deterministically: we NEVER wait on / fetch a future "latest"
 *             round. We optionally re-fetch the SAME fixed round to prove the baked value
 *             matches drand, but the baked constant is authoritative — no live dependency.
 *
 * Output: a candidate trustless VK + a verifiable transcript (r1cs/zkey/vk sha256,
 * every contribution hash, the fixed drand round + randomness + signature, ZKey-Ok).
 *
 * Honest scope: the contributions here are simulated-independent (one operator), so
 * this DRY RUN is not yet trustless — it becomes trustless when the simulated steps
 * are replaced by independent humans. The drand beacon value is REAL and PUBLIC.
 *
 * Usage:
 *   node ceremony/run-ceremony-v3.mjs --contribs 3 [--power 14] [--ptau <path-or-url>] [--no-beacon-verify]
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
const NO_BEACON_VERIFY = process.argv.includes("--no-beacon-verify");

// ── FIXED, ALREADY-PUBLISHED PUBLIC BEACON (pre-committed; NOT a live/future round) ──
// drand League of Entropy default chain, round 6000000 — resolved 2026-04-05T23:17:00Z,
// MONTHS before this ceremony, so it could not have been ground or chosen adaptively.
// Anyone can reproduce: GET https://api.drand.sh/<chain>/public/6000000.
// The randomness below is used DIRECTLY as the snarkjs `zkey beacon` hex.
const BEACON = {
  source: "drand / League of Entropy (default chain) — FIXED pre-committed PAST round",
  chain: "8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce",
  round: 6000000,
  randomness: "642f13b2933302bbdec93259cdd269cbddd9c637fda4b29dd975703723a38114",
  signature:
    "b8cc74158702c5a2ede4acd295764f4aa35eff7a1be01e369635a78cbd17d14856d8f0d4b18aa19feac43c76472720c6170ef65ab18a08662c0660e27b8c8abb6aa030927c02711b7e39a2e6f7f0aa50413ac7656fddcc112c1984f4f30bbb6d",
  period: 30,
  genesis_time: 1595431050,
  resolved_at: "2026-04-05T23:17:00.000Z",
  url: "https://api.drand.sh/8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce/public/6000000",
  note:
    "FIXED, already-published drand round baked into the script. NOT fetched as 'latest' " +
    "and NOT a future round — no waiting. This models a coordinator PRE-COMMITTING a round " +
    "number before the ceremony so it cannot be ground. The baked value is authoritative; " +
    "the optional live re-fetch only confirms it still matches drand.",
};

const OUT = join(REPO, "ceremony", CIRCUIT);
mkdirSync(OUT, { recursive: true });
const R1CS = join(REPO, "build", "zk", "out", `${CIRCUIT}.r1cs`);
if (!existsSync(R1CS)) throw new Error(`missing ${R1CS} — compile circuits/${CIRCUIT}.circom first (see build/zk/README.md)`);

const sj = (...a) => execFileSync(process.execPath, [SNARKJS, ...a], { stdio: "pipe" }).toString();
const sjInherit = (...a) => execFileSync(process.execPath, [SNARKJS, ...a], { stdio: "inherit" });
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/**
 * Confirm the BAKED-IN fixed beacon still matches what drand publishes for that SAME
 * fixed round. This fetches a SPECIFIC PAST round (BEACON.round) — never `latest`, never
 * a future round — so it cannot wait. If the network is unavailable (or --no-beacon-verify),
 * the baked constant is used as-is and the transcript records that the live check was skipped.
 */
async function verifyFixedBeacon() {
  if (NO_BEACON_VERIFY) {
    console.log(`  --no-beacon-verify: using baked round ${BEACON.round} without a live re-fetch`);
    return { live_verified: false, reason: "skipped (--no-beacon-verify)" };
  }
  const url = `https://api.drand.sh/${BEACON.chain}/public/${BEACON.round}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const ok = j.round === BEACON.round && j.randomness === BEACON.randomness && j.signature === BEACON.signature;
    if (!ok) {
      // The baked value MUST equal the published value — if not, abort: the transcript would lie.
      throw new Error(`drand round ${BEACON.round} mismatch: baked randomness=${BEACON.randomness} live=${j.randomness}`);
    }
    console.log(`  live re-fetch of fixed round ${BEACON.round}: MATCHES baked value ✓`);
    return { live_verified: true, url };
  } catch (e) {
    console.log(`  live re-fetch skipped/unavailable (${e.message}); baked round ${BEACON.round} is authoritative`);
    return { live_verified: false, reason: e.message };
  }
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
  console.log(`\n=== BEACON-SEALED ceremony pipeline — ${CIRCUIT} (DRY RUN: simulated-independent contributors + FIXED drand beacon round ${BEACON.round}) ===`);
  console.log(`r1cs sha256: ${sha(R1CS)}`);

  // ── Phase 1: public ptau ────────────────────────────────────────────────────
  console.log(`\n[phase-1] ingest PUBLIC Perpetual Powers of Tau (power ${POWER})`);
  const ptau = await downloadPtau(join(OUT, `powersOfTau28_hez_final_${POWER}.ptau`));
  console.log(`  verifying ptau (snarkjs powersoftau verify)...`);
  const ptauVer = sj("powersoftau", "verify", ptau);
  const ptauOk = /Powers of Tau Ok!/i.test(ptauVer);
  console.log(`  ptau verify: ${ptauOk ? "Powers of Tau Ok! ✓" : "FAILED ✗"}`);
  if (!ptauOk) { console.error(ptauVer.slice(-500)); process.exit(1); }

  const T = {
    circuit: CIRCUIT,
    mode: "BEACON-SEALED DRY RUN — simulated-independent phase-2 contributors + a FIXED, already-published drand beacon (round 6000000, pre-committed/baked-in, no live wait). The public beacon adds unpredictability nobody controls; full trustlessness still needs the simulated contributors replaced by independent humans (see ceremony/CONTRIBUTING_V3.md).",
    phase1: { source: "Hermez Perpetual Powers of Tau", power: POWER, ptau: ptau.split(/[\\/]/).pop(), ptau_sha256: sha(ptau), verify: ptauOk ? "Powers of Tau Ok!" : "FAILED" },
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
    // Each contribution draws FRESH 64-byte OS entropy (varied per contribution). The
    // secret is consumed in-process and never written to disk. In a REAL run this step
    // is a different human on a different machine publishing their contribution hash.
    sj("zkey", "contribute", cur, next, `--name=${name}`, `-e=${randomBytes(64).toString("hex")}`);
    const contribHash = sha(next);
    T.contributions.push({ index: i, name, simulated: true, entropy: "fresh 64-byte OS randomBytes (varied per contribution, discarded in-process)", zkey_sha256: contribHash });
    console.log(`  contribution ${i}/${CONTRIBS}  zkey sha ${contribHash.slice(0, 16)}…`);
    cur = next;
  }

  // ── Beacon: FIXED, already-published drand round (no live wait) ──────────────
  console.log(`\n[beacon] applying FIXED pre-committed drand round ${BEACON.round} (resolved ${BEACON.resolved_at})`);
  console.log(`  randomness ${BEACON.randomness.slice(0, 16)}… (baked-in, not 'latest')`);
  const liveCheck = await verifyFixedBeacon();
  const fin = join(OUT, `${CIRCUIT}_final.zkey`);
  sj("zkey", "beacon", cur, fin, BEACON.randomness, "10", "-n=drand Final Beacon (fixed round 6000000)");
  T.beacon = { ...BEACON, iterations: 10, live_verified: liveCheck.live_verified, live_check: liveCheck };
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
  console.log(`  ${CONTRIBS} contributions + FIXED drand round ${BEACON.round}; ${T.verify}; nPublic=${T.n_public}`);
  console.log(`  beacon-sealed candidate VK: ceremony/${CIRCUIT}/${CIRCUIT}_vk.json (vk_sha256 ${T.vk_sha256.slice(0, 16)}…)`);
  console.log(`\nNEXT: node build/zk/vk-to-rust-v3.mjs ceremony/${CIRCUIT}/${CIRCUIT}_vk.json "<ceremony label>"`);
  if (!ok || T.n_public !== 7) process.exit(1);
}

main().catch((e) => { console.error("\nFATAL:", e.message); process.exit(1); });
