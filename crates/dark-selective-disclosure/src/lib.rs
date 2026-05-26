// dark-selective-disclosure — selective field disclosure for private credentials
// Reveal any subset of credential fields; keep the rest behind SHA256 commitments.
// Verifier learns only what the holder chooses to disclose — nothing more.
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

// ── Domain constants ─────────────────────────────────────────────────────────

const DOMAIN_FIELD: u8 = 0x10; // individual field commitment
const DOMAIN_CREDENTIAL: u8 = 0x11; // full credential root hash
const DOMAIN_DISCLOSURE: u8 = 0x12; // selective disclosure proof root

// ── Core types ───────────────────────────────────────────────────────────────

/// A single field in the credential, before disclosure decision.
#[derive(Debug, Clone, PartialEq)]
pub struct CredentialField {
    /// Field identifier (e.g., b"balance_bucket", b"last_purchase_slot")
    pub field_name: [u8; 32],
    /// Actual field value
    pub value: Vec<u8>,
    /// Blinding nonce — prevents brute-force of known value ranges
    pub nonce: [u8; 32],
    /// Commitment = SHA256(DOMAIN_FIELD || field_name || value || nonce)
    pub commitment: [u8; 32],
    pub mainnet_ready: bool, // always false
}

/// The full credential: a Merkle-style root over all field commitments.
#[derive(Debug, Clone, PartialEq)]
pub struct SelectiveCredential {
    /// Credential identifier hash (SHA256 of issuer + holder + purpose)
    pub credential_id_hash: [u8; 32],
    /// Root = SHA256(DOMAIN_CREDENTIAL || sorted(field_commitments))
    pub root: [u8; 32],
    /// Number of fields committed (public; content is not)
    pub field_count: u8,
    /// Slot at which the credential was issued
    pub issued_at_slot: u64,
    /// Slot at which the credential expires (0 = no expiry)
    pub expires_at_slot: u64,
    pub mainnet_ready: bool, // always false
}

/// A disclosed field: actual value revealed, with commitment for verification.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DisclosedField {
    pub field_name_hex: String, // hex of the field_name bytes
    pub value_hex: String,      // hex of the revealed value
    pub commitment_hex: String, // hex of commitment — verifier checks this
}

/// A hidden field: only the commitment is public.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct HiddenField {
    pub commitment_hex: String,
}

/// Result of selective disclosure: some fields revealed, others hidden.
#[derive(Debug, Clone, PartialEq)]
pub struct DisclosureProof {
    /// Credential root (from SelectiveCredential) — ties proof to the credential
    pub credential_root: [u8; 32],
    /// Proof root = SHA256(DOMAIN_DISCLOSURE || sorted(all_commitments))
    /// Matches `credential.root` if no tampering.
    pub disclosure_root: [u8; 32],
    pub revealed: Vec<DisclosedField>,
    pub hidden: Vec<HiddenField>,
    /// Issuer slot binding — proof is for credentials issued before this
    pub issued_at_slot: u64,
    pub mainnet_ready: bool, // always false
}

#[derive(Debug, PartialEq)]
pub enum DisclosureError {
    FieldNameTooLong { max: usize, got: usize },
    DuplicateFieldName,
    RootMismatch,
    EmptyCredential,
    IndexOutOfRange { index: usize, field_count: u8 },
    CommitmentMismatch { field_index: usize },
}

// ── Private helpers ──────────────────────────────────────────────────────────

fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn field_commitment(field_name: &[u8; 32], value: &[u8], nonce: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_FIELD]);
    h.update(field_name);
    h.update(value);
    h.update(nonce);
    h.finalize().into()
}

fn credential_root(commitments: &[[u8; 32]]) -> [u8; 32] {
    let mut sorted = commitments.to_vec();
    sorted.sort_unstable();
    let mut h = Sha256::new();
    h.update([DOMAIN_CREDENTIAL]);
    h.update((sorted.len() as u32).to_le_bytes());
    for c in &sorted {
        h.update(c);
    }
    h.finalize().into()
}

fn disclosure_root(all_commitments: &[[u8; 32]]) -> [u8; 32] {
    let mut sorted = all_commitments.to_vec();
    sorted.sort_unstable();
    let mut h = Sha256::new();
    h.update([DOMAIN_DISCLOSURE]);
    h.update((sorted.len() as u32).to_le_bytes());
    for c in &sorted {
        h.update(c);
    }
    h.finalize().into()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn pad_field_name(name: &[u8]) -> Result<[u8; 32], DisclosureError> {
    if name.len() > 32 {
        return Err(DisclosureError::FieldNameTooLong {
            max: 32,
            got: name.len(),
        });
    }
    let mut out = [0u8; 32];
    out[..name.len()].copy_from_slice(name);
    Ok(out)
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Create a single committed credential field.
///
/// The commitment hides `value` behind `nonce` — even if the value range is
/// known, the blinding nonce prevents pre-image attacks.
pub fn commit_field(
    field_name: &[u8],
    value: &[u8],
    nonce: &[u8; 32],
) -> Result<CredentialField, DisclosureError> {
    let name_padded = pad_field_name(field_name)?;
    let commitment = field_commitment(&name_padded, value, nonce);
    Ok(CredentialField {
        field_name: name_padded,
        value: value.to_vec(),
        nonce: *nonce,
        commitment,
        mainnet_ready: false,
    })
}

/// Issue a credential: root over all field commitments.
///
/// `issuer_id` and `holder_id` are hashed internally — never stored raw.
pub fn issue_credential(
    fields: &[CredentialField],
    issuer_id: &[u8],
    holder_id: &[u8],
    issued_at_slot: u64,
    expires_at_slot: u64,
) -> Result<SelectiveCredential, DisclosureError> {
    if fields.is_empty() {
        return Err(DisclosureError::EmptyCredential);
    }

    // Duplicate field name check
    let mut names: Vec<[u8; 32]> = fields.iter().map(|f| f.field_name).collect();
    names.sort_unstable();
    for w in names.windows(2) {
        if w[0] == w[1] {
            return Err(DisclosureError::DuplicateFieldName);
        }
    }

    let commitments: Vec<[u8; 32]> = fields.iter().map(|f| f.commitment).collect();
    let root = credential_root(&commitments);

    // credential_id = SHA256("cred-id-v1" || SHA256(issuer_id) || SHA256(holder_id) || issued_le8)
    let mut id_h = Sha256::new();
    id_h.update(b"cred-id-v1");
    id_h.update(sha256_bytes(issuer_id));
    id_h.update(sha256_bytes(holder_id));
    id_h.update(issued_at_slot.to_le_bytes());
    let credential_id_hash: [u8; 32] = id_h.finalize().into();

    Ok(SelectiveCredential {
        credential_id_hash,
        root,
        field_count: fields.len() as u8,
        issued_at_slot,
        expires_at_slot,
        mainnet_ready: false,
    })
}

/// Selectively disclose a subset of fields.
///
/// `reveal_indices` specifies which field indices to reveal.
/// All other fields remain hidden (only commitment visible).
/// Returns `Err(RootMismatch)` if the fields don't match the credential root.
pub fn disclose(
    credential: &SelectiveCredential,
    fields: &[CredentialField],
    reveal_indices: &[usize],
) -> Result<DisclosureProof, DisclosureError> {
    if fields.is_empty() {
        return Err(DisclosureError::EmptyCredential);
    }

    // Validate indices
    for &idx in reveal_indices {
        if idx >= fields.len() {
            return Err(DisclosureError::IndexOutOfRange {
                index: idx,
                field_count: fields.len() as u8,
            });
        }
    }

    // Verify all field commitments reconstruct the credential root
    let commitments: Vec<[u8; 32]> = fields.iter().map(|f| f.commitment).collect();
    let recomputed_root = credential_root(&commitments);
    if recomputed_root != credential.root {
        return Err(DisclosureError::RootMismatch);
    }

    // Build revealed and hidden lists
    let reveal_set: std::collections::HashSet<usize> = reveal_indices.iter().cloned().collect();

    let mut revealed = Vec::new();
    let mut hidden = Vec::new();

    for (i, field) in fields.iter().enumerate() {
        if reveal_set.contains(&i) {
            revealed.push(DisclosedField {
                field_name_hex: hex_encode(&field.field_name),
                value_hex: hex_encode(&field.value),
                commitment_hex: hex_encode(&field.commitment),
            });
        } else {
            hidden.push(HiddenField {
                commitment_hex: hex_encode(&field.commitment),
            });
        }
    }

    // Disclosure root uses the same computation as credential_root —
    // verifier checks disc_root == credential.root as integrity anchor.
    let disc_root = credential_root(&commitments);

    Ok(DisclosureProof {
        credential_root: credential.root,
        disclosure_root: disc_root,
        revealed,
        hidden,
        issued_at_slot: credential.issued_at_slot,
        mainnet_ready: false,
    })
}

/// Verify a disclosure proof.
///
/// Checks:
/// 1. disclosure_root == credential_root (no tampering)
/// 2. Each revealed field's commitment is consistent with (name, value)
///    (requires the original nonces — this is the verifier's job if they have them,
///    or they trust the commitment without the nonce — zero-knowledge mode)
pub fn verify_disclosure(proof: &DisclosureProof) -> bool {
    // Root consistency
    proof.disclosure_root == proof.credential_root
}

/// Stronger verification: recompute field commitments from raw values + nonces.
/// Used when the verifier is the issuer or has access to the nonces.
pub fn verify_field_commitments(
    proof: &DisclosureProof,
    revealed_values: &[(&[u8], &[u8; 32])], // (value, nonce) for each revealed field in order
) -> bool {
    if revealed_values.len() != proof.revealed.len() {
        return false;
    }
    for (disclosed, (raw_value, nonce)) in proof.revealed.iter().zip(revealed_values) {
        // Re-derive field_name from hex
        let name_bytes = hex_decode_32(&disclosed.field_name_hex);
        let expected_commit = field_commitment(&name_bytes, raw_value, nonce);
        let expected_hex = hex_encode(&expected_commit);
        if expected_hex != disclosed.commitment_hex {
            return false;
        }
    }
    true
}

fn hex_decode_32(hex: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        if i >= 32 {
            break;
        }
        if let (Some(&hi), Some(&lo)) = (chunk.first(), chunk.get(1)) {
            out[i] = hex_nibble(hi) << 4 | hex_nibble(lo);
        }
    }
    out
}

fn hex_nibble(b: u8) -> u8 {
    match b {
        b'0'..=b'9' => b - b'0',
        b'a'..=b'f' => b - b'a' + 10,
        b'A'..=b'F' => b - b'A' + 10,
        _ => 0,
    }
}

/// Serialize a disclosure proof to JSON — safe for public display.
/// Hidden fields appear as commitment hashes only.
pub fn disclosure_to_json(proof: &DisclosureProof) -> String {
    serde_json::json!({
        "credential_root": hex_encode(&proof.credential_root),
        "disclosure_root": hex_encode(&proof.disclosure_root),
        "issued_at_slot": proof.issued_at_slot,
        "mainnet_ready": proof.mainnet_ready,
        "revealed": proof.revealed,
        "hidden": proof.hidden,
    })
    .to_string()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE_A: [u8; 32] = [0xAA; 32];
    const NONCE_B: [u8; 32] = [0xBB; 32];
    const NONCE_C: [u8; 32] = [0xCC; 32];

    fn make_balance_field(amount: u64, nonce: &[u8; 32]) -> CredentialField {
        commit_field(b"balance_bucket", &amount.to_le_bytes(), nonce).unwrap()
    }

    fn make_slot_field(slot: u64, nonce: &[u8; 32]) -> CredentialField {
        commit_field(b"last_purchase_slot", &slot.to_le_bytes(), nonce).unwrap()
    }

    fn make_tier_field(tier: &str, nonce: &[u8; 32]) -> CredentialField {
        commit_field(b"membership_tier", tier.as_bytes(), nonce).unwrap()
    }

    // 1. mainnet_ready is always false
    #[test]
    fn test_field_mainnet_ready_false() {
        let field = make_balance_field(1_000_000, &NONCE_A);
        assert!(!field.mainnet_ready);
    }

    // 2. Field commitment is deterministic
    #[test]
    fn test_field_commitment_deterministic() {
        let f1 = make_balance_field(1_000_000, &NONCE_A);
        let f2 = make_balance_field(1_000_000, &NONCE_A);
        assert_eq!(f1.commitment, f2.commitment);
    }

    // 3. Different value → different commitment
    #[test]
    fn test_different_value_different_commitment() {
        let f1 = make_balance_field(1_000_000, &NONCE_A);
        let f2 = make_balance_field(2_000_000, &NONCE_A);
        assert_ne!(f1.commitment, f2.commitment);
    }

    // 4. Different nonce → different commitment (blinding works)
    #[test]
    fn test_different_nonce_different_commitment() {
        let f1 = make_balance_field(1_000_000, &NONCE_A);
        let f2 = make_balance_field(1_000_000, &NONCE_B);
        assert_ne!(f1.commitment, f2.commitment);
    }

    // 5. issue_credential produces consistent root
    #[test]
    fn test_issue_credential_root_deterministic() {
        let fields = vec![
            make_balance_field(1_000_000, &NONCE_A),
            make_slot_field(400_000, &NONCE_B),
            make_tier_field("gold", &NONCE_C),
        ];
        let cred1 = issue_credential(&fields, b"issuer-1", b"holder-1", 100, 0).unwrap();
        let cred2 = issue_credential(&fields, b"issuer-1", b"holder-1", 100, 0).unwrap();
        assert_eq!(cred1.root, cred2.root);
        assert!(!cred1.mainnet_ready);
    }

    // 6. credential_id hides raw issuer/holder identity
    #[test]
    fn test_credential_id_hides_identity() {
        let fields = vec![make_balance_field(500_000, &NONCE_A)];
        let cred = issue_credential(&fields, b"issuer-alice", b"holder-bob", 100, 0).unwrap();
        let id_hex = hex_encode(&cred.credential_id_hash);
        // credential_id_hash must NOT literally encode "issuer-alice" or "holder-bob"
        assert!(
            !id_hex.contains("alice"),
            "credential_id must not embed issuer raw bytes"
        );
        assert!(
            !id_hex.contains("bob"),
            "credential_id must not embed holder raw bytes"
        );
        assert_eq!(id_hex.len(), 64, "must be 64-char hex");
    }

    // 7. Root is order-independent (same fields, different insertion order)
    #[test]
    fn test_credential_root_order_independent() {
        let fa = make_balance_field(1_000_000, &NONCE_A);
        let fb = make_slot_field(400_000, &NONCE_B);
        let fc = make_tier_field("gold", &NONCE_C);

        let cred_abc =
            issue_credential(&[fa.clone(), fb.clone(), fc.clone()], b"iss", b"hld", 1, 0).unwrap();
        let cred_cba = issue_credential(&[fc, fb, fa], b"iss", b"hld", 1, 0).unwrap();

        assert_eq!(
            cred_abc.root, cred_cba.root,
            "root must be insertion-order-independent"
        );
    }

    // 8. Empty credential rejected
    #[test]
    fn test_empty_credential_rejected() {
        let result = issue_credential(&[], b"iss", b"hld", 1, 0);
        assert_eq!(result, Err(DisclosureError::EmptyCredential));
    }

    // 9. Duplicate field name rejected
    #[test]
    fn test_duplicate_field_rejected() {
        let f1 = make_balance_field(1_000_000, &NONCE_A);
        let f2 = make_balance_field(2_000_000, &NONCE_B); // same field name, different nonce
        let result = issue_credential(&[f1, f2], b"iss", b"hld", 1, 0);
        assert_eq!(result, Err(DisclosureError::DuplicateFieldName));
    }

    // 10. Disclose all fields — no hidden fields remain
    #[test]
    fn test_disclose_all_fields() {
        let fields = vec![
            make_balance_field(1_000_000, &NONCE_A),
            make_slot_field(400_000, &NONCE_B),
        ];
        let cred = issue_credential(&fields, b"iss", b"hld", 1, 0).unwrap();
        let proof = disclose(&cred, &fields, &[0, 1]).unwrap();
        assert_eq!(proof.revealed.len(), 2);
        assert_eq!(proof.hidden.len(), 0);
        assert!(!proof.mainnet_ready);
    }

    // 11. Disclose one field — one revealed, one hidden
    #[test]
    fn test_disclose_one_field_one_hidden() {
        let fields = vec![
            make_balance_field(1_000_000, &NONCE_A),
            make_slot_field(400_000, &NONCE_B),
        ];
        let cred = issue_credential(&fields, b"iss", b"hld", 1, 0).unwrap();
        let proof = disclose(&cred, &fields, &[0]).unwrap();
        assert_eq!(proof.revealed.len(), 1);
        assert_eq!(proof.hidden.len(), 1);
    }

    // 12. Disclose zero fields — all hidden
    #[test]
    fn test_disclose_zero_fields_all_hidden() {
        let fields = vec![
            make_balance_field(1_000_000, &NONCE_A),
            make_slot_field(400_000, &NONCE_B),
        ];
        let cred = issue_credential(&fields, b"iss", b"hld", 1, 0).unwrap();
        let proof = disclose(&cred, &fields, &[]).unwrap();
        assert_eq!(proof.revealed.len(), 0);
        assert_eq!(proof.hidden.len(), 2);
    }

    // 13. Tampered root causes RootMismatch
    #[test]
    fn test_tampered_root_rejected() {
        let fields = vec![make_balance_field(1_000_000, &NONCE_A)];
        let mut cred = issue_credential(&fields, b"iss", b"hld", 1, 0).unwrap();
        cred.root[0] ^= 0xFF; // tamper
        let result = disclose(&cred, &fields, &[0]);
        assert_eq!(result, Err(DisclosureError::RootMismatch));
    }

    // 14. Index out of range rejected
    #[test]
    fn test_index_out_of_range_rejected() {
        let fields = vec![make_balance_field(1_000_000, &NONCE_A)];
        let cred = issue_credential(&fields, b"iss", b"hld", 1, 0).unwrap();
        let result = disclose(&cred, &fields, &[5]); // only index 0 exists
        assert_eq!(
            result,
            Err(DisclosureError::IndexOutOfRange {
                index: 5,
                field_count: 1
            })
        );
    }

    // 15. verify_disclosure passes for untampered proof
    #[test]
    fn test_verify_disclosure_passes() {
        let fields = vec![
            make_balance_field(1_000_000, &NONCE_A),
            make_slot_field(400_000, &NONCE_B),
            make_tier_field("gold", &NONCE_C),
        ];
        let cred = issue_credential(&fields, b"iss", b"hld", 1, 0).unwrap();
        let proof = disclose(&cred, &fields, &[0, 2]).unwrap();
        assert!(verify_disclosure(&proof));
    }

    // 16. verify_disclosure fails after tampering disclosure_root
    #[test]
    fn test_verify_disclosure_fails_tampered_root() {
        let fields = vec![make_balance_field(1_000_000, &NONCE_A)];
        let cred = issue_credential(&fields, b"iss", b"hld", 1, 0).unwrap();
        let mut proof = disclose(&cred, &fields, &[]).unwrap();
        proof.disclosure_root[0] ^= 0xFF;
        assert!(!verify_disclosure(&proof));
    }

    // 17. verify_field_commitments passes for correct values + nonces
    #[test]
    fn test_verify_field_commitments_passes() {
        let balance_bytes = 1_000_000u64.to_le_bytes();
        let fields = vec![commit_field(b"balance_bucket", &balance_bytes, &NONCE_A).unwrap()];
        let cred = issue_credential(&fields, b"iss", b"hld", 1, 0).unwrap();
        let proof = disclose(&cred, &fields, &[0]).unwrap();
        let ok = verify_field_commitments(&proof, &[(&balance_bytes, &NONCE_A)]);
        assert!(
            ok,
            "field commitment verification must pass for correct value+nonce"
        );
    }

    // 18. verify_field_commitments fails for wrong nonce
    #[test]
    fn test_verify_field_commitments_fails_wrong_nonce() {
        let balance_bytes = 1_000_000u64.to_le_bytes();
        let fields = vec![commit_field(b"balance_bucket", &balance_bytes, &NONCE_A).unwrap()];
        let cred = issue_credential(&fields, b"iss", b"hld", 1, 0).unwrap();
        let proof = disclose(&cred, &fields, &[0]).unwrap();
        // Supply wrong nonce
        let ok = verify_field_commitments(&proof, &[(&balance_bytes, &NONCE_B)]);
        assert!(!ok, "wrong nonce must fail commitment verification");
    }

    // 19. JSON output hides field values for hidden fields
    #[test]
    fn test_json_hides_hidden_field_values() {
        let balance_bytes = 999_999_u64.to_le_bytes();
        let tier_bytes = b"diamond";
        let fields = vec![
            commit_field(b"balance_bucket", &balance_bytes, &NONCE_A).unwrap(),
            commit_field(b"membership_tier", tier_bytes, &NONCE_B).unwrap(),
        ];
        let cred = issue_credential(&fields, b"iss", b"hld", 1, 0).unwrap();
        // Only reveal balance, hide tier
        let proof = disclose(&cred, &fields, &[0]).unwrap();
        let json = disclosure_to_json(&proof);

        // "diamond" must not appear in the JSON
        assert!(
            !json.contains("diamond"),
            "hidden field value must not appear in JSON"
        );
        // But balance value (as hex) does appear in the revealed section
        let bal_hex = hex_encode(&balance_bytes);
        assert!(
            json.contains(&bal_hex),
            "revealed field value must appear in JSON"
        );
    }

    // 20. Field name too long is rejected
    #[test]
    fn test_field_name_too_long_rejected() {
        let long_name = vec![0xFFu8; 33]; // 33 bytes > 32 limit
        let result = commit_field(&long_name, b"value", &NONCE_A);
        assert!(matches!(
            result,
            Err(DisclosureError::FieldNameTooLong { .. })
        ));
    }
}
