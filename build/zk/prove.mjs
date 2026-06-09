#!/usr/bin/env node
/**
 * Off-chain prover for shielded_withdraw_v2.
 *
 * Given a withdrawal spec JSON on argv[2] with fields:
 *   { secret, leafIndex, poolKeyField, recipientField, merkleRoot,
 *     pathElements: [..20 dec..], pathIndex: [..20 0/1..] }   (all decimal strings)
 * builds the witness, generates a real Groth16 proof, verifies it locally with
 * snarkjs, and writes argv[3] = an output JSON containing:
 *   { proof256Hex, publicInputsHex: {nullifier,merkleRoot,recipient,poolId},
 *     publicSignalsDec, commitmentDec }
 * encoded for the on-chain dark-groth16-core verifier (EIP-197 byte order).
 *
 * The on-chain public-input ORDER must match the circuit's `public [...]` list:
 *   shielded_withdraw_v2.circom: public [nullifier, merkle_root, recipient, pool_id]
 * snarkjs orders public signals by signal declaration order within `main`, which
 * for this circuit is: nullifier, merkle_root, recipient, pool_id.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNARKJS = join(HERE, "node_modules", "snarkjs", "build", "cli.cjs");
const WASM = join(HERE, "out", "shielded_withdraw_v2_js", "shielded_withdraw_v2.wasm");
const ZKEY = join(HERE, "ceremony", "shielded_withdraw_v2_final.zkey");
const VK = join(HERE, "out", "shielded_withdraw_v2_vk.json");

const specPath = process.argv[2];
const outPath = process.argv[3];
if (!specPath || !outPath) { console.error("usage: node prove.mjs <spec.json> <out.json>"); process.exit(1); }

const spec = JSON.parse(readFileSync(specPath, "utf8"));

// circuit input — names must match the circom signal names exactly
const input = {
  nullifier: spec.nullifier,
  merkle_root: spec.merkleRoot,
  recipient: spec.recipientField,
  pool_id: spec.poolKeyField,           // pool_id public == pool_key_field private (same PDA)
  secret: spec.secret,
  leaf_index: String(spec.leafIndex),
  pool_key_field: spec.poolKeyField,
  path_elements: spec.pathElements,
  path_index: spec.pathIndex,
};

const tmp = mkdtempSync(join(tmpdir(), "swv2-prove-"));
const inputPath = join(tmp, "input.json");
const proofPath = join(tmp, "proof.json");
const publicPath = join(tmp, "public.json");
writeFileSync(inputPath, JSON.stringify(input));

const run = (...a) => execFileSync(process.execPath, [SNARKJS, ...a], { stdio: "pipe" }).toString();

// 1. full prove (witness + proof)
run("groth16", "fullprove", inputPath, WASM, ZKEY, proofPath, publicPath);

// 2. local verify (keystone: circuit + zkey self-consistent)
const verOut = run("groth16", "verify", VK, publicPath, proofPath);
const localOk = /OK!/.test(verOut);
if (!localOk) { console.error("LOCAL snarkjs verify FAILED:\n" + verOut); process.exit(1); }

const proof = JSON.parse(readFileSync(proofPath, "utf8"));
const pub = JSON.parse(readFileSync(publicPath, "utf8")); // [nullifier, merkle_root, recipient, pool_id]

// ── encoders (match scripts/zk/03-devnet-bn254-gate-e2e.mjs) ────────────────
const dec2be32 = (d) => {
  const hex = BigInt(d).toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
};
const g1 = (p) => Buffer.concat([dec2be32(p[0]), dec2be32(p[1])]);            // [x,y]
const g2 = (p) => { const [xc0, xc1] = p[0], [yc0, yc1] = p[1];
  return Buffer.concat([dec2be32(xc1), dec2be32(xc0), dec2be32(yc1), dec2be32(yc0)]); }; // EIP-197 imag first

const proof256 = Buffer.concat([g1(proof.pi_a), g2(proof.pi_b), g1(proof.pi_c)]);
if (proof256.length !== 256) throw new Error(`proof bytes ${proof256.length} != 256`);

const out = {
  localVerify: "OK",
  proof256Hex: proof256.toString("hex"),
  publicSignalsDec: pub,
  publicInputsHex: {
    nullifier: dec2be32(pub[0]).toString("hex"),
    merkleRoot: dec2be32(pub[1]).toString("hex"),
    recipient: dec2be32(pub[2]).toString("hex"),
    poolId: dec2be32(pub[3]).toString("hex"),
  },
};
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
rmSync(tmp, { recursive: true, force: true });
console.log("LOCAL snarkjs verify: OK");
console.log("public signals:", JSON.stringify(pub));
