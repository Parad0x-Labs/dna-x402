// Convert verification_key.json to Rust format for Solana program

import fs from 'fs';

const vk = JSON.parse(fs.readFileSync('../circuits/verification_key.json', 'utf8'));

// Convert BigInt arrays to hex strings
function bigintToHex(arr) {
    return arr.map(x => '0x' + BigInt(x).toString(16).padStart(64, '0'));
}

const rustCode = `// Auto-generated from verification_key.json
// Do not edit manually

use ark_bn254::{G1Affine, G2Affine, Fq, Fq2};
use ark_serialize::CanonicalDeserialize;

pub const NR_PUBINPUTS: usize = ${vk.nPublic};

pub const VERIFYING_KEY: groth16_solana::groth16::VerifyingKey = groth16_solana::groth16::VerifyingKey {
    nr_pubinputs: NR_PUBINPUTS,
    vk_alpha_g1: [
        ${bigintToHex(vk.vk_alpha_1).join(',\n        ')}
    ],
    vk_beta_g2: [
        ${bigintToHex([...vk.vk_beta_2[0], ...vk.vk_beta_2[1]]).join(',\n        ')}
    ],
    vk_gamma_g2: [
        ${bigintToHex([...vk.vk_gamma_2[0], ...vk.vk_gamma_2[1]]).join(',\n        ')}
    ],
    vk_delta_g2: [
        ${bigintToHex([...vk.vk_delta_2[0], ...vk.vk_delta_2[1]]).join(',\n        ')}
    ],
    vk_ic: &[
        ${vk.IC.map(ic => `[${bigintToHex(ic).join(', ')}]`).join(',\n        ')}
    ],
};`;

fs.writeFileSync('../src/verifying_key.rs', rustCode);
console.log('✅ Converted verification_key.json to src/verifying_key.rs');
