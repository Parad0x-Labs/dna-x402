#!/usr/bin/env node
/**
 * circuits/out/track_record_vk.json -> crates/dark-groth16-core/src/track_record_vk.rs
 * Same EIP-197 (imaginary-first) G2 encoding as 02-vk-json-to-rust.mjs. 7 public inputs
 * (epoch is now public — bound on-chain to the clock window for anti-Sybil rate-limiting).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VK_PATH = join(REPO, "circuits", "out", "track_record_vk.json");
const OUT = join(REPO, "crates", "dark-groth16-core", "src", "track_record_vk.rs");
const LABELS = ["root", "min_count", "min_volume", "window_start", "reputation_nullifier", "agent_commitment", "epoch"];

const raw = readFileSync(VK_PATH);
const vk = JSON.parse(raw);
const vkSha = createHash("sha256").update(raw).digest("hex");

const fpToBytes = (d) => {
  const hex = BigInt(d).toString(16).padStart(64, "0");
  const b = []; for (let i = 0; i < 32; i++) b.push(`0x${hex.slice(i * 2, i * 2 + 2)}`); return b;
};
const g1 = (p) => [...fpToBytes(p[0]), ...fpToBytes(p[1])];
const g2 = (p) => { const [xc0, xc1] = p[0], [yc0, yc1] = p[1];
  return [...fpToBytes(xc1), ...fpToBytes(xc0), ...fpToBytes(yc1), ...fpToBytes(yc0)]; }; // imaginary first
const rb = (bytes, ind = "        ") => {
  const out = []; for (let i = 0; i < bytes.length; i += 16) out.push(ind + bytes.slice(i, i + 16).join(", "));
  return out.join(",\n");
};

const alpha = g1(vk.vk_alpha_1), beta = g2(vk.vk_beta_2), gamma = g2(vk.vk_gamma_2), delta = g2(vk.vk_delta_2);
const ic = vk.IC.map(g1);
const icRust = ic.map((p, i) =>
  `    // IC[${i}]${i === 0 ? " — constant term" : ` — public input: ${LABELS[i - 1] ?? "?"}`}\n    G1Affine {\n        x: [\n${rb(p.slice(0, 32))}\n        ],\n        y: [\n${rb(p.slice(32))}\n        ],\n    }`
).join(",\n");

const rust = `//! Track-Record Circuit Groth16 verifying key for dark_reputation_gate.
//!
//! Generated from: circuits/out/track_record_vk.json
//! Circuit:        track_record — Poseidon receipt-Merkle membership x K + count/volume/window + nullifier
//! Curve:          BN254 (bn128)   Protocol: groth16
//! Public inputs:  7 (root, min_count, min_volume, window_start, reputation_nullifier, agent_commitment, epoch)
//! Ceremony:       Single-party (devnet POC, locally-generated pot15). Devnet only.
//!                 Reuse a public Hermez/PSE ptau + multi-party phase-2 before mainnet trust.
//! VK SHA-256:     ${vkSha}
//!
//! Do not edit manually — regenerate with:
//!   node scripts/zk/track-record-vk-to-rust.mjs

use crate::{G1Affine, G2Affine, VerificationKey};

pub const NR_PUBLIC_INPUTS: usize = ${LABELS.length};

pub fn track_record_vk() -> VerificationKey {
    VerificationKey {
        alpha_g1: G1Affine { x: [\n${rb(alpha.slice(0, 32))}\n        ], y: [\n${rb(alpha.slice(32))}\n        ] },
        beta_g2: G2Affine {
            x_im: [\n${rb(beta.slice(0, 32))}\n            ],
            x_re: [\n${rb(beta.slice(32, 64))}\n            ],
            y_im: [\n${rb(beta.slice(64, 96))}\n            ],
            y_re: [\n${rb(beta.slice(96, 128))}\n            ],
        },
        gamma_g2: G2Affine {
            x_im: [\n${rb(gamma.slice(0, 32))}\n            ],
            x_re: [\n${rb(gamma.slice(32, 64))}\n            ],
            y_im: [\n${rb(gamma.slice(64, 96))}\n            ],
            y_re: [\n${rb(gamma.slice(96, 128))}\n            ],
        },
        delta_g2: G2Affine {
            x_im: [\n${rb(delta.slice(0, 32))}\n            ],
            x_re: [\n${rb(delta.slice(32, 64))}\n            ],
            y_im: [\n${rb(delta.slice(64, 96))}\n            ],
            y_re: [\n${rb(delta.slice(96, 128))}\n            ],
        },
        gamma_abc: vec![\n${icRust}
        ],
        mainnet_ready: false,
    }
}
`;
writeFileSync(OUT, rust);
console.log(`Written: crates/dark-groth16-core/src/track_record_vk.rs`);
console.log(`nPublic: ${vk.nPublic}  IC: ${ic.length}  vkSha: ${vkSha.slice(0, 16)}…`);
