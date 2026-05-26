use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RingMember {
    pub pubkey: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VrfRing {
    pub ring_root: [u8; 32],
    pub member_count: u8,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VrfOutput {
    pub output: [u8; 32],
    pub ring_root: [u8; 32],
    pub input_hash: [u8; 32],
    pub proof_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum VrfError {
    EmptyRing,
    SecretNotInRing,
    EmptyInput,
}

// ── Internal helpers ─────────────────────────────────────────────────────────

fn sha256_tagged(tag: &[u8], data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(tag);
    h.update(data);
    h.finalize().into()
}

fn derive_pubkey(secret: &[u8; 32]) -> [u8; 32] {
    sha256_tagged(b"vrf-pubkey-v1", secret)
}

fn derive_ring_root(members: &[RingMember]) -> [u8; 32] {
    // XOR-fold all pubkeys, then hash
    let mut fold = [0u8; 32];
    for m in members {
        for (a, b) in fold.iter_mut().zip(m.pubkey.iter()) {
            *a ^= b;
        }
    }
    sha256_tagged(b"vrf-ring-v1", &fold)
}

fn derive_input_hash(input_bytes: &[u8]) -> [u8; 32] {
    sha256_tagged(b"vrf-input-v1", input_bytes)
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Build a VRF ring from a slice of 32-byte secrets.
/// Returns `VrfError::EmptyRing` if `secrets` is empty.
/// `mainnet_ready` is always `false`.
pub fn build_ring(secrets: &[[u8; 32]]) -> Result<(VrfRing, Vec<RingMember>), VrfError> {
    if secrets.is_empty() {
        return Err(VrfError::EmptyRing);
    }

    let members: Vec<RingMember> = secrets
        .iter()
        .map(|s| RingMember { pubkey: derive_pubkey(s) })
        .collect();

    let ring_root = derive_ring_root(&members);

    let ring = VrfRing {
        ring_root,
        member_count: members.len() as u8,
        mainnet_ready: false,
    };

    Ok((ring, members))
}

/// Evaluate the VRF for `secret` over `input_bytes` in `ring`.
/// Errors:
/// - `EmptyInput`       — `input_bytes` is empty
/// - `SecretNotInRing`  — the pubkey derived from `secret` is not present in `members`
/// `mainnet_ready` is always `false`.
pub fn vrf_evaluate(
    ring: &VrfRing,
    members: &[RingMember],
    secret: &[u8; 32],
    input_bytes: &[u8],
) -> Result<VrfOutput, VrfError> {
    if input_bytes.is_empty() {
        return Err(VrfError::EmptyInput);
    }

    let pubkey = derive_pubkey(secret);
    if !members.iter().any(|m| m.pubkey == pubkey) {
        return Err(VrfError::SecretNotInRing);
    }

    let input_hash = derive_input_hash(input_bytes);

    // secret commitment
    let secret_commit = sha256_tagged(b"vrf-secret-v1", secret);

    // VRF output = SHA256("vrf-output-v1" || ring_root || input_hash || secret_commit)
    let mut h = Sha256::new();
    h.update(b"vrf-output-v1");
    h.update(ring.ring_root);
    h.update(input_hash);
    h.update(secret_commit);
    let output: [u8; 32] = h.finalize().into();

    // proof_hash = SHA256("vrf-proof-v1" || output || ring_root || input_hash)
    let mut h2 = Sha256::new();
    h2.update(b"vrf-proof-v1");
    h2.update(output);
    h2.update(ring.ring_root);
    h2.update(input_hash);
    let proof_hash: [u8; 32] = h2.finalize().into();

    Ok(VrfOutput {
        output,
        ring_root: ring.ring_root,
        input_hash,
        proof_hash,
        mainnet_ready: false,
    })
}

/// Verify a `VrfOutput` against a ring and original input bytes.
/// Returns `true` iff both `input_hash` and `proof_hash` are consistent.
pub fn vrf_verify(ring: &VrfRing, output: &VrfOutput, input_bytes: &[u8]) -> bool {
    // Re-derive input_hash and check
    let expected_input_hash = derive_input_hash(input_bytes);
    if output.input_hash != expected_input_hash {
        return false;
    }

    // Re-derive proof_hash and check
    let mut h = Sha256::new();
    h.update(b"vrf-proof-v1");
    h.update(output.output);
    h.update(ring.ring_root);
    h.update(output.input_hash);
    let expected_proof_hash: [u8; 32] = h.finalize().into();

    output.proof_hash == expected_proof_hash
}

/// Serialize a `VrfOutput` as a JSON record with hex-encoded fields.
/// The secret is never included.
pub fn vrf_public_record(output: &VrfOutput) -> String {
    let obj = serde_json::json!({
        "output":      hex::encode_bytes(&output.output),
        "ring_root":   hex::encode_bytes(&output.ring_root),
        "input_hash":  hex::encode_bytes(&output.input_hash),
        "proof_hash":  hex::encode_bytes(&output.proof_hash),
        "mainnet_ready": output.mainnet_ready,
    });
    obj.to_string()
}

// Tiny inline hex encoder — avoids adding the `hex` crate dependency.
mod hex {
    pub fn encode_bytes(b: &[u8]) -> String {
        b.iter().map(|byte| format!("{:02x}", byte)).collect()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(seed: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = seed;
        s
    }

    #[test]
    fn test_vrf_evaluate_and_verify() {
        let secrets = [secret(1), secret(2), secret(3)];
        let (ring, members) = build_ring(&secrets).unwrap();
        let out = vrf_evaluate(&ring, &members, &secrets[0], b"hello world").unwrap();
        assert!(vrf_verify(&ring, &out, b"hello world"));
    }

    #[test]
    fn test_output_pseudorandom_per_input() {
        let secrets = [secret(1), secret(2), secret(3)];
        let (ring, members) = build_ring(&secrets).unwrap();
        let out1 = vrf_evaluate(&ring, &members, &secrets[0], b"input-a").unwrap();
        let out2 = vrf_evaluate(&ring, &members, &secrets[0], b"input-b").unwrap();
        assert_ne!(out1.output, out2.output);
    }

    #[test]
    fn test_output_pseudorandom_per_secret() {
        let secrets = [secret(1), secret(2), secret(3)];
        let (ring, members) = build_ring(&secrets).unwrap();
        let out1 = vrf_evaluate(&ring, &members, &secrets[0], b"same-input").unwrap();
        let out2 = vrf_evaluate(&ring, &members, &secrets[1], b"same-input").unwrap();
        assert_ne!(out1.output, out2.output);
    }

    #[test]
    fn test_empty_ring_rejected() {
        let result = build_ring(&[]);
        assert_eq!(result, Err(VrfError::EmptyRing));
    }

    #[test]
    fn test_secret_not_in_ring_rejected() {
        let secrets = [secret(1), secret(2)];
        let (ring, members) = build_ring(&secrets).unwrap();
        let outsider = secret(99);
        let result = vrf_evaluate(&ring, &members, &outsider, b"some input");
        assert_eq!(result, Err(VrfError::SecretNotInRing));
    }

    #[test]
    fn test_public_record_hides_secret() {
        let s = secret(42);
        let secrets = [s];
        let (ring, members) = build_ring(&secrets).unwrap();
        let out = vrf_evaluate(&ring, &members, &s, b"test input").unwrap();
        let record = vrf_public_record(&out);
        // The raw secret hex must not appear in the JSON
        let secret_hex = hex::encode_bytes(&s);
        assert!(
            !record.contains(&secret_hex),
            "secret hex found in public record: {}",
            record
        );
    }
}
