use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HashedSet {
    pub elements: Vec<[u8; 32]>,
    pub set_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntersectionProof {
    pub common_hashes: Vec<[u8; 32]>,
    pub intersection_size: usize,
    pub proof_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PsiError {
    EmptySet,
    PartySecretZero,
}

pub fn hash_set(elements: &[&[u8]], party_secret: &[u8; 32]) -> Result<HashedSet, PsiError> {
    if party_secret == &[0u8; 32] {
        return Err(PsiError::PartySecretZero);
    }
    if elements.is_empty() {
        return Err(PsiError::EmptySet);
    }

    let mut hashed: Vec<[u8; 32]> = Vec::new();
    let mut xor_fold = [0u8; 32];

    for &elem in elements {
        let mut input = Vec::new();
        input.extend_from_slice(b"psi-elem-v1");
        input.extend_from_slice(elem);
        input.extend_from_slice(party_secret);
        let h = sha256(&input);
        for i in 0..32 {
            xor_fold[i] ^= h[i];
        }
        hashed.push(h);
    }

    let mut set_hash_input = Vec::new();
    set_hash_input.extend_from_slice(b"psi-set-v1");
    set_hash_input.extend_from_slice(&xor_fold);
    let set_hash = sha256(&set_hash_input);

    Ok(HashedSet {
        elements: hashed,
        set_hash,
        mainnet_ready: false,
    })
}

pub fn intersect(set_a: &HashedSet, set_b: &HashedSet) -> IntersectionProof {
    let mut common: Vec<[u8; 32]> = Vec::new();
    for ha in &set_a.elements {
        if set_b.elements.contains(ha) {
            common.push(*ha);
        }
    }
    let intersection_size = common.len();
    let size_le = (intersection_size as u64).to_le_bytes();

    let mut proof_input = Vec::new();
    proof_input.extend_from_slice(b"psi-proof-v1");
    proof_input.extend_from_slice(&set_a.set_hash);
    proof_input.extend_from_slice(&set_b.set_hash);
    proof_input.extend_from_slice(&size_le);
    let proof_hash = sha256(&proof_input);

    IntersectionProof {
        common_hashes: common,
        intersection_size,
        proof_hash,
        mainnet_ready: false,
    }
}

pub fn verify_intersection(
    set_a: &HashedSet,
    set_b: &HashedSet,
    proof: &IntersectionProof,
) -> bool {
    let recomputed = intersect(set_a, set_b);
    if recomputed.intersection_size != proof.intersection_size {
        return false;
    }
    if recomputed.proof_hash != proof.proof_hash {
        return false;
    }
    if recomputed.common_hashes.len() != proof.common_hashes.len() {
        return false;
    }
    for h in &proof.common_hashes {
        if !recomputed.common_hashes.contains(h) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_two_common_elements_out_of_four() {
        let secret_a = [10u8; 32];
        let secret_b = [20u8; 32];

        // Both parties share "apple" and "cherry" but not "banana"/"date" vs "elderberry"/"fig"
        let elems_a: Vec<&[u8]> = vec![b"apple", b"banana", b"cherry", b"date"];
        let elems_b: Vec<&[u8]> = vec![b"apple", b"cherry", b"elderberry", b"fig"];

        // For intersection to work, both parties must hash with the SAME secret
        // (In practice they'd use a shared DH secret; here we use the same secret)
        let shared_secret = [99u8; 32];

        let set_a = hash_set(&elems_a, &shared_secret).unwrap();
        assert!(!set_a.mainnet_ready);
        let set_b = hash_set(&elems_b, &shared_secret).unwrap();
        assert!(!set_b.mainnet_ready);

        let proof = intersect(&set_a, &set_b);
        assert!(!proof.mainnet_ready);
        assert_eq!(proof.intersection_size, 2);
        assert_eq!(proof.common_hashes.len(), 2);
    }

    #[test]
    fn test_empty_intersection() {
        let shared_secret = [99u8; 32];
        let elems_a: Vec<&[u8]> = vec![b"alpha", b"beta"];
        let elems_b: Vec<&[u8]> = vec![b"gamma", b"delta"];

        let set_a = hash_set(&elems_a, &shared_secret).unwrap();
        let set_b = hash_set(&elems_b, &shared_secret).unwrap();

        let proof = intersect(&set_a, &set_b);
        assert_eq!(proof.intersection_size, 0);
        assert!(proof.common_hashes.is_empty());
    }

    #[test]
    fn test_verify_intersection_passes() {
        let shared_secret = [55u8; 32];
        let elems_a: Vec<&[u8]> = vec![b"x", b"y", b"z", b"w"];
        let elems_b: Vec<&[u8]> = vec![b"x", b"z", b"p", b"q"];

        let set_a = hash_set(&elems_a, &shared_secret).unwrap();
        let set_b = hash_set(&elems_b, &shared_secret).unwrap();

        let proof = intersect(&set_a, &set_b);
        assert!(verify_intersection(&set_a, &set_b, &proof));
    }

    #[test]
    fn test_different_party_secrets_produce_different_hashes() {
        let secret_a = [11u8; 32];
        let secret_b = [22u8; 32];
        let element: &[u8] = b"same-element";

        let set_a = hash_set(&[element], &secret_a).unwrap();
        let set_b = hash_set(&[element], &secret_b).unwrap();

        // Same element hashed with different secrets should produce different hashes
        assert_ne!(set_a.elements[0], set_b.elements[0]);
        assert_ne!(set_a.set_hash, set_b.set_hash);
    }

    #[test]
    fn test_intersection_size_is_correct() {
        let shared_secret = [77u8; 32];
        let elems_a: Vec<&[u8]> = vec![b"one", b"two", b"three", b"four"];
        let elems_b: Vec<&[u8]> = vec![b"two", b"four", b"six", b"eight"];

        let set_a = hash_set(&elems_a, &shared_secret).unwrap();
        let set_b = hash_set(&elems_b, &shared_secret).unwrap();

        let proof = intersect(&set_a, &set_b);
        assert_eq!(proof.intersection_size, 2);
    }

    #[test]
    fn test_proof_hash_is_deterministic() {
        let shared_secret = [33u8; 32];
        let elems_a: Vec<&[u8]> = vec![b"foo", b"bar"];
        let elems_b: Vec<&[u8]> = vec![b"bar", b"baz"];

        let set_a = hash_set(&elems_a, &shared_secret).unwrap();
        let set_b = hash_set(&elems_b, &shared_secret).unwrap();

        let proof1 = intersect(&set_a, &set_b);
        let proof2 = intersect(&set_a, &set_b);

        assert_eq!(proof1.proof_hash, proof2.proof_hash);
        assert_eq!(proof1.intersection_size, proof2.intersection_size);
    }
}
