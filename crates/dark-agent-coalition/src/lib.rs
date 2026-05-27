use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoalitionMember {
    pub agent_id: [u8; 32],
    pub agent_pubkey: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Coalition {
    pub coalition_id: [u8; 32],
    pub members: Vec<CoalitionMember>,
    pub threshold: u8,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoalitionSignature {
    pub coalition_id: [u8; 32],
    pub message_hash: [u8; 32],
    pub partial_sigs: Vec<[u8; 32]>,
    pub aggregate_sig: [u8; 32],
    pub signer_count: u8,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum CoalitionError {
    EmptyMembers,
    ThresholdZero,
    ThresholdExceedsMembers,
    InsufficientSigners { need: u8, got: u8 },
}

// ── Internal hash helpers ────────────────────────────────────────────────────

fn sha256_tagged(tag: &[u8], data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(tag);
    h.update(data);
    h.finalize().into()
}

fn sha256_tagged3(tag: &[u8], a: &[u8], b: &[u8], c: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(tag);
    h.update(a);
    h.update(b);
    h.update(c);
    h.finalize().into()
}

/// XOR-fold a slice of 32-byte arrays into a single 32-byte array.
fn xor_fold(slices: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for s in slices {
        for (a, b) in acc.iter_mut().zip(s.iter()) {
            *a ^= b;
        }
    }
    acc
}

fn derive_pubkey(agent_secret: &[u8; 32]) -> [u8; 32] {
    sha256_tagged(b"coalition-agent-v1", agent_secret)
}

fn derive_agent_id(agent_pubkey: &[u8; 32]) -> [u8; 32] {
    sha256_tagged(b"coalition-id-v1", agent_pubkey)
}

fn derive_coalition_id(pubkeys: &[[u8; 32]], threshold: u8) -> [u8; 32] {
    let xor = xor_fold(pubkeys);
    sha256_tagged3(b"coalition-root-v1", &xor, &[threshold], &[])
}

fn derive_message_hash(message_bytes: &[u8]) -> [u8; 32] {
    sha256_tagged(b"coalition-msg-v1", message_bytes)
}

fn derive_partial_sig(
    coalition_id: &[u8; 32],
    message_hash: &[u8; 32],
    agent_secret: &[u8; 32],
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"coalition-partial-v1");
    h.update(coalition_id);
    h.update(message_hash);
    h.update(agent_secret);
    h.finalize().into()
}

fn derive_aggregate_sig(
    coalition_id: &[u8; 32],
    message_hash: &[u8; 32],
    partial_sigs: &[[u8; 32]],
) -> [u8; 32] {
    let xor = xor_fold(partial_sigs);
    sha256_tagged3(b"coalition-agg-v1", coalition_id, message_hash, &xor)
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Form a coalition from agent secrets.
///
/// `mainnet_ready` is always `false`.
pub fn form_coalition(
    agent_secrets: &[[u8; 32]],
    threshold: u8,
) -> Result<Coalition, CoalitionError> {
    if agent_secrets.is_empty() {
        return Err(CoalitionError::EmptyMembers);
    }
    if threshold == 0 {
        return Err(CoalitionError::ThresholdZero);
    }
    if threshold as usize > agent_secrets.len() {
        return Err(CoalitionError::ThresholdExceedsMembers);
    }

    let members: Vec<CoalitionMember> = agent_secrets
        .iter()
        .map(|secret| {
            let agent_pubkey = derive_pubkey(secret);
            let agent_id = derive_agent_id(&agent_pubkey);
            CoalitionMember {
                agent_id,
                agent_pubkey,
            }
        })
        .collect();

    let pubkeys: Vec<[u8; 32]> = members.iter().map(|m| m.agent_pubkey).collect();
    let coalition_id = derive_coalition_id(&pubkeys, threshold);

    Ok(Coalition {
        coalition_id,
        members,
        threshold,
        mainnet_ready: false, // CRITICAL: always false
    })
}

/// Sign a message with a subset of agent secrets.
///
/// `signing_secrets.len()` must be >= `coalition.threshold`.
/// `mainnet_ready` is always `false`.
pub fn sign_message(
    coalition: &Coalition,
    signing_secrets: &[[u8; 32]],
    message_bytes: &[u8],
) -> Result<CoalitionSignature, CoalitionError> {
    let need = coalition.threshold;
    let got = signing_secrets.len() as u8;
    if (got as usize) < need as usize {
        return Err(CoalitionError::InsufficientSigners { need, got });
    }

    let message_hash = derive_message_hash(message_bytes);

    let partial_sigs: Vec<[u8; 32]> = signing_secrets
        .iter()
        .map(|secret| derive_partial_sig(&coalition.coalition_id, &message_hash, secret))
        .collect();

    let aggregate_sig = derive_aggregate_sig(&coalition.coalition_id, &message_hash, &partial_sigs);

    Ok(CoalitionSignature {
        coalition_id: coalition.coalition_id,
        message_hash,
        partial_sigs,
        aggregate_sig,
        signer_count: got,
        mainnet_ready: false, // CRITICAL: always false
    })
}

/// Verify a coalition signature against the message bytes.
///
/// Recomputes `message_hash` and `aggregate_sig` from the stored partial sigs,
/// then checks that both match the values in `sig`.
pub fn verify_signature(
    coalition: &Coalition,
    sig: &CoalitionSignature,
    message_bytes: &[u8],
) -> bool {
    // Coalition ID must match
    if sig.coalition_id != coalition.coalition_id {
        return false;
    }

    // Recompute message hash
    let expected_message_hash = derive_message_hash(message_bytes);
    if sig.message_hash != expected_message_hash {
        return false;
    }

    // Recompute aggregate sig from stored partial sigs
    let expected_agg = derive_aggregate_sig(
        &coalition.coalition_id,
        &sig.message_hash,
        &sig.partial_sigs,
    );
    if sig.aggregate_sig != expected_agg {
        return false;
    }

    true
}

/// Return a JSON public record for the coalition (no secrets).
pub fn coalition_public_record(coalition: &Coalition) -> String {
    let coalition_id_hex = hex_encode(&coalition.coalition_id);
    serde_json::json!({
        "coalition_id": coalition_id_hex,
        "member_count": coalition.members.len(),
        "threshold": coalition.threshold,
        "mainnet_ready": coalition.mainnet_ready,
    })
    .to_string()
}

// ── Tiny hex encoder (no external dep) ──────────────────────────────────────

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(seed: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = seed;
        s
    }

    /// 1. Form coalition with 3 agents, threshold=2, sign with 2, verify true; mainnet_ready=false.
    #[test]
    fn test_form_sign_verify() {
        let secrets = [secret(1), secret(2), secret(3)];
        let coalition = form_coalition(&secrets, 2).unwrap();

        assert_eq!(coalition.threshold, 2);
        assert_eq!(coalition.members.len(), 3);
        assert!(!coalition.mainnet_ready, "mainnet_ready must be false");

        let signing = [secret(1), secret(2)];
        let sig = sign_message(&coalition, &signing, b"hello world").unwrap();

        assert!(!sig.mainnet_ready, "mainnet_ready must be false");
        assert!(verify_signature(&coalition, &sig, b"hello world"));
    }

    /// 2. Signing with fewer signers than threshold returns InsufficientSigners.
    #[test]
    fn test_insufficient_signers_rejected() {
        let secrets = [secret(1), secret(2), secret(3)];
        let coalition = form_coalition(&secrets, 3).unwrap();

        let signing = [secret(1), secret(2)]; // only 2, need 3
        let err = sign_message(&coalition, &signing, b"test").unwrap_err();

        assert_eq!(err, CoalitionError::InsufficientSigners { need: 3, got: 2 });
    }

    /// 3. Threshold > member count returns ThresholdExceedsMembers.
    #[test]
    fn test_threshold_exceeds_members_rejected() {
        let secrets = [secret(1), secret(2)];
        let err = form_coalition(&secrets, 5).unwrap_err();
        assert_eq!(err, CoalitionError::ThresholdExceedsMembers);
    }

    /// 4. Same secrets + message → same aggregate_sig (deterministic).
    #[test]
    fn test_aggregate_sig_deterministic() {
        let secrets = [secret(10), secret(20), secret(30)];
        let coalition = form_coalition(&secrets, 2).unwrap();
        let signing = [secret(10), secret(20)];
        let msg = b"deterministic test";

        let sig1 = sign_message(&coalition, &signing, msg).unwrap();
        let sig2 = sign_message(&coalition, &signing, msg).unwrap();

        assert_eq!(sig1.aggregate_sig, sig2.aggregate_sig);
    }

    /// 5. Same coalition, different messages → different aggregate_sig.
    #[test]
    fn test_different_messages_different_sigs() {
        let secrets = [secret(7), secret(8)];
        let coalition = form_coalition(&secrets, 2).unwrap();
        let signing = [secret(7), secret(8)];

        let sig_a = sign_message(&coalition, &signing, b"message A").unwrap();
        let sig_b = sign_message(&coalition, &signing, b"message B").unwrap();

        assert_ne!(
            sig_a.aggregate_sig, sig_b.aggregate_sig,
            "different messages must produce different aggregate sigs"
        );
    }

    /// 6. coalition_public_record does NOT expose any agent pubkey hex.
    #[test]
    fn test_public_record_hides_agents() {
        let secrets = [secret(42), secret(99), secret(77)];
        let coalition = form_coalition(&secrets, 2).unwrap();

        let record = coalition_public_record(&coalition);

        // The record must contain the coalition_id field
        assert!(record.contains("coalition_id"));

        // None of the individual agent pubkey hexes should appear verbatim
        for member in &coalition.members {
            let pubkey_hex = hex_encode(&member.agent_pubkey);
            assert!(
                !record.contains(&pubkey_hex),
                "public record must not expose agent pubkey: {}",
                pubkey_hex
            );
        }
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_always_false() {
        let secrets = [secret(1), secret(2)];
        let coalition = form_coalition(&secrets, 2).unwrap();
        assert!(!coalition.mainnet_ready);
        let sig = sign_message(&coalition, &secrets, b"msg").unwrap();
        assert!(!sig.mainnet_ready);
    }

    #[test]
    fn test_coalition_id_deterministic() {
        let secrets = [secret(5), secret(6)];
        let c1 = form_coalition(&secrets, 2).unwrap();
        let c2 = form_coalition(&secrets, 2).unwrap();
        assert_eq!(c1.coalition_id, c2.coalition_id);
    }

    #[test]
    fn test_coalition_id_secret_sensitive() {
        let s1 = [secret(1), secret(2)];
        let s2 = [secret(1), secret(3)];
        let c1 = form_coalition(&s1, 2).unwrap();
        let c2 = form_coalition(&s2, 2).unwrap();
        assert_ne!(c1.coalition_id, c2.coalition_id);
    }

    #[test]
    fn test_threshold_zero_rejected() {
        let err = form_coalition(&[secret(1)], 0).unwrap_err();
        assert_eq!(err, CoalitionError::ThresholdZero);
    }

    #[test]
    fn test_empty_members_rejected() {
        let err = form_coalition(&[], 1).unwrap_err();
        assert_eq!(err, CoalitionError::EmptyMembers);
    }

    #[test]
    fn test_verify_wrong_message_false() {
        let secrets = [secret(11), secret(12)];
        let coalition = form_coalition(&secrets, 2).unwrap();
        let sig = sign_message(&coalition, &secrets, b"correct message").unwrap();
        assert!(!verify_signature(&coalition, &sig, b"wrong message"));
    }

    #[test]
    fn test_partial_sigs_count_equals_signers() {
        let secrets = [secret(20), secret(21), secret(22)];
        let coalition = form_coalition(&secrets, 2).unwrap();
        let signing = [secret(20), secret(21)];
        let sig = sign_message(&coalition, &signing, b"msg").unwrap();
        assert_eq!(sig.partial_sigs.len(), 2);
        assert_eq!(sig.signer_count, 2);
    }

    #[test]
    fn test_public_record_member_count_correct() {
        let secrets = [secret(30), secret(31), secret(32)];
        let coalition = form_coalition(&secrets, 2).unwrap();
        let record = coalition_public_record(&coalition);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert_eq!(v["member_count"], 3u64);
    }

    #[test]
    fn test_signing_one_of_one_threshold_one() {
        let secrets = [secret(50)];
        let coalition = form_coalition(&secrets, 1).unwrap();
        let sig = sign_message(&coalition, &secrets, b"solo").unwrap();
        assert!(verify_signature(&coalition, &sig, b"solo"));
    }

    #[test]
    fn test_coalition_id_sensitive_to_threshold() {
        let secrets = [secret(1), secret(2)];
        let c1 = form_coalition(&secrets, 1).unwrap();
        let c2 = form_coalition(&secrets, 2).unwrap();
        assert_ne!(c1.coalition_id, c2.coalition_id);
    }
}
