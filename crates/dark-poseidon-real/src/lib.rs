//! Real circomlib-compatible BN254 Poseidon for the Dark Null shielded pool.
//!
//! # Why this crate exists
//!
//! The legacy `dark-poseidon-bn254` / `dark-poseidon-safe` crates compute
//! "Poseidon" as **SHA-256** (`IS_STUB = true`). The circom circuits
//! (`circuits/shielded_withdraw_v2.circom`, `track_record.circom`,
//! `x402_access.circom`) use **real circomlib Poseidon**. A real Groth16 proof
//! produced by those circuits can therefore NEVER verify against on-chain
//! SHA-256 hashes — the shielded pool was theater.
//!
//! This crate computes the **real** BN254 Poseidon via Light Protocol's
//! [`light-poseidon`], which byte-matches circomlib's `poseidon.circom`. The
//! hash functions here mirror the EXACT arity, input order, and domain
//! construction the circuits use, so on-chain hashing matches circuit proofs.
//!
//! # Circuit hash constructions (from `circuits/shielded_withdraw_v2.circom`)
//!
//! ```text
//! commitment  = Poseidon(3)(DOMAIN_COMMIT=1, secret,  leaf_index)      // lines 122-126
//! nullifier   = Poseidon(3)(DOMAIN_NULLIF=2, secret,  pool_key_field)  // lines 137-141
//! merkle_node = Poseidon(2)(left, right)                               // lines 87-99
//! ```
//!
//! The domain tags are **leading field-element inputs** (the circom literals
//! `1` and `2`), NOT byte prefixes and NOT constants added to the digest. That
//! is the single fact the legacy stub got wrong, and the reason a real proof
//! could never verify.
//!
//! # Encoding
//!
//! All field elements are 32-byte **big-endian** canonical BN254 Fr values,
//! matching `light-poseidon`'s `hash_bytes_be` and circomlibjs's
//! `F.toObject(...)` big-endian encoding. `u64` convenience inputs
//! (`leaf_index`) are zero-extended big-endian into 32 bytes.
//!
//! `IS_STUB = false`, `MAINNET_READY = false` (devnet/library only, unaudited).

// Domain tags — must equal the circom `var DOMAIN_COMMIT` / `DOMAIN_NULLIF`.
// These are FIELD ELEMENT VALUES fed as the first Poseidon input, not bytes.
pub const DOMAIN_COMMIT: u64 = 1;
pub const DOMAIN_NULLIF: u64 = 2;

/// Size of a BN254 Fr field element, big-endian.
pub const FIELD_SIZE: usize = 32;

#[cfg(feature = "real")]
mod real_backend {
    /// `false` — this is the real circomlib-matching Poseidon, not the SHA-256 stub.
    pub const IS_STUB: bool = false;
    /// `false` — devnet/library only; unaudited.
    pub const MAINNET_READY: bool = false;

    /// Encode a `u64` as a 32-byte big-endian BN254 field element.
    pub fn u64_to_be32(x: u64) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[24..32].copy_from_slice(&x.to_be_bytes());
        out
    }

    // ── Two backends, identical output bytes ────────────────────────────────────
    //
    // BN254X5 circomlib Poseidon is computed two ways depending on the target,
    // because no single pure-Rust impl both (a) runs on the host AND (b) fits the
    // 4 KB SBF stack frame:
    //
    //   * HOST (cargo test, off-chain prover/indexer): `light-poseidon`. Pure
    //     Rust, runs anywhere, BYTE-MATCHES circomlibjs (proven by match_tests).
    //     It overflows the SBF stack when building its parameter tables, so it is
    //     NOT used on-chain.
    //
    //   * SBF / on-chain (`target_os = "solana"`): `solana_program::poseidon::hashv`
    //     with `Parameters::Bn254X5, Endianness::BigEndian`. This is a runtime
    //     SYSCALL — the heavy parameter tables live in the validator, not on the
    //     program stack, so it compiles and runs within the SBF limits.
    //
    // Both use the identical BN254 x^5 circomlib parameter set and big-endian
    // field encoding, so they produce the SAME 32-byte output for the same
    // inputs. `solana_program::poseidon` and `light-poseidon` are both Light
    // Protocol implementations of the same circomlib spec.

    /// Core hasher: real circomlib BN254 Poseidon over `inputs.len()` big-endian
    /// 32-byte field elements. Output is a 32-byte big-endian field element.
    ///
    /// `inputs.len()` is the Poseidon arity (`Poseidon(n)` in circom). Each input
    /// MUST already be a canonical Fr value < the BN254 scalar modulus.
    #[cfg(not(target_os = "solana"))]
    pub fn poseidon_be(inputs: &[[u8; 32]]) -> [u8; 32] {
        use ark_bn254::Fr;
        use light_poseidon::{Poseidon, PoseidonBytesHasher};
        // `new_circom(arity)` selects circomlib's round constants / MDS matrix
        // for that width — the same parameters `poseidon.circom` is generated
        // from. This is what makes the output byte-match the circuit.
        let mut hasher = Poseidon::<Fr>::new_circom(inputs.len())
            .expect("circom Poseidon params exist for arity 1..=12");
        let refs: Vec<&[u8]> = inputs.iter().map(|b| b.as_slice()).collect();
        hasher
            .hash_bytes_be(&refs)
            .expect("inputs are canonical BN254 field elements")
    }

    /// On-chain (SBF) core hasher — same output bytes as the host path, via the
    /// `sol_poseidon` syscall. Heavy parameter tables stay in the validator, so
    /// this stays within the 4 KB SBF stack frame (`light-poseidon` does not).
    #[cfg(target_os = "solana")]
    pub fn poseidon_be(inputs: &[[u8; 32]]) -> [u8; 32] {
        use solana_program::poseidon::{hashv, Endianness, Parameters};
        let refs: Vec<&[u8]> = inputs.iter().map(|b| b.as_slice()).collect();
        hashv(Parameters::Bn254X5, Endianness::BigEndian, &refs)
            .expect("inputs are canonical BN254 field elements")
            .to_bytes()
    }

    /// commitment = Poseidon(3)(DOMAIN_COMMIT=1, secret, leaf_index)
    ///
    /// Matches `shielded_withdraw_v2.circom` lines 122-126.
    pub fn commitment(secret: &[u8; 32], leaf_index: u64) -> [u8; 32] {
        poseidon_be(&[
            u64_to_be32(super::DOMAIN_COMMIT),
            *secret,
            u64_to_be32(leaf_index),
        ])
    }

    /// commitment with `leaf_index` already as a field element (big-endian 32B).
    pub fn commitment_fe(secret: &[u8; 32], leaf_index: &[u8; 32]) -> [u8; 32] {
        poseidon_be(&[u64_to_be32(super::DOMAIN_COMMIT), *secret, *leaf_index])
    }

    /// nullifier = Poseidon(3)(DOMAIN_NULLIF=2, secret, pool_key_field)
    ///
    /// Matches `shielded_withdraw_v2.circom` lines 137-141.
    pub fn nullifier(secret: &[u8; 32], pool_key_field: &[u8; 32]) -> [u8; 32] {
        poseidon_be(&[
            u64_to_be32(super::DOMAIN_NULLIF),
            *secret,
            *pool_key_field,
        ])
    }

    /// merkle_node = Poseidon(2)(left, right)
    ///
    /// Matches the `MerkleProof` gadget, `shielded_withdraw_v2.circom` lines 87-99.
    /// No domain tag — the circuit hashes the two children directly.
    pub fn merkle_node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
        poseidon_be(&[*left, *right])
    }
}

#[cfg(feature = "real")]
pub use real_backend::*;

// ─────────────────────────────────────────────────────────────────────────────
// Legacy SHA-256 stub backend — available behind `--no-default-features
// --features stub` for comparison ONLY. This is the OLD (wrong) behavior that
// can never match a real circuit proof. Do not use for new code.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(all(feature = "stub", not(feature = "real")))]
mod stub_backend {
    use sha2::{Digest, Sha256};

    pub const IS_STUB: bool = true;
    pub const MAINNET_READY: bool = false;

    fn sha(parts: &[&[u8]]) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"dark-poseidon-bn254-v1");
        for p in parts {
            h.update(p);
        }
        h.finalize().into()
    }

    pub fn u64_to_be32(x: u64) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[24..32].copy_from_slice(&x.to_be_bytes());
        out
    }

    pub fn commitment(secret: &[u8; 32], leaf_index: u64) -> [u8; 32] {
        sha(&[&[super::DOMAIN_COMMIT as u8], secret, &leaf_index.to_le_bytes()])
    }

    pub fn nullifier(secret: &[u8; 32], pool_key_field: &[u8; 32]) -> [u8; 32] {
        sha(&[&[super::DOMAIN_NULLIF as u8], secret, pool_key_field])
    }

    pub fn merkle_node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
        sha(&[left, right])
    }
}

#[cfg(all(feature = "stub", not(feature = "real")))]
pub use stub_backend::*;

// ─────────────────────────────────────────────────────────────────────────────
// MATCH TEST — proves Rust Poseidon == circomlibjs Poseidon (the circuit's).
//
// Reference values generated by circomlibjs `buildPoseidon()` over the EXACT
// circuit input vectors (see crates/dark-poseidon-real/reference/gen_ref.mjs).
// If these byte-match, an on-chain hash computed with this crate will match a
// Groth16 public input produced by the circuit. THIS is the keystone proof.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(all(test, feature = "real"))]
mod match_tests {
    use super::*;

    fn be32(hex_str: &str) -> [u8; 32] {
        let v = hex::decode(hex_str).expect("valid hex");
        let mut out = [0u8; 32];
        out.copy_from_slice(&v);
        out
    }

    // Each vector: (secret_dec_as_be, leaf_index_u64, pool_key_be, left_be, right_be,
    //               expected_commitment_be, expected_nullifier_be, expected_merkle_be)
    // Decimal field-element inputs are encoded big-endian below to match circomlibjs.

    #[test]
    fn vec0_commitment_nullifier_merkle_match_circomlibjs() {
        // secret = 12345678901234567890, leaf_index = 42,
        // pool_key_field = 9876543210987654321, left = 11111111111111111111,
        // right = 22222222222222222222
        let secret = be32("000000000000000000000000000000000000000000000000ab54a98ceb1f0ad2");
        let leaf_index: u64 = 42;
        let pool_key = be32("000000000000000000000000000000000000000000000000891087b8e3b70cb1");
        let left = be32("0000000000000000000000000000000000000000000000009a3298afb5ac71c7");
        let right = be32("0000000000000000000000000000000000000000000000013465315f6b58e38e");

        assert_eq!(
            hex::encode(commitment(&secret, leaf_index)),
            "28d8166bbc55105a2c9e7bfbe26d05dba93e51741add9728ea6b6a294603c5b1",
            "commitment must byte-match circomlibjs Poseidon([1, secret, leaf_index])"
        );
        assert_eq!(
            hex::encode(nullifier(&secret, &pool_key)),
            "1cd51dc7d8e5c5696467ae6956fa59c20c4c1dea35c98b6168475a9c1e41faf3",
            "nullifier must byte-match circomlibjs Poseidon([2, secret, pool_key_field])"
        );
        assert_eq!(
            hex::encode(merkle_node(&left, &right)),
            "002407ad0487323b05a9b51259681b385af4f751176e333639f7847cee83e083",
            "merkle_node must byte-match circomlibjs Poseidon([left, right])"
        );
    }

    #[test]
    fn vec1_small_values_match_circomlibjs() {
        // secret = 1, leaf_index = 0, pool_key_field = 7, left = 1, right = 2
        let secret = be32("0000000000000000000000000000000000000000000000000000000000000001");
        let pool_key = be32("0000000000000000000000000000000000000000000000000000000000000007");
        let left = be32("0000000000000000000000000000000000000000000000000000000000000001");
        let right = be32("0000000000000000000000000000000000000000000000000000000000000002");

        assert_eq!(
            hex::encode(commitment(&secret, 0)),
            "16578e1d6f105ed49d16b894f6fb3abee0631b8941b0527beee62a957e7dedde"
        );
        assert_eq!(
            hex::encode(nullifier(&secret, &pool_key)),
            "1a4806a99f376c99d7e15eaf0577d303583415fcd361fd7945d7170c3e9f700e"
        );
        // Poseidon([1, 2]) — the canonical circomlib test vector.
        assert_eq!(
            hex::encode(merkle_node(&left, &right)),
            "115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a"
        );
    }

    #[test]
    fn vec2_large_values_match_circomlibjs() {
        // secret = 0x1234567890abcdef1234567890abcdef, leaf_index = 1048575 (2^20-1),
        // pool_key_field = 0xdeadbeefcafebabe0011223344556677,
        // left = 0xaaaa...aa (16 bytes), right = 0xbbbb...bb (16 bytes)
        let secret = be32("000000000000000000000000000000001234567890abcdef1234567890abcdef");
        let leaf_index: u64 = 1_048_575;
        let pool_key = be32("00000000000000000000000000000000deadbeefcafebabe0011223344556677");
        let left = be32("00000000000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let right = be32("00000000000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

        assert_eq!(
            hex::encode(commitment(&secret, leaf_index)),
            "07da72405abbbb6ddeaffa102e2ade0a28b418d2f9f40b49c582d14c9dd376a8"
        );
        assert_eq!(
            hex::encode(nullifier(&secret, &pool_key)),
            "156a6d9cf36d5dc148b6be8d331a392974385d6062d3a378f5c04b34dcfce9e2"
        );
        assert_eq!(
            hex::encode(merkle_node(&left, &right)),
            "20ee64855651f3967b94aa83ec8c7a7c677b3271f453e6e695fa8df2d72bb8e0"
        );
    }

    #[test]
    fn commitment_fe_equals_u64_path() {
        let secret = be32("000000000000000000000000000000000000000000000000ab54a98ceb1f0ad2");
        let leaf_fe = u64_to_be32(42);
        assert_eq!(commitment(&secret, 42), commitment_fe(&secret, &leaf_fe));
    }

    #[test]
    fn domain_separation_commitment_ne_nullifier() {
        // Same (secret, x) but different domain tag → different output.
        let secret = be32("000000000000000000000000000000000000000000000000ab54a98ceb1f0ad2");
        let x = be32("000000000000000000000000000000000000000000000000891087b8e3b70cb1");
        // commitment uses DOMAIN_COMMIT=1, nullifier uses DOMAIN_NULLIF=2.
        assert_ne!(commitment_fe(&secret, &x), nullifier(&secret, &x));
    }

    #[test]
    fn is_not_stub() {
        assert!(!IS_STUB, "real backend must report IS_STUB = false");
    }

    /// CROSS-CHECK: the EXACT on-chain entry point
    /// (`solana_program::poseidon::hashv(Bn254X5, BigEndian, ...)`) produces the
    /// same circomlibjs vectors as our host backend.
    ///
    /// On the host, `hashv` falls back to `light_poseidon::Poseidon::<Fr>
    /// ::new_circom(...).hash_bytes_be(...)` (see solana-program 1.18.26
    /// src/poseidon.rs). On SBF it dispatches to the `sol_poseidon` syscall, which
    /// is the SBF-native implementation of the identical Bn254X5 circuit. So this
    /// host assertion proves the on-chain path lands on the same bytes the circuit
    /// (and our `poseidon_be`) produce.
    #[test]
    fn syscall_entrypoint_matches_circomlibjs() {
        use solana_program::poseidon::{hashv, Endianness, Parameters};

        // vec1: commitment Poseidon([1,1,0]), nullifier Poseidon([2,1,7]), merkle Poseidon([1,2]).
        let one = u64_to_be32(1);
        let two = u64_to_be32(2);
        let zero = u64_to_be32(0);
        let seven = u64_to_be32(7);

        let commit = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&one, &one, &zero])
            .unwrap()
            .to_bytes();
        assert_eq!(
            hex::encode(commit),
            "16578e1d6f105ed49d16b894f6fb3abee0631b8941b0527beee62a957e7dedde",
            "on-chain hashv commitment must match circomlibjs"
        );
        // And it must equal our crate's commitment() for the same inputs.
        assert_eq!(commit, commitment(&one, 0));

        let null = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&two, &one, &seven])
            .unwrap()
            .to_bytes();
        assert_eq!(
            hex::encode(null),
            "1a4806a99f376c99d7e15eaf0577d303583415fcd361fd7945d7170c3e9f700e",
            "on-chain hashv nullifier must match circomlibjs"
        );
        assert_eq!(null, nullifier(&one, &seven));

        let node = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&one, &two])
            .unwrap()
            .to_bytes();
        assert_eq!(
            hex::encode(node),
            "115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a",
            "on-chain hashv merkle node Poseidon([1,2]) must match circomlibjs"
        );
        assert_eq!(node, merkle_node(&one, &two));
    }
}
