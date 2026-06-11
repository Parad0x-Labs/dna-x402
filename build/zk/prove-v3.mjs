#!/usr/bin/env node
/**
 * Off-chain prover for shielded_withdraw_v3 (DARK RELAY RAIL).
 *
 * Given a withdrawal spec JSON on argv[2] (decimal strings) with the v2 fields plus:
 *   { ..., relayerField, fee, denomination }
 * builds the witness, generates a real Groth16 proof, verifies it locally with
 * snarkjs, and writes argv[3] = output JSON:
 *   { proof256Hex, publicSignalsDec,
 *     publicInputsHex: {nullifier,merkleRoot,recipient,poolId,relayer,fee,denomination} }
 * encoded for the on-chain dark-groth16-core verifier (EIP-197 byte order).
 *
 * The on-chain public-input ORDER must match the circuit's `public [...]` list:
 *   public [nullifier, merkle_root, recipient, pool_id, relayer, fee, denomination]
 *
 * VK SELECTION (SWV3_VK_MODE env, default "ceremony"):
 *   - ceremony : the BEACON-SEALED multi-contribution key under
 *       ceremony/shielded_withdraw_v3/ (alpha_g1.x=2d4d9aa7…). This is the VK the
 *       DEPLOYED devnet pool program embeds, so it is the ONLY mode whose proofs the
 *       program accepts on-chain. Default.
 *   - pilot    : the single-party key under build/zk/ (alpha_g1.x=2f881452…). Proofs
 *       verify LOCALLY but the deployed program rejects them with Custom(4)=ProofInvalid,
 *       so this mode is REFUSED here (exit 1) unless the caller forces explicit paths.
 * SWV3_ZKEY / SWV3_VK env override the resolved zkey/vk paths directly (highest
 * priority — e.g. for a local-only pilot proof, set both to the pilot paths).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const SNARKJS = join(HERE, "node_modules", "snarkjs", "build", "cli.cjs");
const WASM = join(HERE, "out", "shielded_withdraw_v3_js", "shielded_withdraw_v3.wasm");

// zkey/vk source — see header. ceremony (default) is what the deployed program embeds;
// pilot is refused unless explicit SWV3_ZKEY/SWV3_VK are set.
const VK_SOURCES = {
  ceremony: {
    zkey: join(REPO, "ceremony", "shielded_withdraw_v3", "shielded_withdraw_v3_final.zkey"),
    vk: join(REPO, "ceremony", "shielded_withdraw_v3", "shielded_withdraw_v3_vk.json"),
  },
  pilot: {
    zkey: join(HERE, "ceremony", "shielded_withdraw_v3_final.zkey"),
    vk: join(HERE, "out", "shielded_withdraw_v3_vk.json"),
  },
};
const VK_MODE = (process.env.SWV3_VK_MODE ?? "ceremony").toLowerCase();
const explicitZkey = process.env.SWV3_ZKEY, explicitVk = process.env.SWV3_VK;
const hasExplicit = !!(explicitZkey || explicitVk);
if (!hasExplicit && VK_MODE === "pilot") {
  console.error(
    "prove-v3.mjs: vk-mode=pilot is refused.\n" +
    "  The deployed devnet pool program embeds the CEREMONY verifying key; pilot\n" +
    "  (single-party) proofs are rejected on-chain with Custom(4)=ProofInvalid.\n" +
    "  Use vk-mode=ceremony (the default). For a local-only pilot proof, set BOTH\n" +
    "  SWV3_ZKEY and SWV3_VK to the pilot paths explicitly.");
  process.exit(1);
}
if (!hasExplicit && !(VK_MODE in VK_SOURCES)) {
  console.error(`prove-v3.mjs: unknown SWV3_VK_MODE '${VK_MODE}' (expected 'ceremony' or 'pilot')`);
  process.exit(1);
}
const source = VK_SOURCES[VK_MODE] ?? VK_SOURCES.ceremony;
const ZKEY = explicitZkey ?? source.zkey;
const VK = explicitVk ?? source.vk;

const specPath = process.argv[2];
const outPath = process.argv[3];
if (!specPath || !outPath) { console.error("usage: node prove-v3.mjs <spec.json> <out.json>"); process.exit(1); }
if (!existsSync(ZKEY)) { console.error(`missing zkey: ${ZKEY}`); process.exit(1); }

const spec = JSON.parse(readFileSync(specPath, "utf8"));

// circuit input — names must match the circom signal names exactly
const denomination = spec.denomination;
const fee = spec.fee;
const payout = (BigInt(denomination) - BigInt(fee)).toString();
const input = {
  nullifier: spec.nullifier,
  merkle_root: spec.merkleRoot,
  recipient: spec.recipientField,
  pool_id: spec.poolKeyField,
  relayer: spec.relayerField,
  fee: String(fee),
  denomination: String(denomination),
  secret: spec.secret,
  leaf_index: String(spec.leafIndex),
  pool_key_field: spec.poolKeyField,
  path_elements: spec.pathElements,
  path_index: spec.pathIndex,
  payout_recipient: payout,
};

const tmp = mkdtempSync(join(tmpdir(), "swv3-prove-"));
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
const pub = JSON.parse(readFileSync(publicPath, "utf8")); // [null, root, recip, pool, relayer, fee, denom]

const dec2be32 = (d) => {
  const hex = BigInt(d).toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
};
const g1 = (p) => Buffer.concat([dec2be32(p[0]), dec2be32(p[1])]);
const g2 = (p) => { const [xc0, xc1] = p[0], [yc0, yc1] = p[1];
  return Buffer.concat([dec2be32(xc1), dec2be32(xc0), dec2be32(yc1), dec2be32(yc0)]); };

const proof256 = Buffer.concat([g1(proof.pi_a), g2(proof.pi_b), g1(proof.pi_c)]);
if (proof256.length !== 256) throw new Error(`proof bytes ${proof256.length} != 256`);

// last two path segments — ceremony & pilot share the basename, so the parent dir
// is what actually distinguishes them (e.g. shielded_withdraw_v3/...final.zkey).
const tail2 = (p) => p.split(/[\\/]/).slice(-2).join("/");
const out = {
  localVerify: "OK",
  vkMode: hasExplicit ? "explicit" : VK_MODE,
  zkey: tail2(ZKEY),
  vk: tail2(VK),
  proof256Hex: proof256.toString("hex"),
  publicSignalsDec: pub,
  publicInputsHex: {
    nullifier: dec2be32(pub[0]).toString("hex"),
    merkleRoot: dec2be32(pub[1]).toString("hex"),
    recipient: dec2be32(pub[2]).toString("hex"),
    poolId: dec2be32(pub[3]).toString("hex"),
    relayer: dec2be32(pub[4]).toString("hex"),
    fee: dec2be32(pub[5]).toString("hex"),
    denomination: dec2be32(pub[6]).toString("hex"),
  },
};
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
rmSync(tmp, { recursive: true, force: true });
console.log("LOCAL snarkjs verify: OK");
console.log("public signals:", JSON.stringify(pub));
