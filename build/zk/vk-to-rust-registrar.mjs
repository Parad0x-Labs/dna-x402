#!/usr/bin/env node
/**
 * Convert a registrar vk.json -> crates/dark-groth16-core/src/registrar_vk.rs
 * in the dark-groth16-core VerificationKey format. 3 public inputs (4 IC).
 * Encoding (EIP-197, big-endian): G1=[x:32,y:32]; G2=[x_im,x_re,y_im,y_re] (imag first).
 * Usage: node build/zk/vk-to-rust-registrar.mjs <vk.json> [label]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const VK_PATH = process.argv[2];
if (!VK_PATH) { console.error("usage: node vk-to-rust-registrar.mjs <vk.json> [label]"); process.exit(1); }
const LABEL = process.argv[3] ?? "single-party devnet setup (regenerated)";
const OUT_PATH = join(REPO, "crates", "dark-groth16-core", "src", "registrar_vk.rs");

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
const labels = ["name", "commitment", "action_hash"];
const icRust = icPts.map((ic, i) => {
  const lbl = i === 0 ? " — constant term" : ` — public input ${i} (${labels[i - 1] ?? "?"})`;
  return `        // IC[${i}]${lbl}\n        G1Affine {\n            x: [\n${rustBytes(ic.slice(0, 32), "            ")}\n            ],\n            y: [\n${rustBytes(ic.slice(32), "            ")}\n            ],\n        }`;
}).join(",\n");

const g2field = (b, label) =>
  `        ${label}: G2Affine {\n            x_im: [\n${rustBytes(b.slice(0, 32), "            ")}\n            ],\n            x_re: [\n${rustBytes(b.slice(32, 64), "            ")}\n            ],\n            y_im: [\n${rustBytes(b.slice(64, 96), "            ")}\n            ],\n            y_re: [\n${rustBytes(b.slice(96, 128), "            ")}\n            ],\n        }`;

const rust = `//! Registrar Groth16 verifying key for dark_registrar (anonymous .null ownership).
//!
//! Generated from: ${VK_PATH.split(/[\\/]/).slice(-1).join("/")}
//! Circuit:        registrar.circom — Poseidon(secret,name)==commitment (anonymous .null ownership).
//!                 action_hash = Poseidon(domain, payload, seq) bound as a public input.
//! Curve:          BN254 (bn128)        Protocol: groth16
//! Public inputs:  3 (name, commitment, action_hash) [circuit order]
//! Ceremony:       ${LABEL}
//! VK SHA-256:     ${vkSha}
//!
//! Do not edit manually — regenerate with: node build/zk/vk-to-rust-registrar.mjs <vk.json>

use crate::{G1Affine, G2Affine, VerificationKey};

/// Number of public inputs for the registrar circuit (name, commitment, action_hash).
/// gamma_abc.len() == NR + 1.
pub const NR_PUBLIC_INPUTS: usize = ${vk.nPublic};

/// Registrar verifying key. mainnet_ready=false (devnet only); the on-chain verifier
/// gates acceptance on a separate flag, never on this being true.
pub fn registrar_vk() -> VerificationKey {
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
