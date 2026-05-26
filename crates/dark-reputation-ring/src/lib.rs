use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct RingMember {
    /// SHA256("ring-member-v1" || member_secret)
    pub public_key: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone)]
pub struct RingEndorsement {
    /// SHA256("ring-endorse-v1" || target_hash || ring_root || nonce)
    /// ring_root = SHA256("ring-root-v1" || XOR-fold of all public_keys)
    pub endorsement_hash: [u8; 32],
    /// SHA256("endorse-link-v1" || member_secret || endorsement_hash)
    /// One-way link: reveals member signed SOMETHING but not WHAT
    pub linkability_tag: [u8; 32],
    pub ring_root: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug)]
pub struct ReputationRing {
    pub ring_root: [u8; 32],
    pub member_count: u32,
    members: Vec<[u8; 32]>, // public_keys
    mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum RingError {
    MemberSecretZero,
    EmptyRing,
    MemberNotInRing,
    NonceZero,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn sha256(data: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for chunk in data {
        hasher.update(chunk);
    }
    hasher.finalize().into()
}

fn compute_ring_root(members: &[[u8; 32]]) -> [u8; 32] {
    let mut xor_acc = [0u8; 32];
    for pk in members {
        for (a, b) in xor_acc.iter_mut().zip(pk.iter()) {
            *a ^= b;
        }
    }
    sha256(&[b"ring-root-v1", &xor_acc])
}

fn bytes_are_zero(b: &[u8; 32]) -> bool {
    b.iter().all(|&x| x == 0)
}

fn bytes_to_hex(b: &[u8; 32]) -> String {
    b.iter().map(|byte| format!("{:02x}", byte)).collect()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a ring member from a secret.
/// Returns `MemberSecretZero` if `member_secret` is all zeros.
pub fn create_member(member_secret: &[u8; 32]) -> Result<RingMember, RingError> {
    if bytes_are_zero(member_secret) {
        return Err(RingError::MemberSecretZero);
    }
    let public_key = sha256(&[b"ring-member-v1", member_secret.as_ref()]);
    Ok(RingMember {
        public_key,
        mainnet_ready: false,
    })
}

/// Create a new, empty reputation ring.
pub fn new_ring() -> ReputationRing {
    ReputationRing {
        ring_root: [0u8; 32],
        member_count: 0,
        members: Vec::new(),
        mainnet_ready: false,
    }
}

/// Add a member to the ring and recompute the ring root.
pub fn add_member(ring: &mut ReputationRing, member: &RingMember) {
    ring.members.push(member.public_key);
    ring.member_count += 1;
    ring.ring_root = compute_ring_root(&ring.members);
}

/// Produce an anonymous endorsement of `target_hash` by a ring member.
///
/// Errors:
/// - `EmptyRing`       — ring has no members
/// - `NonceZero`       — nonce is all zeros
/// - `MemberNotInRing` — `member_secret` does not correspond to any ring member
pub fn endorse(
    ring: &ReputationRing,
    member_secret: &[u8; 32],
    target_hash: &[u8; 32],
    nonce: &[u8; 32],
) -> Result<RingEndorsement, RingError> {
    if ring.members.is_empty() {
        return Err(RingError::EmptyRing);
    }
    if bytes_are_zero(nonce) {
        return Err(RingError::NonceZero);
    }

    // Verify the caller is actually a ring member.
    let public_key = sha256(&[b"ring-member-v1", member_secret.as_ref()]);
    if !ring.members.contains(&public_key) {
        return Err(RingError::MemberNotInRing);
    }

    let endorsement_hash = sha256(&[
        b"ring-endorse-v1",
        target_hash.as_ref(),
        ring.ring_root.as_ref(),
        nonce.as_ref(),
    ]);

    let linkability_tag = sha256(&[
        b"endorse-link-v1",
        member_secret.as_ref(),
        endorsement_hash.as_ref(),
    ]);

    Ok(RingEndorsement {
        endorsement_hash,
        linkability_tag,
        ring_root: ring.ring_root,
        mainnet_ready: false,
    })
}

/// Verify that an endorsement is valid for the given ring, target, and nonce.
/// Does NOT reveal which member produced it.
pub fn verify_endorsement(
    ring: &ReputationRing,
    endorsement: &RingEndorsement,
    target_hash: &[u8; 32],
    nonce: &[u8; 32],
) -> bool {
    let expected_hash = sha256(&[
        b"ring-endorse-v1",
        target_hash.as_ref(),
        ring.ring_root.as_ref(),
        nonce.as_ref(),
    ]);
    expected_hash == endorsement.endorsement_hash && ring.ring_root == endorsement.ring_root
}

/// Return a JSON public record of the ring.
/// Includes ring_root (hex), member_count, and mainnet_ready.
/// Individual member public keys are NOT included.
pub fn ring_public_record(ring: &ReputationRing) -> String {
    serde_json::json!({
        "ring_root": bytes_to_hex(&ring.ring_root),
        "member_count": ring.member_count,
        "mainnet_ready": ring.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_secret(seed: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = seed;
        s
    }

    fn make_nonce(seed: u8) -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = seed;
        n[31] = 0xde;
        n
    }

    fn make_target(seed: u8) -> [u8; 32] {
        let mut t = [0u8; 32];
        t[0] = 0xab;
        t[1] = seed;
        t
    }

    // 1. Happy path: 3-member ring, member 1 endorses, verify passes.
    #[test]
    fn test_endorse_and_verify_happy_path() {
        let secret1 = make_secret(1);
        let secret2 = make_secret(2);
        let secret3 = make_secret(3);

        let m1 = create_member(&secret1).unwrap();
        let m2 = create_member(&secret2).unwrap();
        let m3 = create_member(&secret3).unwrap();

        let mut ring = new_ring();
        add_member(&mut ring, &m1);
        add_member(&mut ring, &m2);
        add_member(&mut ring, &m3);

        let target = make_target(7);
        let nonce = make_nonce(0xaa);

        let endorsement = endorse(&ring, &secret1, &target, &nonce).unwrap();
        assert!(verify_endorsement(&ring, &endorsement, &target, &nonce));
    }

    // 2. A secret not in the ring cannot endorse.
    #[test]
    fn test_non_member_cannot_endorse() {
        let secret1 = make_secret(1);
        let outsider = make_secret(99);

        let m1 = create_member(&secret1).unwrap();
        let mut ring = new_ring();
        add_member(&mut ring, &m1);

        let target = make_target(1);
        let nonce = make_nonce(1);

        let err = endorse(&ring, &outsider, &target, &nonce).unwrap_err();
        assert_eq!(err, RingError::MemberNotInRing);
    }

    // 3. Endorsing on an empty ring returns EmptyRing.
    #[test]
    fn test_empty_ring_rejected() {
        let ring = new_ring();
        let secret = make_secret(1);
        let target = make_target(1);
        let nonce = make_nonce(1);

        let err = endorse(&ring, &secret, &target, &nonce).unwrap_err();
        assert_eq!(err, RingError::EmptyRing);
    }

    // 4. Two endorsements from the same member with different nonces produce
    //    different linkability_tags, so endorsements are unlinkable.
    #[test]
    fn test_endorsement_unlinkable() {
        let secret = make_secret(5);
        let member = create_member(&secret).unwrap();
        let mut ring = new_ring();
        add_member(&mut ring, &member);

        let target = make_target(5);
        let nonce_a = make_nonce(0x01);
        let nonce_b = make_nonce(0x02);

        let e1 = endorse(&ring, &secret, &target, &nonce_a).unwrap();
        let e2 = endorse(&ring, &secret, &target, &nonce_b).unwrap();

        assert_ne!(e1.linkability_tag, e2.linkability_tag);
    }

    // 5. ring_root changes each time a member is added.
    #[test]
    fn test_ring_root_changes_on_member_add() {
        let mut ring = new_ring();
        let root0 = ring.ring_root;

        let m1 = create_member(&make_secret(1)).unwrap();
        add_member(&mut ring, &m1);
        let root1 = ring.ring_root;
        assert_ne!(root0, root1);

        let m2 = create_member(&make_secret(2)).unwrap();
        add_member(&mut ring, &m2);
        let root2 = ring.ring_root;
        assert_ne!(root1, root2);

        let m3 = create_member(&make_secret(3)).unwrap();
        add_member(&mut ring, &m3);
        let root3 = ring.ring_root;
        assert_ne!(root2, root3);
    }

    // 6. ring_public_record does not contain any individual member public_key hex.
    #[test]
    fn test_public_record_hides_members() {
        let secret1 = make_secret(10);
        let secret2 = make_secret(20);
        let m1 = create_member(&secret1).unwrap();
        let m2 = create_member(&secret2).unwrap();

        let mut ring = new_ring();
        add_member(&mut ring, &m1);
        add_member(&mut ring, &m2);

        let record = ring_public_record(&ring);

        // The record must not contain the hex of any individual public key.
        let pk1_hex: String = m1.public_key.iter().map(|b| format!("{:02x}", b)).collect();
        let pk2_hex: String = m2.public_key.iter().map(|b| format!("{:02x}", b)).collect();

        assert!(
            !record.contains(&pk1_hex),
            "record leaks member 1 public key"
        );
        assert!(
            !record.contains(&pk2_hex),
            "record leaks member 2 public key"
        );

        // Sanity: ring_root IS present, member_count IS present.
        assert!(record.contains("ring_root"));
        assert!(record.contains("member_count"));
    }
}
