#!/usr/bin/env node
/**
 * Single-party Groth16 trusted setup for shielded_withdraw_v3 (DARK RELAY RAIL).
 *
 * DEVNET PILOT / DRY-RUN ONLY — NOT TRUSTLESS. One party runs every step, so
 * whoever runs it could forge withdrawals. Acceptable ONLY to prove the v3
 * machinery on devnet (a real circom proof, with relayer+fee binding, verifying
 * against syscall-computed on-chain state). The TRUSTLESS verifying key comes from
 * the multi-party ceremony in ceremony/run-ceremony-v3.mjs (public ptau + multiple
 * independent contributions + a drand beacon) — see ceremony/README.md.
 *
 * Entropy (toxic waste) is generated here and NEVER written to a committed file.
 * The resulting .zkey + exported VK ARE safe to commit.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNARKJS = join(HERE, "node_modules", "snarkjs", "build", "cli.cjs");
const OUT = join(HERE, "out");
const CEREMONY = join(HERE, "ceremony");
mkdirSync(CEREMONY, { recursive: true });

const R1CS = join(OUT, "shielded_withdraw_v3.r1cs");
if (!existsSync(R1CS)) throw new Error(`missing ${R1CS} — compile the circuit first`);

const POWER = 13; // 2^13 = 8192 >= 5676 non-linear constraints
const sj = (...a) => execFileSync(process.execPath, [SNARKJS, ...a], { stdio: "inherit" });
const sjq = (...a) => execFileSync(process.execPath, [SNARKJS, ...a], { stdio: "pipe" }).toString();
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const pot0 = join(CEREMONY, `pot${POWER}_v3_0000.ptau`);
const pot1 = join(CEREMONY, `pot${POWER}_v3_0001.ptau`);
const potFinal = join(CEREMONY, `pot${POWER}_v3_final.ptau`);
const zkey0 = join(CEREMONY, "shielded_withdraw_v3_0000.zkey");
const zkeyFinal = join(CEREMONY, "shielded_withdraw_v3_final.zkey");
const vkJson = join(OUT, "shielded_withdraw_v3_vk.json");

console.log(`\n=== single-party trusted setup — shielded_withdraw_v3 (DEVNET PILOT, NOT TRUSTLESS) ===`);
console.log(`r1cs sha256: ${sha(R1CS)}`);

console.log(`\n[1/7] powersOfTau new (bn128, power ${POWER})`);
sj("powersoftau", "new", "bn128", String(POWER), pot0, "-v");

console.log(`\n[2/7] powersOfTau contribute (random entropy — NOT persisted)`);
sj("powersoftau", "contribute", pot0, pot1, "--name=devnet-pilot-v3-1", `-e=${randomBytes(64).toString("hex")}`);

console.log(`\n[3/7] preparePhase2`);
sj("powersoftau", "prepare", "phase2", pot1, potFinal, "-v");

console.log(`\n[4/7] groth16 setup (r1cs + ptau -> 0000.zkey)`);
sj("groth16", "setup", R1CS, potFinal, zkey0);

console.log(`\n[5/7] zkey contribute (single-party phase-2 — random entropy, NOT persisted)`);
sj("zkey", "contribute", zkey0, zkeyFinal, "--name=devnet-pilot-v3-phase2", `-e=${randomBytes(64).toString("hex")}`);

console.log(`\n[6/7] zkey export verificationkey`);
sj("zkey", "export", "verificationkey", zkeyFinal, vkJson);

console.log(`\n[7/7] zkey verify (sanity)`);
const ver = sjq("zkey", "verify", R1CS, potFinal, zkeyFinal);
const ok = /ZKey Ok!/.test(ver);
console.log(ok ? "  ZKey Ok!" : "  ZKEY VERIFY FAILED");

const vk = JSON.parse(readFileSync(vkJson, "utf8"));
console.log(`\nVK nPublic: ${vk.nPublic}  (expected 7)`);
console.log(`final zkey sha256: ${sha(zkeyFinal)}`);
console.log(`vk.json    sha256: ${sha(vkJson)}`);

writeFileSync(join(CEREMONY, "transcript_v3.json"), JSON.stringify({
  circuit: "shielded_withdraw_v3",
  mode: "single-party / devnet pilot / NOT trustless",
  power: POWER,
  r1cs_sha256: sha(R1CS),
  zkey_final_sha256: sha(zkeyFinal),
  vk_sha256: sha(vkJson),
  n_public: vk.nPublic,
  verify: ok ? "ZKey Ok!" : "FAILED",
  note: "Entropy (toxic waste) generated in-process and never written to disk. The TRUSTLESS VK comes from ceremony/run-ceremony-v3.mjs (public ptau + multiple independent contributions + drand beacon).",
  generatedAt: new Date().toISOString(),
}, null, 2) + "\n");

if (!ok || vk.nPublic !== 7) process.exit(1);
console.log(`\nDONE. zkey: ${zkeyFinal}\n     vk:   ${vkJson}`);
