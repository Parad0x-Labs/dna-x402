//! Host-side verification of a real shielded_withdraw_v3 proof against the
//! generated VK, using the SAME `groth16_verify` code path the on-chain program
//! runs. Off-chain mirror of the on-chain check: if it passes here it will pass the
//! `sol_alt_bn128_group_op` syscall on devnet.
//!
//! Usage: cargo run -p dark-groth16-core --example verify_swv3 -- <proof_out.json>
//!
//! proof_out.json (from build/zk/prove-v3.mjs) provides:
//!   proof256Hex, publicInputsHex { nullifier, merkleRoot, recipient, poolId,
//!                                  relayer, fee, denomination }
//! in circuit public-input order.

use dark_groth16_core::shielded_withdraw_v3_vk::shielded_withdraw_v3_vk;
use dark_groth16_core::{groth16_verify, proof_from_bytes};

fn hex32(s: &str) -> [u8; 32] {
    let v = hex::decode(s).expect("hex");
    assert_eq!(v.len(), 32);
    let mut a = [0u8; 32];
    a.copy_from_slice(&v);
    a
}

fn main() {
    let path = std::env::args().nth(1).expect("pass proof_out.json path");
    let j: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");

    let proof_bytes = hex::decode(j["proof256Hex"].as_str().unwrap()).expect("proof hex");
    assert_eq!(proof_bytes.len(), 256, "proof must be 256 bytes");
    let mut proof_arr = [0u8; 256];
    proof_arr.copy_from_slice(&proof_bytes);
    let proof = proof_from_bytes(&proof_arr);

    let pi = &j["publicInputsHex"];
    // circuit order: nullifier, merkle_root, recipient, pool_id, relayer, fee, denomination
    let public_inputs = [
        hex32(pi["nullifier"].as_str().unwrap()),
        hex32(pi["merkleRoot"].as_str().unwrap()),
        hex32(pi["recipient"].as_str().unwrap()),
        hex32(pi["poolId"].as_str().unwrap()),
        hex32(pi["relayer"].as_str().unwrap()),
        hex32(pi["fee"].as_str().unwrap()),
        hex32(pi["denomination"].as_str().unwrap()),
    ];

    let vk = shielded_withdraw_v3_vk();
    assert_eq!(
        vk.gamma_abc.len(),
        public_inputs.len() + 1,
        "VK/input count mismatch"
    );

    match groth16_verify(&vk, &proof, &public_inputs) {
        Ok(true) => {
            println!("HOST groth16_verify (v3): VALID");
            println!("  (real alt_bn128 pairing — same code path as on-chain syscall)");
            std::process::exit(0);
        }
        Ok(false) => {
            eprintln!("HOST groth16_verify (v3): INVALID (pairing != 1)");
            std::process::exit(2);
        }
        Err(e) => {
            eprintln!("HOST groth16_verify (v3) ERROR: {e}");
            std::process::exit(3);
        }
    }
}
