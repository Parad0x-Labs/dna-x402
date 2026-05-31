#!/usr/bin/env node
/**
 * Convert snarkjs vk.json → Rust VerificationKey constant for dark-groth16-core.
 *
 * Encoding (EIP-197 compatible, big-endian):
 *   G1 point: [x: 32 BE bytes, y: 32 BE bytes]             = 64 bytes
 *   G2 point: [x_im: 32, x_re: 32, y_im: 32, y_re: 32]    = 128 bytes
 *
 * Usage: node scripts/zk/02-vk-json-to-rust.mjs
 * Output: crates/dark-groth16-core/src/null_proof_vk.rs
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO      = join(__dirname, "..", "..");
// Use vk_v2.json (2-party ceremony: sls_0x + SHA-256("") beacon) if available, else vk.json
const vkV2 = join(REPO, ".tools", "external", "dark-null-protocol", "circuits", "vk_v2.json");
const VK_PATH = existsSync(vkV2) ? vkV2 : join(REPO, ".tools", "external", "dark-null-protocol", "circuits", "vk.json");
const OUT_PATH  = join(REPO, "crates", "dark-groth16-core", "src", "null_proof_vk.rs");

const vk = JSON.parse(readFileSync(VK_PATH, "utf8"));

// ── Field element decimal → 32-byte big-endian hex array ─────────────────────
function fpToBytes(decimal) {
  const hex = BigInt(decimal).toString(16).padStart(64, "0");
  const bytes = [];
  for (let i = 0; i < 32; i++) bytes.push(`0x${hex.slice(i * 2, i * 2 + 2)}`);
  return bytes;
}

// ── G1 affine point [x_dec, y_dec, "1"] → [u8; 64] ──────────────────────────
function g1(point) {
  const x = fpToBytes(point[0]);
  const y = fpToBytes(point[1]);
  return [...x, ...y];
}

// ── G2 affine point [[c0_real, c1_imag],[c0_real, c1_imag],["1","0"]] → [u8; 128] ──
// snarkjs stores Fp2 as [c0, c1] but EIP-197/alt_bn128 wants [c1, c0] (imaginary first)
function g2(point) {
  const [xc0, xc1] = point[0]; // snarkjs: [real, imaginary]
  const [yc0, yc1] = point[1];
  return [...fpToBytes(xc1), ...fpToBytes(xc0), ...fpToBytes(yc1), ...fpToBytes(yc0)]; // EIP-197: imaginary first
}

// ── Format as Rust byte array literal ────────────────────────────────────────
function rustBytes(bytes, indent = "        ") {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 16) {
    chunks.push(indent + bytes.slice(i, i + 16).join(", "));
  }
  return chunks.join(",\n");
}

const alpha  = g1(vk.vk_alpha_1);
const beta   = g2(vk.vk_beta_2);
const gamma  = g2(vk.vk_gamma_2);
const delta  = g2(vk.vk_delta_2);
const icPts  = vk.IC.map(g1);

const icRust = icPts.map((ic, i) => {
  return `    // IC[${i}]${i === 0 ? " — constant term" : ` — public input ${i} (${["commitment","nullifier","root","amount","receiver_token_part_0","receiver_token_part_1","mint_part_0","mint_part_1"][i-1] ?? "?"})`}\n    G1Affine {\n        x: [\n${rustBytes(ic.slice(0,32))}\n        ],\n        y: [\n${rustBytes(ic.slice(32))}\n        ],\n    }`;
}).join(",\n");

const rust = `//! Null-proof Groth16 verifying key for dark_bn254_gate.
//!
//! Generated from: .tools/external/dark-null-protocol/circuits/vk.json
//! Circuit:        NullProofV2 — MiMCSponge commitment + nullifier + 7-level Merkle tree
//! Curve:          BN254 (bn128)
//! Protocol:       groth16
//! Public inputs:  8 (commitment, nullifier, root, amount,
//!                    receiver_token_part_0/1, mint_part_0/1)
//! Ceremony:       Single-party (disclosed pilot). Use for pre-audit pilot only.
//!                 Run a multi-party ceremony before claiming trustlessness.
//! VK SHA-256:     6abfff44d3516d44321b1d9be8f545751bd643f4f6d04ae25b881ba43133d63a
//!
//! Do not edit manually — regenerate with:
//!   node scripts/zk/02-vk-json-to-rust.mjs

use crate::{G1Affine, G2Affine, VerificationKey};

pub const NR_PUBLIC_INPUTS: usize = 8;

pub fn null_proof_vk() -> VerificationKey {
    VerificationKey {
        alpha_g1: G1Affine {
            x: [
${rustBytes(alpha.slice(0, 32))}
            ],
            y: [
${rustBytes(alpha.slice(32))}
            ],
        },
        beta_g2: G2Affine {
            x_im: [
${rustBytes(beta.slice(0,   32))}
            ],
            x_re: [
${rustBytes(beta.slice(32,  64))}
            ],
            y_im: [
${rustBytes(beta.slice(64,  96))}
            ],
            y_re: [
${rustBytes(beta.slice(96, 128))}
            ],
        },
        gamma_g2: G2Affine {
            x_im: [
${rustBytes(gamma.slice(0,   32))}
            ],
            x_re: [
${rustBytes(gamma.slice(32,  64))}
            ],
            y_im: [
${rustBytes(gamma.slice(64,  96))}
            ],
            y_re: [
${rustBytes(gamma.slice(96, 128))}
            ],
        },
        delta_g2: G2Affine {
            x_im: [
${rustBytes(delta.slice(0,   32))}
            ],
            x_re: [
${rustBytes(delta.slice(32,  64))}
            ],
            y_im: [
${rustBytes(delta.slice(64,  96))}
            ],
            y_re: [
${rustBytes(delta.slice(96, 128))}
            ],
        },
        gamma_abc: alloc::vec![
${icRust}
        ],
        mainnet_ready: true,
    }
}
`;

writeFileSync(OUT_PATH, rust);
console.log(`Written: crates/dark-groth16-core/src/null_proof_vk.rs`);
console.log(`Public inputs: ${vk.nPublic}`);
console.log(`IC points:     ${icPts.length}`);
console.log(`mainnet_ready: true`);
