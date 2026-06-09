#!/usr/bin/env node
/**
 * Convert a shielded_withdraw_v3 vk.json → a Rust VerificationKey source file in the
 * dark-groth16-core format. Writes crates/dark-groth16-core/src/shielded_withdraw_v3_vk.rs.
 *
 * The generated module exposes `shielded_withdraw_v3_vk()` returning a 7-public-input
 * (8-IC) VerificationKey. `mainnet_ready` stays false (devnet only).
 *
 * Usage:
 *   node vk-to-rust-v3.mjs                 # pilot VK  (build/zk/out/shielded_withdraw_v3_vk.json)
 *   node vk-to-rust-v3.mjs <vk.json> <ceremony-label>
 *                                          # e.g. the trustless ceremony VK
 *
 * Encoding (EIP-197, big-endian):  G1=[x:32,y:32]; G2=[x_im,x_re,y_im,y_re] (imag first).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const VK_PATH = process.argv[2] ?? join(HERE, "out", "shielded_withdraw_v3_vk.json");
const CEREMONY_LABEL = process.argv[3] ??
  "SINGLE-PARTY / DEVNET PILOT / NOT TRUSTLESS. One party ran the entire\n//!                 powers-of-tau + phase-2; whoever ran it could forge withdrawals.\n//!                 The trustless VK comes from the multi-party ceremony (public ptau\n//!                 + multiple independent contributions + drand beacon).";
const OUT_PATH = join(REPO, "crates", "dark-groth16-core", "src", "shielded_withdraw_v3_vk.rs");

const raw = readFileSync(VK_PATH);
const vk = JSON.parse(raw.toString("utf8"));
const vkSha = createHash("sha256").update(raw).digest("hex");

function fpToBytes(decimal) {
  const hex = BigInt(decimal).toString(16).padStart(64, "0");
  const bytes = [];
  for (let i = 0; i < 32; i++) bytes.push(`0x${hex.slice(i * 2, i * 2 + 2)}`);
  return bytes;
}
const g1 = (p) => [...fpToBytes(p[0]), ...fpToBytes(p[1])];
const g2 = (p) => {
  const [xc0, xc1] = p[0];
  const [yc0, yc1] = p[1];
  return [...fpToBytes(xc1), ...fpToBytes(xc0), ...fpToBytes(yc1), ...fpToBytes(yc0)];
};
function rustBytes(bytes, indent = "        ") {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 16) chunks.push(indent + bytes.slice(i, i + 16).join(", "));
  return chunks.join(",\n");
}

const alpha = g1(vk.vk_alpha_1);
const beta = g2(vk.vk_beta_2);
const gamma = g2(vk.vk_gamma_2);
const delta = g2(vk.vk_delta_2);
const icPts = vk.IC.map(g1);

const labels = ["nullifier", "merkle_root", "recipient", "pool_id", "relayer", "fee", "denomination"];
const icRust = icPts
  .map((ic, i) => {
    const lbl = i === 0 ? " — constant term" : ` — public input ${i} (${labels[i - 1] ?? "?"})`;
    return `        // IC[${i}]${lbl}\n        G1Affine {\n            x: [\n${rustBytes(ic.slice(0, 32), "            ")}\n            ],\n            y: [\n${rustBytes(ic.slice(32), "            ")}\n            ],\n        }`;
  })
  .join(",\n");

const g2field = (b, label) =>
  `        ${label}: G2Affine {\n            x_im: [\n${rustBytes(b.slice(0, 32), "            ")}\n            ],\n            x_re: [\n${rustBytes(b.slice(32, 64), "            ")}\n            ],\n            y_im: [\n${rustBytes(b.slice(64, 96), "            ")}\n            ],\n            y_re: [\n${rustBytes(b.slice(96, 128), "            ")}\n            ],\n        }`;

const rust = `//! ShieldedWithdraw v3 Groth16 verifying key for dark_shielded_pool (DARK RELAY RAIL).
//!
//! Generated from: ${VK_PATH.split(/[\\/]/).slice(-3).join("/")}
//! Circuit:        shielded_withdraw_v3.circom — Poseidon commitment + nullifier
//!                 + 20-level Poseidon Merkle membership, recipient + pool_id + relayer
//!                 bound, in-proof relayer fee (fee <= MAX_FEE, payout = denom - fee).
//! Curve:          BN254 (bn128)        Protocol: groth16
//! Public inputs:  7 (nullifier, merkle_root, recipient, pool_id, relayer, fee,
//!                    denomination)  [circuit order]
//! Ceremony:       ${CEREMONY_LABEL}
//! VK SHA-256:     ${vkSha}
//!
//! Do not edit manually — regenerate with: node build/zk/vk-to-rust-v3.mjs

use crate::{G1Affine, G2Affine, VerificationKey};

/// Number of public inputs for shielded_withdraw_v3 (nullifier, merkle_root,
/// recipient, pool_id, relayer, fee, denomination). gamma_abc.len() == NR + 1.
pub const NR_PUBLIC_INPUTS: usize = ${vk.nPublic};

/// ShieldedWithdraw v3 verifying key.
///
/// \`mainnet_ready = false\`: devnet only. The on-chain verifier gates acceptance on
/// a separate flag, never on this being true.
pub fn shielded_withdraw_v3_vk() -> VerificationKey {
    VerificationKey {
        alpha_g1: G1Affine {
            x: [
${rustBytes(alpha.slice(0, 32))}
            ],
            y: [
${rustBytes(alpha.slice(32))}
            ],
        },
${g2field(beta, "beta_g2")},
${g2field(gamma, "gamma_g2")},
${g2field(delta, "delta_g2")},
        gamma_abc: vec![
${icRust}
        ],
        // Devnet only — must stay false.
        mainnet_ready: false,
    }
}
`;

writeFileSync(OUT_PATH, rust);
console.log(`Written: ${OUT_PATH}`);
console.log(`nPublic: ${vk.nPublic}  IC points: ${icPts.length}  vk_sha256: ${vkSha}`);
