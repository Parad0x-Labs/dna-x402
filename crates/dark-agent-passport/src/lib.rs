//! dark-agent-passport — ZK identity and reputation for AI agents
//!
//! The keystone of the Dark Null agent economy. An AI agent accumulates a
//! verifiable reputation from its x402 payment history — without ever exposing
//! a wallet address, which APIs it used, or when it paid.
//!
//! What a passport proves to a new API provider:
//!   "I am a trustworthy agent. I have made ≥ N payments across ≥ P programs
//!    totalling ≥ V lamports, active since epoch E — and I can prove this
//!    without showing you any of those individual payments."
//!
//! Key properties:
//!   - No fixed wallet address (uses dark-x402-stealth per payment)
//!   - Reputation carries across sessions (same spend key, new session key)
//!   - Cannot be Sybil-attacked (you cannot clone a passport without its receipts)
//!   - Selective disclosure: prove a claim without revealing the underlying data
//!
//! Reputation score (0–1000):
//!   base      = min(500, receipt_count × 5)        ← volume of activity
//!   diversity = min(200, program_count × 40)        ← breadth of usage
//!   longevity = min(200, epoch_span / 10)           ← time active
//!   volume    = 100 if total > 10M lamports else 0  ← skin in the game
//!
//! IS_STUB      = true  (proof is SHA-256 gate; Phase 2 uses Groth16)
//! MAINNET_READY = false

use sha2::{Digest, Sha256};

pub const IS_STUB: bool = true;
pub const MAINNET_READY: bool = false;

pub const MAX_REPUTATION_SCORE: u64 = 1000;

// ── domain tags ───────────────────────────────────────────────────────────────
const DOMAIN_PASSPORT_ID:     &[u8] = b"dark-passport-id-v1";
const DOMAIN_REP_ROOT:        &[u8] = b"dark-passport-rep-root-v1";
const DOMAIN_ATTESTATION:     &[u8] = b"dark-passport-attest-v1";

// ── error ─────────────────────────────────────────────────────────────────────
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum PassportError {
    ZeroSpendKey,
    ZeroReceiptHash,
    ZeroProgramId,
    ClaimExceedsActual,
    PassportIdMismatch,
    NoReceipts,
}

impl core::fmt::Display for PassportError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::ZeroSpendKey       => write!(f, "spend key must not be all zeros"),
            Self::ZeroReceiptHash    => write!(f, "receipt hash must not be all zeros"),
            Self::ZeroProgramId      => write!(f, "program id must not be all zeros"),
            Self::ClaimExceedsActual => write!(f, "attestation claim exceeds actual passport values"),
            Self::PassportIdMismatch => write!(f, "attestation passport_id does not match"),
            Self::NoReceipts         => write!(f, "passport has no receipts to attest"),
        }
    }
}

// ── types ─────────────────────────────────────────────────────────────────────

/// A single payment receipt entry inside a passport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PassportReceipt {
    pub receipt_hash:  [u8; 32],
    pub program_id:    [u8; 32],
    pub amount_commit: [u8; 32], // hides individual amount
    pub epoch:         u64,
}

/// An AI agent's ZK identity built from its x402 payment history.
///
/// The `passport_id` is derived from the spend key commitment — it identifies
/// the agent across sessions without revealing any wallet address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentPassport {
    /// Stable agent identifier: H(spend_key_commitment). Never links to a wallet.
    pub passport_id: [u8; 32],
    /// Commitment to the spend key (hides actual key).
    pub spend_key_commitment: [u8; 32],
    /// Rolling Merkle root over all payment receipts.
    pub reputation_root: [u8; 32],
    /// Number of successful payments.
    pub receipt_count: u64,
    /// Commitment to total lamports (hides exact volume).
    pub volume_commitment: [u8; 32],
    /// Number of distinct programs used (diversity metric).
    pub program_count: u32,
    /// Epoch of first recorded payment.
    pub first_payment_epoch: u64,
    /// Epoch of most recent payment.
    pub last_payment_epoch: u64,
    /// Composite reputation score 0–1000.
    pub reputation_score: u64,
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

/// A selective-disclosure attestation: proves claims about the passport
/// without revealing any underlying payment data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PassportAttestation {
    /// Identifies which passport this attestation is for.
    pub passport_id: [u8; 32],
    /// Minimum receipt count claimed ("I have at least this many payments").
    pub claim_min_receipts: u64,
    /// Minimum reputation score claimed.
    pub claim_min_score: u64,
    /// Claimed active-since epoch.
    pub claim_active_since: u64,
    /// Stub proof: H(domain || passport_id || claims...).
    /// Phase 2: Groth16 proof of Merkle membership + score bound.
    pub proof: [u8; 64],
    pub is_stub: bool,
}

// ── core functions ────────────────────────────────────────────────────────────

/// Create a new empty passport from an agent's spend key.
pub fn create_passport(spend_key: &[u8; 32]) -> Result<AgentPassport, PassportError> {
    if spend_key == &[0u8; 32] {
        return Err(PassportError::ZeroSpendKey);
    }

    let spend_key_commitment: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"dark-spend-commit-v1");
        h.update(spend_key);
        h.finalize().into()
    };

    let passport_id: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(DOMAIN_PASSPORT_ID);
        h.update(&spend_key_commitment);
        h.finalize().into()
    };

    Ok(AgentPassport {
        passport_id,
        spend_key_commitment,
        reputation_root:     [0u8; 32],
        receipt_count:       0,
        volume_commitment:   [0u8; 32],
        program_count:       0,
        first_payment_epoch: 0,
        last_payment_epoch:  0,
        reputation_score:    0,
        is_stub:             IS_STUB,
        mainnet_ready:       MAINNET_READY,
    })
}

/// Add a payment receipt to the passport and recompute reputation.
pub fn add_receipt(
    passport:       &mut AgentPassport,
    receipt_hash:   &[u8; 32],
    program_id:     &[u8; 32],
    amount_commit:  &[u8; 32],
    epoch:          u64,
    is_new_program: bool,
) -> Result<(), PassportError> {
    if receipt_hash == &[0u8; 32] {
        return Err(PassportError::ZeroReceiptHash);
    }
    if program_id == &[0u8; 32] {
        return Err(PassportError::ZeroProgramId);
    }

    // Update rolling reputation root
    passport.reputation_root = {
        let mut h = Sha256::new();
        h.update(DOMAIN_REP_ROOT);
        h.update(&passport.reputation_root);
        h.update(receipt_hash);
        h.update(program_id);
        h.update(amount_commit);
        h.update(epoch.to_le_bytes());
        h.finalize().into()
    };

    // Update volume commitment: H(old_commit || amount_commit)
    passport.volume_commitment = {
        let mut h = Sha256::new();
        h.update(b"dark-volume-acc-v1");
        h.update(&passport.volume_commitment);
        h.update(amount_commit);
        h.finalize().into()
    };

    passport.receipt_count += 1;
    if is_new_program { passport.program_count += 1; }
    if passport.first_payment_epoch == 0 || epoch < passport.first_payment_epoch {
        passport.first_payment_epoch = epoch;
    }
    if epoch > passport.last_payment_epoch {
        passport.last_payment_epoch = epoch;
    }

    passport.reputation_score = compute_score(
        passport.receipt_count,
        passport.program_count,
        passport.last_payment_epoch.saturating_sub(passport.first_payment_epoch),
        false, // volume_tier unknown without actual amounts (stub)
    );

    Ok(())
}

/// Compute reputation score 0–1000.
pub fn compute_score(
    receipt_count: u64,
    program_count: u32,
    epoch_span:    u64,
    high_volume:   bool,
) -> u64 {
    let base      = (receipt_count * 5).min(500);
    let diversity = ((program_count as u64) * 40).min(200);
    let longevity = (epoch_span / 10).min(200);
    let volume    = if high_volume { 100 } else { 0 };
    (base + diversity + longevity + volume).min(MAX_REPUTATION_SCORE)
}

/// Create a selective-disclosure attestation from the passport.
///
/// Proves claims about the passport without revealing individual receipts.
/// API provider can verify without learning anything about the underlying payments.
pub fn create_attestation(
    passport:         &AgentPassport,
    claim_min_receipts: u64,
    claim_min_score:    u64,
    claim_active_since: u64,
) -> Result<PassportAttestation, PassportError> {
    if passport.receipt_count == 0 {
        return Err(PassportError::NoReceipts);
    }
    if claim_min_receipts > passport.receipt_count {
        return Err(PassportError::ClaimExceedsActual);
    }
    if claim_min_score > passport.reputation_score {
        return Err(PassportError::ClaimExceedsActual);
    }
    if claim_active_since < passport.first_payment_epoch {
        return Err(PassportError::ClaimExceedsActual);
    }

    // STUB LEAK WARNING (IS_STUB=true): the proof field is a 64-byte stub composed of:
    //   proof[0..32]  = SHA-256 gate over (domain || passport_id || reputation_root || claims)
    //   proof[32..64] = reputation_root verbatim
    //
    // Embedding reputation_root verbatim in the attestation bytes is safe here ONLY
    // because this is a stub — the verifier already has the reputation_root (it passes
    // it into verify_attestation) and checks proof[32..64] == reputation_root to detect
    // tampering. No new information leaks to the verifier beyond what they already hold.
    //
    // HOWEVER: when IS_STUB is flipped to false and replaced by a Groth16 proof, this
    // field MUST NOT embed reputation_root in plaintext. A Groth16 attestation should
    // commit to reputation_root as a circuit public input — never expose it as raw bytes.
    // Embedding it verbatim in a production attestation:
    //   (a) leaks the rolling hash of all payment receipts to the verifier,
    //   (b) makes the attestation forgeable — anyone who knows reputation_root can
    //       construct a fake proof[0..32] by re-hashing the same inputs, bypassing the
    //       ZK guarantee entirely if the verifier trusts a reputation_root passed by
    //       the prover rather than one fetched from an authoritative on-chain source.
    //
    // Gate: this code path is safe while IS_STUB=true and attestations are used only
    // in off-chain trust contexts (not on-chain program calls). Any on-chain use before
    // IS_STUB flips is a security regression.
    //
    // TODO (Phase 2): replace this 64-byte SHA-256 stub with a Groth16 proof where:
    //   public inputs = [passport_id, claim_min_receipts, claim_min_score, claim_active_since]
    //   private inputs = [reputation_root, all receipt hashes that open the Merkle root]
    debug_assert!(IS_STUB, "proof[32..64] must not embed reputation_root verbatim in non-stub mode");

    let mut proof = [0u8; 64];
    let gate: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(DOMAIN_ATTESTATION);
        h.update(&passport.passport_id);
        h.update(&passport.reputation_root);
        h.update(claim_min_receipts.to_le_bytes());
        h.update(claim_min_score.to_le_bytes());
        h.update(claim_active_since.to_le_bytes());
        h.finalize().into()
    };
    proof[..32].copy_from_slice(&gate);
    proof[32..64].copy_from_slice(&passport.reputation_root);

    Ok(PassportAttestation {
        passport_id:        passport.passport_id,
        claim_min_receipts,
        claim_min_score,
        claim_active_since,
        proof,
        is_stub:            IS_STUB,
    })
}

/// Verify a passport attestation.
///
/// The verifier (API provider) calls this with the passport_id they have on file.
/// Returns true if the attestation is cryptographically valid.
pub fn verify_attestation(
    attestation: &PassportAttestation,
    reputation_root: &[u8; 32],
) -> bool {
    let expected: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(DOMAIN_ATTESTATION);
        h.update(&attestation.passport_id);
        h.update(reputation_root);
        h.update(attestation.claim_min_receipts.to_le_bytes());
        h.update(attestation.claim_min_score.to_le_bytes());
        h.update(attestation.claim_active_since.to_le_bytes());
        h.finalize().into()
    };
    attestation.proof[..32] == expected
        && &attestation.proof[32..64] == reputation_root.as_ref()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spend_key() -> [u8; 32] { let mut k = [0u8; 32]; k[0] = 0xAA; k[31] = 0x01; k }
    fn prog(n: u8) -> [u8; 32] { let mut p = [0u8; 32]; p[0] = 0xBB; p[1] = n; p }
    fn rh(n: u8)  -> [u8; 32] { let mut r = [0u8; 32]; r[0] = 0xCC; r[1] = n; r }
    fn ac(n: u8)  -> [u8; 32] { let mut a = [0u8; 32]; a[0] = 0xDD; a[1] = n; a }

    fn passport_with_receipts(n: u8) -> AgentPassport {
        let mut p = create_passport(&spend_key()).unwrap();
        for i in 0..n {
            add_receipt(&mut p, &rh(i), &prog(i % 3), &ac(i), 100 + i as u64, i % 3 == 0).unwrap();
        }
        p
    }

    // 1. constants
    #[test]
    fn test_constants() {
        assert!(IS_STUB);
        assert!(!MAINNET_READY);
        assert_eq!(MAX_REPUTATION_SCORE, 1000);
    }

    // 2. create_passport gives unique passport_id per spend_key
    #[test]
    fn test_passport_id_unique() {
        let p1 = create_passport(&spend_key()).unwrap();
        let mut k2 = spend_key(); k2[5] ^= 0xFF;
        let p2 = create_passport(&k2).unwrap();
        assert_ne!(p1.passport_id, p2.passport_id);
    }

    // 3. passport_id != spend_key (hides the key)
    #[test]
    fn test_passport_id_hides_spend_key() {
        let p = create_passport(&spend_key()).unwrap();
        assert_ne!(p.passport_id, spend_key());
        assert_ne!(p.spend_key_commitment, spend_key());
    }

    // 4. passport_id is deterministic
    #[test]
    fn test_passport_id_deterministic() {
        let p1 = create_passport(&spend_key()).unwrap();
        let p2 = create_passport(&spend_key()).unwrap();
        assert_eq!(p1.passport_id, p2.passport_id);
    }

    // 5. add_receipt increments count
    #[test]
    fn test_add_receipt_increments_count() {
        let mut p = create_passport(&spend_key()).unwrap();
        add_receipt(&mut p, &rh(1), &prog(1), &ac(1), 100, true).unwrap();
        assert_eq!(p.receipt_count, 1);
        add_receipt(&mut p, &rh(2), &prog(2), &ac(2), 101, true).unwrap();
        assert_eq!(p.receipt_count, 2);
    }

    // 6. reputation_root changes with each receipt
    #[test]
    fn test_reputation_root_changes() {
        let mut p = create_passport(&spend_key()).unwrap();
        let r0 = p.reputation_root;
        add_receipt(&mut p, &rh(1), &prog(1), &ac(1), 100, true).unwrap();
        assert_ne!(p.reputation_root, r0);
    }

    // 7. program_count tracks distinct programs
    #[test]
    fn test_program_count_tracks_diversity() {
        let mut p = create_passport(&spend_key()).unwrap();
        add_receipt(&mut p, &rh(1), &prog(1), &ac(1), 100, true).unwrap();
        add_receipt(&mut p, &rh(2), &prog(2), &ac(2), 101, true).unwrap();
        add_receipt(&mut p, &rh(3), &prog(1), &ac(3), 102, false).unwrap();
        assert_eq!(p.program_count, 2);
    }

    // 8. reputation score increases with more receipts
    #[test]
    fn test_reputation_score_grows() {
        let p5  = passport_with_receipts(5);
        let p20 = passport_with_receipts(20);
        assert!(p20.reputation_score > p5.reputation_score);
    }

    // 9. reputation score never exceeds 1000
    #[test]
    fn test_reputation_score_capped() {
        let p = passport_with_receipts(200);
        assert!(p.reputation_score <= MAX_REPUTATION_SCORE);
    }

    // 10. compute_score formula
    #[test]
    fn test_compute_score_formula() {
        let s = compute_score(100, 5, 1000, true);
        // base = min(500, 500) = 500, diversity = min(200, 200) = 200
        // longevity = min(200, 100) = 100, volume = 100
        assert_eq!(s, 900);
    }

    // 11. create_attestation succeeds with valid claims
    #[test]
    fn test_create_attestation_succeeds() {
        let p = passport_with_receipts(10);
        let att = create_attestation(&p, 5, 0, p.first_payment_epoch).unwrap();
        assert_eq!(att.passport_id, p.passport_id);
        assert!(att.is_stub);
    }

    // 12. verify_attestation passes for valid attestation
    #[test]
    fn test_verify_attestation_valid() {
        let p = passport_with_receipts(10);
        let att = create_attestation(&p, 5, 0, p.first_payment_epoch).unwrap();
        assert!(verify_attestation(&att, &p.reputation_root));
    }

    // 13. verify_attestation fails with wrong root
    #[test]
    fn test_verify_attestation_wrong_root() {
        let p = passport_with_receipts(10);
        let att = create_attestation(&p, 5, 0, p.first_payment_epoch).unwrap();
        let mut bad_root = p.reputation_root;
        bad_root[0] ^= 0xFF;
        assert!(!verify_attestation(&att, &bad_root));
    }

    // 14. claim_min_receipts > actual → error
    #[test]
    fn test_attestation_overclaim_receipts_fails() {
        let p = passport_with_receipts(5);
        let err = create_attestation(&p, 100, 0, p.first_payment_epoch).unwrap_err();
        assert_eq!(err, PassportError::ClaimExceedsActual);
    }

    // 15. zero spend key → error
    #[test]
    fn test_zero_spend_key_error() {
        let err = create_passport(&[0u8; 32]).unwrap_err();
        assert_eq!(err, PassportError::ZeroSpendKey);
    }

    // 16. empty passport → no attestation
    #[test]
    fn test_empty_passport_no_attestation() {
        let p = create_passport(&spend_key()).unwrap();
        let err = create_attestation(&p, 0, 0, 0).unwrap_err();
        assert_eq!(err, PassportError::NoReceipts);
    }

    // 17. two different agents same activity → different passport_ids
    #[test]
    fn test_different_agents_different_ids() {
        let p1 = passport_with_receipts(5);
        let mut k2 = spend_key(); k2[0] = 0xBB;
        let mut p2 = create_passport(&k2).unwrap();
        for i in 0..5u8 {
            add_receipt(&mut p2, &rh(i), &prog(i % 3), &ac(i), 100 + i as u64, i % 3 == 0).unwrap();
        }
        assert_ne!(p1.passport_id, p2.passport_id);
        // But reputation roots may coincidentally match (same receipts) — that's fine
    }

    // 18. epoch tracking: first and last
    #[test]
    fn test_epoch_tracking() {
        let mut p = create_passport(&spend_key()).unwrap();
        add_receipt(&mut p, &rh(1), &prog(1), &ac(1), 500, true).unwrap();
        add_receipt(&mut p, &rh(2), &prog(2), &ac(2), 800, true).unwrap();
        assert_eq!(p.first_payment_epoch, 500);
        assert_eq!(p.last_payment_epoch, 800);
    }

    // 19. volume_commitment accumulates and changes
    #[test]
    fn test_volume_commitment_changes() {
        let mut p = create_passport(&spend_key()).unwrap();
        let v0 = p.volume_commitment;
        add_receipt(&mut p, &rh(1), &prog(1), &ac(1), 100, true).unwrap();
        assert_ne!(p.volume_commitment, v0);
    }

    // 20. is_stub/mainnet_ready on passport and attestation
    #[test]
    fn test_stub_flags() {
        let p = create_passport(&spend_key()).unwrap();
        assert!(p.is_stub);
        assert!(!p.mainnet_ready);
        let p10 = passport_with_receipts(3);
        let att = create_attestation(&p10, 1, 0, p10.first_payment_epoch).unwrap();
        assert!(att.is_stub);
    }
}
