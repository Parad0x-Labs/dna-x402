use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashEvidence {
    pub evidence_id: [u8; 32],
    pub validator_hash: [u8; 32],
    pub offense_hash: [u8; 32],
    pub epoch: u64,
    pub witness_hash: [u8; 32],
    pub verdicted: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashVerdict {
    pub verdict_id: [u8; 32],
    pub evidence_id: [u8; 32],
    pub slashed: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum SlashError {
    ZeroValidatorSecret,
    EmptyOffense,
    ZeroWitnessSecret,
    AlreadyVerdicted,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

// ── API ────────────────────────────────────────────────────────────────────

/// Submits evidence of validator misbehavior.
///
/// validator_hash = SHA256("slash-validator-v1" || validator_secret)
/// offense_hash   = SHA256("slash-offense-v1"   || offense_bytes)
/// witness_hash   = SHA256("slash-witness-v1"   || witness_secret)
/// evidence_id    = SHA256("slash-evidence-v1"  || validator_hash || offense_hash || epoch_le || witness_hash)
pub fn submit_evidence(
    validator_secret: &[u8; 32],
    offense_bytes: &[u8],
    epoch: u64,
    witness_secret: &[u8; 32],
) -> Result<SlashEvidence, SlashError> {
    if validator_secret == &[0u8; 32] {
        return Err(SlashError::ZeroValidatorSecret);
    }
    if offense_bytes.is_empty() {
        return Err(SlashError::EmptyOffense);
    }
    if witness_secret == &[0u8; 32] {
        return Err(SlashError::ZeroWitnessSecret);
    }

    let validator_hash = sha256_multi(&[b"slash-validator-v1", validator_secret]);
    let offense_hash = sha256_multi(&[b"slash-offense-v1", offense_bytes]);
    let witness_hash = sha256_multi(&[b"slash-witness-v1", witness_secret]);
    let evidence_id = sha256_multi(&[
        b"slash-evidence-v1",
        &validator_hash,
        &offense_hash,
        &epoch.to_le_bytes(),
        &witness_hash,
    ]);

    Ok(SlashEvidence {
        evidence_id,
        validator_hash,
        offense_hash,
        epoch,
        witness_hash,
        verdicted: false,
        mainnet_ready: false,
    })
}

/// Renders a verdict on the evidence.
/// verdict_id = SHA256("slash-verdict-v1" || evidence_id || [slashed as u8])
pub fn render_verdict(
    evidence: &mut SlashEvidence,
    slashed: bool,
) -> Result<SlashVerdict, SlashError> {
    if evidence.verdicted {
        return Err(SlashError::AlreadyVerdicted);
    }

    let slashed_byte = [slashed as u8];
    let verdict_id = sha256_multi(&[b"slash-verdict-v1", &evidence.evidence_id, &slashed_byte]);

    evidence.verdicted = true;

    Ok(SlashVerdict {
        verdict_id,
        evidence_id: evidence.evidence_id,
        slashed,
        mainnet_ready: false,
    })
}

/// Structural check: evidence_id is non-zero.
pub fn verify_evidence(evidence: &SlashEvidence) -> bool {
    evidence.evidence_id != [0u8; 32]
}

/// JSON: evidence_id, offense_hash, epoch, mainnet_ready — NOT validator_hash or witness_hash.
pub fn evidence_public_record(evidence: &SlashEvidence) -> String {
    serde_json::json!({
        "evidence_id": hex32(&evidence.evidence_id),
        "offense_hash": hex32(&evidence.offense_hash),
        "epoch": evidence.epoch,
        "mainnet_ready": evidence.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b;
        s
    }

    #[test]
    fn test_submit_and_render_verdict() {
        let mut ev = submit_evidence(&secret(0x01), b"double-vote", 42, &secret(0x02)).unwrap();
        assert!(!ev.mainnet_ready);
        assert!(!ev.verdicted);

        let verdict = render_verdict(&mut ev, true).unwrap();
        assert!(!verdict.mainnet_ready);
        assert!(verdict.slashed);
        assert_eq!(verdict.evidence_id, ev.evidence_id);
        assert!(ev.verdicted);
    }

    #[test]
    fn test_already_verdicted_rejected() {
        let mut ev = submit_evidence(&secret(0x03), b"equivocation", 1, &secret(0x04)).unwrap();
        render_verdict(&mut ev, true).unwrap();
        let err = render_verdict(&mut ev, false).unwrap_err();
        assert_eq!(err, SlashError::AlreadyVerdicted);
    }

    #[test]
    fn test_zero_validator_rejected() {
        let err = submit_evidence(&[0u8; 32], b"offense", 0, &secret(0x05)).unwrap_err();
        assert_eq!(err, SlashError::ZeroValidatorSecret);
    }

    #[test]
    fn test_empty_offense_rejected() {
        let err = submit_evidence(&secret(0x06), b"", 0, &secret(0x07)).unwrap_err();
        assert_eq!(err, SlashError::EmptyOffense);
    }

    #[test]
    fn test_evidence_id_deterministic() {
        let ev1 = submit_evidence(&secret(0x08), b"surround-vote", 99, &secret(0x09)).unwrap();
        let ev2 = submit_evidence(&secret(0x08), b"surround-vote", 99, &secret(0x09)).unwrap();
        assert_eq!(ev1.evidence_id, ev2.evidence_id);

        // different epoch → different evidence_id
        let ev3 = submit_evidence(&secret(0x08), b"surround-vote", 100, &secret(0x09)).unwrap();
        assert_ne!(ev1.evidence_id, ev3.evidence_id);
    }

    #[test]
    fn test_public_record_hides_validator_and_witness() {
        let ev = submit_evidence(&secret(0x10), b"invalid-block", 7, &secret(0x11)).unwrap();
        let rec = evidence_public_record(&ev);
        let v: serde_json::Value = serde_json::from_str(&rec).unwrap();
        assert!(v["evidence_id"].is_string());
        assert_eq!(v["epoch"], 7u64);
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("validator_hash").is_none());
        assert!(v.get("witness_hash").is_none());
        assert!(!rec.contains(&hex32(&ev.validator_hash)));
        assert!(!rec.contains(&hex32(&ev.witness_hash)));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_always_false() {
        let ev = submit_evidence(&secret(0x20), b"offense", 1, &secret(0x21)).unwrap();
        assert!(!ev.mainnet_ready);
        let mut ev2 = submit_evidence(&secret(0x20), b"offense", 1, &secret(0x21)).unwrap();
        let verdict = render_verdict(&mut ev2, true).unwrap();
        assert!(!verdict.mainnet_ready);
    }

    #[test]
    fn test_zero_witness_rejected() {
        let err = submit_evidence(&secret(0x22), b"offense", 1, &[0u8; 32]).unwrap_err();
        assert_eq!(err, SlashError::ZeroWitnessSecret);
    }

    #[test]
    fn test_different_offenses_different_evidence_ids() {
        let ev1 = submit_evidence(&secret(0x30), b"double-vote", 1, &secret(0x31)).unwrap();
        let ev2 = submit_evidence(&secret(0x30), b"surround-vote", 1, &secret(0x31)).unwrap();
        assert_ne!(ev1.evidence_id, ev2.evidence_id);
    }

    #[test]
    fn test_evidence_id_not_zero() {
        let ev = submit_evidence(&secret(0x40), b"equivocation", 7, &secret(0x41)).unwrap();
        assert_ne!(ev.evidence_id, [0u8; 32]);
    }

    #[test]
    fn test_verdict_id_deterministic() {
        let mut ev1 = submit_evidence(&secret(0x50), b"offense", 1, &secret(0x51)).unwrap();
        let mut ev2 = submit_evidence(&secret(0x50), b"offense", 1, &secret(0x51)).unwrap();
        let v1 = render_verdict(&mut ev1, true).unwrap();
        let v2 = render_verdict(&mut ev2, true).unwrap();
        assert_eq!(v1.verdict_id, v2.verdict_id);
    }

    #[test]
    fn test_slashed_true_stored() {
        let mut ev = submit_evidence(&secret(0x60), b"offense", 1, &secret(0x61)).unwrap();
        let verdict = render_verdict(&mut ev, true).unwrap();
        assert!(verdict.slashed);
    }

    #[test]
    fn test_slashed_false_stored() {
        let mut ev = submit_evidence(&secret(0x70), b"offense", 1, &secret(0x71)).unwrap();
        let verdict = render_verdict(&mut ev, false).unwrap();
        assert!(!verdict.slashed);
    }

    #[test]
    fn test_public_record_has_offense_hash() {
        let ev = submit_evidence(&secret(0x80), b"double-sign", 5, &secret(0x81)).unwrap();
        let rec = evidence_public_record(&ev);
        let v: serde_json::Value = serde_json::from_str(&rec).unwrap();
        assert!(v["offense_hash"].is_string());
        assert_eq!(v["epoch"], 5u64);
    }

    #[test]
    fn test_verdicted_flag_set_after_verdict() {
        let mut ev = submit_evidence(&secret(0x90), b"offense", 1, &secret(0x91)).unwrap();
        assert!(!ev.verdicted);
        render_verdict(&mut ev, true).unwrap();
        assert!(ev.verdicted);
    }

    #[test]
    fn test_evidence_verify_returns_true() {
        let ev = submit_evidence(&secret(0xA0), b"offense", 1, &secret(0xA1)).unwrap();
        assert!(verify_evidence(&ev));
    }
}
