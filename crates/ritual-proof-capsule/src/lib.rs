use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

fn sha256_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for input in inputs {
        h.update(input);
    }
    h.finalize().into()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum RitualVerdict {
    Accepted,
    Rejected { reason: String },
    Pending,
}

/// The proof capsule written as return data after ritual verification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RitualProofCapsule {
    pub ritual_type: String,
    pub ritual_hash: [u8; 32],
    pub shape_hash: [u8; 32],
    pub permission_hash: [u8; 32],
    pub receipt_hash: [u8; 32],
    pub nullifier_hash: [u8; 32],
    pub no_custody_hash: [u8; 32],
    pub rent_delta_hash: [u8; 32],
    pub verdict: RitualVerdict,
}

/// Public display — hides individual proof hashes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedactedCapsuleView {
    pub ritual_hash: String,
    pub shape_hash: String,
    pub verdict: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapsuleError {
    InvalidData,
    WrongLength { expected: usize, found: usize },
}

// ── Functions ─────────────────────────────────────────────────────────────────

/// Compute capsule_hash.
pub fn capsule_hash(capsule: &RitualProofCapsule) -> [u8; 32] {
    let verdict_byte: u8 = match &capsule.verdict {
        RitualVerdict::Pending => 0,
        RitualVerdict::Accepted => 1,
        RitualVerdict::Rejected { .. } => 2,
    };
    sha256_domain(
        b"dark_null_v1_ritual_capsule",
        &[
            capsule.ritual_type.as_bytes(),
            &capsule.ritual_hash,
            &capsule.shape_hash,
            &capsule.permission_hash,
            &capsule.receipt_hash,
            &capsule.nullifier_hash,
            &capsule.no_custody_hash,
            &capsule.rent_delta_hash,
            &[verdict_byte],
        ],
    )
}

/// Encode to bytes: prefix with u32 LE length of serde_json bytes.
pub fn encode_capsule(capsule: &RitualProofCapsule) -> Vec<u8> {
    let json = serde_json::to_vec(capsule).expect("serialization must succeed");
    let len = json.len() as u32;
    let mut out = Vec::with_capacity(4 + json.len());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&json);
    out
}

/// Decode from bytes (reverse of encode_capsule).
pub fn decode_capsule(bytes: &[u8]) -> Result<RitualProofCapsule, CapsuleError> {
    if bytes.len() < 4 {
        return Err(CapsuleError::WrongLength {
            expected: 4,
            found: bytes.len(),
        });
    }
    let len = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let available = bytes.len() - 4;
    if available < len {
        return Err(CapsuleError::WrongLength {
            expected: len,
            found: available,
        });
    }
    serde_json::from_slice(&bytes[4..4 + len]).map_err(|_| CapsuleError::InvalidData)
}

/// Produce a public-safe redacted view.
pub fn redacted_display(capsule: &RitualProofCapsule) -> RedactedCapsuleView {
    let verdict_str = match &capsule.verdict {
        RitualVerdict::Accepted => "Accepted".to_string(),
        RitualVerdict::Pending => "Pending".to_string(),
        RitualVerdict::Rejected { reason } => format!("Rejected: {}", reason),
    };
    RedactedCapsuleView {
        ritual_hash: hex_encode(&capsule.ritual_hash),
        shape_hash: hex_encode(&capsule.shape_hash),
        verdict: verdict_str,
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_capsule(verdict: RitualVerdict) -> RitualProofCapsule {
        RitualProofCapsule {
            ritual_type: "AgentSpendNoCustodyV1".to_string(),
            ritual_hash: [0x11u8; 32],
            shape_hash: [0x22u8; 32],
            permission_hash: [0x33u8; 32],
            receipt_hash: [0x44u8; 32],
            nullifier_hash: [0x55u8; 32],
            no_custody_hash: [0x66u8; 32],
            rent_delta_hash: [0x77u8; 32],
            verdict,
        }
    }

    #[test]
    fn test_capsule_roundtrip() {
        let original = make_capsule(RitualVerdict::Accepted);
        let encoded = encode_capsule(&original);
        let decoded = decode_capsule(&encoded).expect("decode must succeed");

        assert_eq!(decoded.ritual_type, original.ritual_type);
        assert_eq!(decoded.ritual_hash, original.ritual_hash);
        assert_eq!(decoded.shape_hash, original.shape_hash);
        assert_eq!(decoded.permission_hash, original.permission_hash);
        assert_eq!(decoded.receipt_hash, original.receipt_hash);
        assert_eq!(decoded.nullifier_hash, original.nullifier_hash);
        assert_eq!(decoded.no_custody_hash, original.no_custody_hash);
        assert_eq!(decoded.rent_delta_hash, original.rent_delta_hash);
        assert_eq!(decoded.verdict, RitualVerdict::Accepted);
    }

    #[test]
    fn test_tamper_changes_hash() {
        let capsule = make_capsule(RitualVerdict::Accepted);
        let hash1 = capsule_hash(&capsule);

        let mut modified = capsule.clone();
        modified.receipt_hash = [0xAAu8; 32];
        let hash2 = capsule_hash(&modified);

        assert_ne!(hash1, hash2, "tampered capsule must produce different hash");
    }

    #[test]
    fn test_redacted_display_hides_fields() {
        let capsule = make_capsule(RitualVerdict::Accepted);
        let view = redacted_display(&capsule);

        assert_eq!(view.verdict, "Accepted");
        assert_eq!(
            view.ritual_hash.len(),
            64,
            "ritual_hash hex must be 64 chars"
        );
        assert_eq!(view.shape_hash.len(), 64, "shape_hash hex must be 64 chars");
        // RedactedCapsuleView has no permission_hash/receipt_hash/nullifier_hash fields.
    }

    #[test]
    fn test_rejected_verdict_in_public_view() {
        let rejected = make_capsule(RitualVerdict::Rejected {
            reason: "missing permission".to_string(),
        });
        let accepted = make_capsule(RitualVerdict::Accepted);

        let view = redacted_display(&rejected);
        assert_eq!(view.verdict, "Rejected: missing permission");

        let hash_rejected = capsule_hash(&rejected);
        let hash_accepted = capsule_hash(&accepted);
        assert_ne!(
            hash_rejected, hash_accepted,
            "rejected and accepted capsule hashes must differ"
        );
    }
}
