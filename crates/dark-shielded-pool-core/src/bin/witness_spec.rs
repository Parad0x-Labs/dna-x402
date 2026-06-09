//! witness_spec — off-chain prover-spec generator for shielded_withdraw_v2.
//!
//! Single source of truth for the e2e: builds the SAME incremental Poseidon tree
//! the on-chain program builds (via dark-poseidon-real, which byte-matches both
//! circomlib and the sol_poseidon syscall), derives the Merkle path for the note
//! being spent, computes commitment + nullifier, and emits a JSON spec the node
//! prover (`build/zk/prove.mjs`) feeds straight into snarkjs.
//!
//! Because the tree/commitment/nullifier here are computed with the EXACT hash
//! the circuit uses, the circuit's public signals (merkle_root, nullifier) must
//! equal the hex values printed here. The node prover asserts that; the on-chain
//! verifier then re-checks the proof against syscall-computed state. Agreement
//! across all three = on-chain Poseidon == circuit Poseidon, confirmed in-VM.
//!
//! Input  (argv[1]): scenario JSON
//!   {
//!     "poolKeyHex": "<64 hex>",        // pool_config PDA bytes (BE) — reduced mod r
//!     "recipientHex": "<64 hex>",      // recipient wallet bytes (BE) — reduced mod r
//!     "spendIndex": <u64>,             // which leaf is being withdrawn
//!     "secretsHex": ["<64 hex>", ...]  // every deposited note secret, in order
//!   }
//! Output (argv[2]): prover spec JSON (see prove.mjs) PLUS an `expected` block
//!   with the hex field-element values the on-chain program will use.

use dark_poseidon_real::{commitment, nullifier, reduce_be_to_field, u64_to_be32, BN254_FR};
use dark_shielded_pool_core::{IncrementalTree, TREE_DEPTH};
use std::fs;

fn from_hex32(s: &str) -> [u8; 32] {
    let v = hex::decode(s.trim_start_matches("0x")).expect("valid hex");
    assert_eq!(v.len(), 32, "expected 32-byte hex");
    let mut out = [0u8; 32];
    out.copy_from_slice(&v);
    out
}

/// 32-byte big-endian → decimal string (for snarkjs circuit input).
fn be_to_dec(b: &[u8; 32]) -> String {
    // simple base-256 → base-10 via repeated /10 is overkill; use u128 chunks.
    // Build the number with a small bignum (Vec<u32> base 1e9) to avoid extra deps.
    let mut num: Vec<u32> = vec![0]; // little-endian base-1e9 limbs
    for &byte in b.iter() {
        // num = num * 256 + byte
        let mut carry = byte as u64;
        for limb in num.iter_mut() {
            let cur = *limb as u64 * 256 + carry;
            *limb = (cur % 1_000_000_000) as u32;
            carry = cur / 1_000_000_000;
        }
        while carry > 0 {
            num.push((carry % 1_000_000_000) as u32);
            carry /= 1_000_000_000;
        }
    }
    let mut s = String::new();
    for (i, limb) in num.iter().rev().enumerate() {
        if i == 0 {
            s.push_str(&limb.to_string());
        } else {
            s.push_str(&format!("{:09}", limb));
        }
    }
    s
}

fn main() {
    // light-poseidon builds large parameter tables on the stack; the incremental
    // tree + path rebuild also use sizeable stack arrays. Run on an 8 MB stack so
    // the default 1 MB Windows main-thread stack does not overflow.
    std::thread::Builder::new()
        .stack_size(8 * 1024 * 1024)
        .spawn(run)
        .expect("spawn worker")
        .join()
        .expect("worker panicked");
}

fn run() {
    let args: Vec<String> = std::env::args().collect();
    let spec_in = &args[1];
    let spec_out = &args[2];

    let scenario: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(spec_in).expect("read scenario")).expect("parse");

    let pool_key_raw = from_hex32(scenario["poolKeyHex"].as_str().unwrap());
    let recipient_raw = from_hex32(scenario["recipientHex"].as_str().unwrap());
    let spend_index = scenario["spendIndex"].as_u64().unwrap();
    let secrets: Vec<[u8; 32]> = scenario["secretsHex"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| from_hex32(v.as_str().unwrap()))
        .collect();

    // Pubkeys → canonical field elements (< r). This is the SAME reduction the
    // on-chain program applies before using them as Poseidon inputs / public scalars.
    let pool_key_field = reduce_be_to_field(&pool_key_raw);
    let recipient_field = reduce_be_to_field(&recipient_raw);

    // Build the incremental tree exactly as the chain does, collecting leaves.
    let mut tree = IncrementalTree::new();
    let mut leaves: Vec<[u8; 32]> = Vec::new();
    for (i, s) in secrets.iter().enumerate() {
        let c = commitment(s, i as u64);
        leaves.push(c);
        tree.insert(c);
    }

    let secret = secrets[spend_index as usize];
    let leaf_commitment = commitment(&secret, spend_index);

    // Merkle path for the spent note against the final root.
    let (path_elements, path_index, root) = IncrementalTree::path_for(&leaves, spend_index);
    assert_eq!(root, tree.root, "rebuilt root must equal incremental root");
    assert_eq!(
        leaves[spend_index as usize], leaf_commitment,
        "commitment mismatch"
    );

    let null = nullifier(&secret, &pool_key_field);

    // Build the prover spec (decimal strings for snarkjs).
    let pe_dec: Vec<String> = path_elements.iter().map(be_to_dec).collect();
    let pi_dec: Vec<u8> = path_index.to_vec();

    let out = serde_json::json!({
        "secret": be_to_dec(&secret),
        "leafIndex": spend_index,
        "poolKeyField": be_to_dec(&pool_key_field),
        "recipientField": be_to_dec(&recipient_field),
        "merkleRoot": be_to_dec(&root),
        "nullifier": be_to_dec(&null),
        "pathElements": pe_dec,
        "pathIndex": pi_dec,
        // Every leaf commitment, in deposit order — the client deposits these.
        "commitmentsHex": leaves.iter().map(hex::encode).collect::<Vec<_>>(),
        // Hex field-element values the on-chain program will pass as public inputs.
        // (recipient/pool reduced mod r; the circuit and the chain agree.)
        "expected": {
            "treeDepth": TREE_DEPTH,
            "leafCommitmentHex": hex::encode(leaf_commitment),
            "rootHex": hex::encode(root),
            "nullifierHex": hex::encode(null),
            "recipientFieldHex": hex::encode(recipient_field),
            "poolIdFieldHex": hex::encode(pool_key_field),
            "recipientRawHex": hex::encode(recipient_raw),
            "poolKeyRawHex": hex::encode(pool_key_raw),
            "bn254FrHex": hex::encode(BN254_FR),
            "u64LeafIndexBeHex": hex::encode(u64_to_be32(spend_index)),
        }
    });

    fs::write(spec_out, serde_json::to_string_pretty(&out).unwrap() + "\n").expect("write spec");
    println!("witness spec written: {}", spec_out);
    println!("  root       {}", hex::encode(root));
    println!("  nullifier  {}", hex::encode(null));
    println!("  recipient  {} (reduced)", hex::encode(recipient_field));
    println!("  pool_id    {} (reduced)", hex::encode(pool_key_field));
}
