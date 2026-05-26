//! Dark Null hash-core: domain-separated hashing with SHA-256 fallback and Poseidon path.
//!
//! # Feature flags
//! - `sha256-fallback` (default): SHA-256 domain-separated hashing, usable everywhere.
//! - `poseidon-mock`: Deterministic mock using SHA-256("POSEIDON_MOCK" || ...) — different
//!   output from sha256-fallback, same API, works in all host-side tests.
//! - `poseidon-real` (BLOCKED): Requires `solana_program::poseidon::hashv` BPF syscall.

// ── Domain constants ──────────────────────────────────────────────────────────

pub const DARK_NULL_COMMITMENT: &[u8] = b"dark_null_v1_commitment";
pub const DARK_NULL_NULLIFIER: &[u8] = b"dark_null_v1_nullifier";
pub const DARK_NULL_RECEIPT: &[u8] = b"dark_null_v1_receipt";
pub const DARK_NULL_X402_INTENT: &[u8] = b"dark_null_v1_x402_intent";
pub const DARK_NULL_MACAROON: &[u8] = b"dark_null_v1_macaroon";
pub const DARK_NULL_SESSION: &[u8] = b"dark_null_v1_session";
pub const DARK_NULL_MODEL_OUTPUT: &[u8] = b"dark_null_v1_model_output";
pub const DARK_NULL_PUZZLE: &[u8] = b"dark_null_v1_puzzle";

// ── Trait ─────────────────────────────────────────────────────────────────────

pub trait DarkHasher {
    fn hash_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32];
}

// ── SHA-256 backend ───────────────────────────────────────────────────────────

#[cfg(feature = "sha256-fallback")]
pub struct Sha256DomainHasher;

#[cfg(feature = "sha256-fallback")]
impl DarkHasher for Sha256DomainHasher {
    fn hash_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
        sha256_domain_hash(domain, inputs)
    }
}

/// SHA-256(domain || input0 || input1 || ...) — domain-separated free function.
///
/// This is the canonical off-chain hash formula used throughout Dark Null v1.
/// The v1 on-chain ritual uses `SHA256(nullifier || epoch_le64 || "dark_null_v1")[0]`
/// which is a different ordering; this function uses the standard domain-prefix convention.
#[cfg(feature = "sha256-fallback")]
pub fn sha256_domain_hash(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(domain);
    for input in inputs {
        h.update(input);
    }
    h.finalize().into()
}

// ── Poseidon mock backend ─────────────────────────────────────────────────────

#[cfg(feature = "poseidon-mock")]
pub struct PoseidonMockHasher;

#[cfg(feature = "poseidon-mock")]
impl DarkHasher for PoseidonMockHasher {
    fn hash_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
        poseidon_mock_hash(domain, inputs)
    }
}

/// Deterministic mock: SHA-256("POSEIDON_MOCK" || domain || input0 || ...).
///
/// The "POSEIDON_MOCK" prefix guarantees a different output from the SHA-256
/// backend for any identical (domain, inputs) pair. This lets tests verify
/// that both backends produce distinct but deterministic outputs.
#[cfg(feature = "poseidon-mock")]
pub fn poseidon_mock_hash(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"POSEIDON_MOCK");
    h.update(domain);
    for input in inputs {
        h.update(input);
    }
    h.finalize().into()
}

// ── Real Poseidon backend (BLOCKED) ───────────────────────────────────────────

// BLOCKED: solana_program::poseidon::hashv requires BPF syscall environment —
// not available in host tests. See docs/POSEIDON_HASH_MIGRATION.md for upgrade path.
//
// pub struct PoseidonRealHasher;
//
// impl DarkHasher for PoseidonRealHasher {
//     fn hash_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
//         // solana_program::poseidon::hashv(Endianness::Big, inputs)
//         unimplemented!("BPF syscall only")
//     }
// }

// ── Hash backend enum + dispatch ──────────────────────────────────────────────

/// Selects the hashing backend for `dispatch_hash`.
pub enum HashBackend {
    Sha256,
    PoseidonMock,
    /// Not yet available — requires BPF syscall runtime.
    /// Use `solana-program-test` BanksClient on Linux/macOS to test real Poseidon.
    PoseidonReal,
}

/// Dispatch a domain-separated hash to the requested backend.
///
/// # Panics
/// Panics with a clear message if `HashBackend::PoseidonReal` is requested —
/// that backend requires the Solana BPF syscall environment.
pub fn dispatch_hash(backend: HashBackend, domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    match backend {
        HashBackend::Sha256 => dispatch_sha256(domain, inputs),
        HashBackend::PoseidonMock => dispatch_poseidon_mock(domain, inputs),
        HashBackend::PoseidonReal => panic!(
            "dark-hash-core: PoseidonReal backend is BLOCKED — \
             solana_program::poseidon::hashv is only available inside the BPF VM. \
             Use solana-program-test BanksClient on Linux/macOS to test real Poseidon. \
             See docs/POSEIDON_HASH_MIGRATION.md for the upgrade path."
        ),
    }
}

#[cfg(feature = "sha256-fallback")]
fn dispatch_sha256(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    sha256_domain_hash(domain, inputs)
}

#[cfg(not(feature = "sha256-fallback"))]
fn dispatch_sha256(_domain: &[u8], _inputs: &[&[u8]]) -> [u8; 32] {
    panic!("dark-hash-core: sha256-fallback feature is not enabled")
}

#[cfg(feature = "poseidon-mock")]
fn dispatch_poseidon_mock(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    poseidon_mock_hash(domain, inputs)
}

#[cfg(not(feature = "poseidon-mock"))]
fn dispatch_poseidon_mock(_domain: &[u8], _inputs: &[&[u8]]) -> [u8; 32] {
    panic!("dark-hash-core: poseidon-mock feature is not enabled")
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Common test inputs
    fn sample_inputs() -> ([u8; 32], [u8; 32]) {
        let a = [0xABu8; 32];
        let b = [0xCDu8; 32];
        (a, b)
    }

    // ── SHA-256 tests ─────────────────────────────────────────────────────────

    #[cfg(feature = "sha256-fallback")]
    #[test]
    fn test_sha256_domain_separation() {
        let (a, b) = sample_inputs();
        let inputs: &[&[u8]] = &[a.as_ref(), b.as_ref()];
        let commitment = sha256_domain_hash(DARK_NULL_COMMITMENT, inputs);
        let nullifier = sha256_domain_hash(DARK_NULL_NULLIFIER, inputs);
        assert_ne!(
            commitment, nullifier,
            "SHA-256 domain separation: COMMITMENT and NULLIFIER must differ for same inputs"
        );
    }

    #[cfg(feature = "sha256-fallback")]
    #[test]
    fn test_sha256_deterministic() {
        let (a, b) = sample_inputs();
        let inputs: &[&[u8]] = &[a.as_ref(), b.as_ref()];
        let first = sha256_domain_hash(DARK_NULL_COMMITMENT, inputs);
        let second = sha256_domain_hash(DARK_NULL_COMMITMENT, inputs);
        assert_eq!(first, second, "SHA-256 hash must be deterministic");
    }

    // ── Poseidon mock tests ───────────────────────────────────────────────────

    #[cfg(feature = "poseidon-mock")]
    #[test]
    fn test_poseidon_mock_domain_separation() {
        let (a, b) = sample_inputs();
        let inputs: &[&[u8]] = &[a.as_ref(), b.as_ref()];
        let commitment = poseidon_mock_hash(DARK_NULL_COMMITMENT, inputs);
        let nullifier = poseidon_mock_hash(DARK_NULL_NULLIFIER, inputs);
        assert_ne!(
            commitment, nullifier,
            "Poseidon mock domain separation: COMMITMENT and NULLIFIER must differ"
        );
    }

    #[cfg(feature = "poseidon-mock")]
    #[test]
    fn test_poseidon_mock_deterministic() {
        let (a, b) = sample_inputs();
        let inputs: &[&[u8]] = &[a.as_ref(), b.as_ref()];
        let first = poseidon_mock_hash(DARK_NULL_COMMITMENT, inputs);
        let second = poseidon_mock_hash(DARK_NULL_COMMITMENT, inputs);
        assert_eq!(first, second, "Poseidon mock hash must be deterministic");
    }

    // ── Cross-backend test ────────────────────────────────────────────────────

    #[cfg(all(feature = "sha256-fallback", feature = "poseidon-mock"))]
    #[test]
    fn test_sha256_and_poseidon_mock_differ() {
        let (a, b) = sample_inputs();
        let inputs: &[&[u8]] = &[a.as_ref(), b.as_ref()];
        let sha256_out = sha256_domain_hash(DARK_NULL_COMMITMENT, inputs);
        let mock_out = poseidon_mock_hash(DARK_NULL_COMMITMENT, inputs);
        assert_ne!(
            sha256_out, mock_out,
            "SHA-256 and Poseidon mock must produce different hashes for same domain+inputs"
        );
    }

    // ── Known-vector test ─────────────────────────────────────────────────────

    #[cfg(feature = "sha256-fallback")]
    #[test]
    fn test_sha256_matches_ritual_formula() {
        // DARKNULL known vector:
        // The v1 ritual formula is: SHA-256(nullifier || epoch_le64 || "dark_null_v1")[0]
        // NOTE: sha256_domain_hash prepends the domain, so it uses a DIFFERENT byte order.
        // This test directly computes the v1 formula to prove it matches the devnet vector.
        // Known DARKNULL vector: nullifier for 'D' → shard 68
        let nullifier_hex = "61227192098dd2e1a2f2a887bbd2454cfa27330e224e7d59f1a9adf1eeb6dc89";
        let nullifier_bytes: Vec<u8> = (0..nullifier_hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&nullifier_hex[i..i + 2], 16).unwrap())
            .collect();
        let epoch_le: [u8; 8] = 0u64.to_le_bytes();

        // v1 ritual order: nullifier || epoch_le || domain (NOT domain-first)
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(&nullifier_bytes);
        h.update(epoch_le);
        h.update(b"dark_null_v1");
        let result: [u8; 32] = h.finalize().into();
        assert_eq!(
            result[0], 68,
            "DARKNULL ritual formula first byte must be 68 (0x44 = 'D'). Got: {}",
            result[0]
        );
        // Confirm sha256_domain_hash (domain-first) gives a DIFFERENT result — they are NOT interchangeable
        let domain_first = sha256_domain_hash(
            b"dark_null_v1",
            &[nullifier_bytes.as_slice(), epoch_le.as_ref()],
        );
        assert_ne!(
            domain_first[0], result[0],
            "sha256_domain_hash must differ from v1 ritual formula"
        );
    }

    // ── Dispatch tests ────────────────────────────────────────────────────────

    #[cfg(feature = "sha256-fallback")]
    #[test]
    fn test_dispatch_sha256_works() {
        let (a, b) = sample_inputs();
        let inputs: &[&[u8]] = &[a.as_ref(), b.as_ref()];
        let direct = sha256_domain_hash(DARK_NULL_COMMITMENT, inputs);
        let dispatch = dispatch_hash(HashBackend::Sha256, DARK_NULL_COMMITMENT, inputs);
        assert_eq!(
            direct, dispatch,
            "dispatch_hash(Sha256) must match sha256_domain_hash"
        );
    }

    #[cfg(feature = "poseidon-mock")]
    #[test]
    fn test_dispatch_poseidon_mock_works() {
        let (a, b) = sample_inputs();
        let inputs: &[&[u8]] = &[a.as_ref(), b.as_ref()];
        let direct = poseidon_mock_hash(DARK_NULL_COMMITMENT, inputs);
        let dispatch = dispatch_hash(HashBackend::PoseidonMock, DARK_NULL_COMMITMENT, inputs);
        assert_eq!(
            direct, dispatch,
            "dispatch_hash(PoseidonMock) must match poseidon_mock_hash"
        );
    }

    // ── All domain constants distinct ─────────────────────────────────────────

    #[cfg(feature = "sha256-fallback")]
    #[test]
    fn test_all_domain_constants_distinct() {
        let (a, b) = sample_inputs();
        let inputs: &[&[u8]] = &[a.as_ref(), b.as_ref()];

        let all_domains: &[&[u8]] = &[
            DARK_NULL_COMMITMENT,
            DARK_NULL_NULLIFIER,
            DARK_NULL_RECEIPT,
            DARK_NULL_X402_INTENT,
            DARK_NULL_MACAROON,
            DARK_NULL_SESSION,
            DARK_NULL_MODEL_OUTPUT,
            DARK_NULL_PUZZLE,
        ];

        let hashes: Vec<[u8; 32]> = all_domains
            .iter()
            .map(|d| sha256_domain_hash(d, inputs))
            .collect();

        // All 8 hashes must be pairwise distinct
        for i in 0..hashes.len() {
            for j in (i + 1)..hashes.len() {
                assert_ne!(
                    hashes[i], hashes[j],
                    "Domain constants {} and {} produced identical hashes — constants must be unique",
                    i, j
                );
            }
        }
    }

    // ── Additional input sensitivity ──────────────────────────────────────────

    #[cfg(feature = "sha256-fallback")]
    #[test]
    fn test_domain_hash_changes_with_additional_input() {
        let data = [0x42u8; 32];
        let extra = [0x99u8; 16];

        let without_extra = sha256_domain_hash(DARK_NULL_COMMITMENT, &[data.as_ref()]);
        let with_extra = sha256_domain_hash(DARK_NULL_COMMITMENT, &[data.as_ref(), extra.as_ref()]);

        assert_ne!(
            without_extra, with_extra,
            "Adding an additional input must change the hash output"
        );
    }
}
