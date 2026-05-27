// dark-poseidon-bn254 — domain-separated hash primitives for BN254 circuit
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

/// BN254 scalar field label used as the hash function version prefix for
/// all domain-separated hashes in this crate.
pub const BN254_SCALAR_FIELD_LABEL: &[u8] = b"bn254-scalar-field-v1";

pub const DOMAIN_COMMITMENT: u8 = 1;
pub const DOMAIN_NULLIFIER: u8 = 2;
pub const DOMAIN_WITHDRAW: u8 = 3;
pub const DOMAIN_NOTE: u8 = 4;

/// Generic domain-separated hash.
///
/// Computes `SHA256("dark-poseidon-bn254-v1" || domain_byte || inputs...)`.
/// The fixed prefix ensures no cross-application collision even if domain
/// bytes are reused in another context.
pub fn poseidon_bn254(domain: u8, inputs: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"dark-poseidon-bn254-v1");
    hasher.update([domain]);
    for input in inputs {
        hasher.update(input);
    }
    hasher.finalize().into()
}

/// Compute a note commitment.
///
/// `SHA256(DOMAIN_COMMITMENT || value.to_le_bytes() || randomness || recipient_hash)`
pub fn note_commitment(value: u64, randomness: &[u8; 32], recipient_hash: &[u8; 32]) -> [u8; 32] {
    poseidon_bn254(
        DOMAIN_COMMITMENT,
        &[
            &value.to_le_bytes(),
            randomness.as_slice(),
            recipient_hash.as_slice(),
        ],
    )
}

/// Compute a nullifier hash.
///
/// `SHA256(DOMAIN_NULLIFIER || commitment || secret || root)`
pub fn nullifier_hash(commitment: &[u8; 32], secret: &[u8; 32], root: &[u8; 32]) -> [u8; 32] {
    poseidon_bn254(
        DOMAIN_NULLIFIER,
        &[commitment.as_slice(), secret.as_slice(), root.as_slice()],
    )
}

/// Compute the public-inputs hash for a Groth16 withdrawal proof.
///
/// `SHA256(DOMAIN_WITHDRAW || merkle_root || nullifier || amount.to_le_bytes())`
///
/// This tuple of public inputs is what goes into the on-chain Groth16 verifier.
pub fn withdraw_public_inputs_hash(
    merkle_root: &[u8; 32],
    nullifier: &[u8; 32],
    amount: u64,
) -> [u8; 32] {
    poseidon_bn254(
        DOMAIN_WITHDRAW,
        &[
            merkle_root.as_slice(),
            nullifier.as_slice(),
            &amount.to_le_bytes(),
        ],
    )
}

/// Derive a per-note key from a secret.
///
/// `SHA256(DOMAIN_NOTE || secret)`
pub fn note_secret_to_key(secret: &[u8; 32]) -> [u8; 32] {
    poseidon_bn254(DOMAIN_NOTE, &[secret.as_slice()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_domain_separation() {
        let inputs: &[&[u8]] = &[b"same_input_bytes"];
        let h1 = poseidon_bn254(DOMAIN_COMMITMENT, inputs);
        let h2 = poseidon_bn254(DOMAIN_NULLIFIER, inputs);
        let h3 = poseidon_bn254(DOMAIN_WITHDRAW, inputs);
        let h4 = poseidon_bn254(DOMAIN_NOTE, inputs);

        assert_ne!(h1, h2, "commitment vs nullifier domain must differ");
        assert_ne!(h1, h3, "commitment vs withdraw domain must differ");
        assert_ne!(h1, h4, "commitment vs note domain must differ");
        assert_ne!(h2, h3, "nullifier vs withdraw domain must differ");
        assert_ne!(h2, h4, "nullifier vs note domain must differ");
        assert_ne!(h3, h4, "withdraw vs note domain must differ");
    }

    #[test]
    fn test_note_commitment_field_sensitivity() {
        let value: u64 = 1_000_000;
        let randomness = [0xABu8; 32];
        let recipient = [0x11u8; 32];

        let base = note_commitment(value, &randomness, &recipient);

        // Change value
        let diff_value = note_commitment(value + 1, &randomness, &recipient);
        assert_ne!(
            base, diff_value,
            "different value must produce different commitment"
        );

        // Change randomness
        let mut rand2 = randomness;
        rand2[0] ^= 0xFF;
        let diff_rand = note_commitment(value, &rand2, &recipient);
        assert_ne!(
            base, diff_rand,
            "different randomness must produce different commitment"
        );

        // Change recipient
        let mut rec2 = recipient;
        rec2[31] ^= 0x01;
        let diff_rec = note_commitment(value, &randomness, &rec2);
        assert_ne!(
            base, diff_rec,
            "different recipient must produce different commitment"
        );
    }

    #[test]
    fn test_nullifier_binding() {
        let commitment = [0xCCu8; 32];
        let root = [0x77u8; 32];

        let secret_a = [0x01u8; 32];
        let secret_b = [0x02u8; 32];

        let null_a = nullifier_hash(&commitment, &secret_a, &root);
        let null_b = nullifier_hash(&commitment, &secret_b, &root);

        assert_ne!(
            null_a, null_b,
            "different secrets must produce different nullifiers"
        );

        // Same inputs → same nullifier (determinism)
        let null_a2 = nullifier_hash(&commitment, &secret_a, &root);
        assert_eq!(null_a, null_a2, "nullifier_hash must be deterministic");
    }

    #[test]
    fn test_withdraw_inputs_deterministic() {
        let root = [0x55u8; 32];
        let nullifier = [0x66u8; 32];
        let amount: u64 = 500_000_000;

        let h1 = withdraw_public_inputs_hash(&root, &nullifier, amount);
        let h2 = withdraw_public_inputs_hash(&root, &nullifier, amount);
        assert_eq!(h1, h2, "same inputs must always produce same hash");

        // Sanity: changing amount changes the hash
        let h3 = withdraw_public_inputs_hash(&root, &nullifier, amount + 1);
        assert_ne!(h1, h3, "different amount must produce different hash");
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_note_commitment_nonzero() {
        let c = note_commitment(1_000_000, &[0xAAu8; 32], &[0xBBu8; 32]);
        assert_ne!(c, [0u8; 32]);
    }

    #[test]
    fn test_note_commitment_deterministic() {
        let c1 = note_commitment(1_000_000, &[0xAAu8; 32], &[0xBBu8; 32]);
        let c2 = note_commitment(1_000_000, &[0xAAu8; 32], &[0xBBu8; 32]);
        assert_eq!(c1, c2);
    }

    #[test]
    fn test_nullifier_hash_nonzero() {
        let n = nullifier_hash(&[0x11u8; 32], &[0x22u8; 32], &[0x33u8; 32]);
        assert_ne!(n, [0u8; 32]);
    }

    #[test]
    fn test_nullifier_root_sensitive() {
        let commitment = [0x11u8; 32];
        let secret = [0x22u8; 32];
        let n1 = nullifier_hash(&commitment, &secret, &[0x33u8; 32]);
        let n2 = nullifier_hash(&commitment, &secret, &[0x44u8; 32]);
        assert_ne!(n1, n2);
    }

    #[test]
    fn test_nullifier_commitment_sensitive() {
        let secret = [0x22u8; 32];
        let root = [0x33u8; 32];
        let n1 = nullifier_hash(&[0x11u8; 32], &secret, &root);
        let n2 = nullifier_hash(&[0x99u8; 32], &secret, &root);
        assert_ne!(n1, n2);
    }

    #[test]
    fn test_withdraw_hash_nonzero() {
        let h = withdraw_public_inputs_hash(&[0x55u8; 32], &[0x66u8; 32], 1_000);
        assert_ne!(h, [0u8; 32]);
    }

    #[test]
    fn test_withdraw_root_sensitive() {
        let nullifier = [0x66u8; 32];
        let h1 = withdraw_public_inputs_hash(&[0x55u8; 32], &nullifier, 1_000);
        let h2 = withdraw_public_inputs_hash(&[0x77u8; 32], &nullifier, 1_000);
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_withdraw_nullifier_sensitive() {
        let root = [0x55u8; 32];
        let h1 = withdraw_public_inputs_hash(&root, &[0x66u8; 32], 1_000);
        let h2 = withdraw_public_inputs_hash(&root, &[0x88u8; 32], 1_000);
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_note_secret_to_key_nonzero() {
        let k = note_secret_to_key(&[0xABu8; 32]);
        assert_ne!(k, [0u8; 32]);
    }

    #[test]
    fn test_note_secret_to_key_deterministic() {
        let k1 = note_secret_to_key(&[0xABu8; 32]);
        let k2 = note_secret_to_key(&[0xABu8; 32]);
        assert_eq!(k1, k2);
    }

    #[test]
    fn test_note_secret_to_key_secret_sensitive() {
        let k1 = note_secret_to_key(&[0x01u8; 32]);
        let k2 = note_secret_to_key(&[0x02u8; 32]);
        assert_ne!(k1, k2);
    }

    #[test]
    fn test_poseidon_hash_input_sensitive() {
        let h1 = poseidon_bn254(DOMAIN_COMMITMENT, &[b"input_a"]);
        let h2 = poseidon_bn254(DOMAIN_COMMITMENT, &[b"input_b"]);
        assert_ne!(h1, h2);
    }
}
