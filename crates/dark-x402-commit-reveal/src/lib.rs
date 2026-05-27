//! dark-x402-commit-reveal — Anti-MEV 2-tx commit-reveal for x402 payments
//!
//! Protocol:
//!   TX-1 (commit): post H(domain || amount || recipient || nonce || epoch) on-chain
//!   TX-2 (reveal): post (amount, recipient, nonce, epoch) after min_delay slots
//!
//! Mempool observers see only the hash in TX-1; the actual payment details land
//! in TX-2 when the transaction is already included and front-running is impossible.
//!
//! IS_STUB = true  — commitment/reveal logic is correct, but the on-chain anchor
//!                   program is not yet deployed. Off-chain verification only.
//! MAINNET_READY = false — always, forever in this constructor.

use sha2::{Sha256, Digest};

pub const IS_STUB: bool = true;
pub const MAINNET_READY: bool = false;

/// Minimum slots between commit and reveal (prevents front-running during the
/// reveal window itself).
pub const DEFAULT_MIN_DELAY_SLOTS: u64 = 2;
/// Maximum slots: after this the commitment expires and the reveal is rejected.
pub const DEFAULT_MAX_DELAY_SLOTS: u64 = 150;

// Domain tags — distinct for every hash role.
const DOMAIN_COMMIT:  &[u8] = b"dark-x402-commit-v1";
const DOMAIN_NONCE:   &[u8] = b"dark-x402-nonce-v1";
const DOMAIN_REVEAL:  &[u8] = b"dark-x402-reveal-verify-v1";

// ── Error ────────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Clone)]
pub enum CommitRevealError {
    MainnetNotReady,
    ZeroAmount,
    InvalidNonce,
    RevealTooEarly { committed_slot: u64, current_slot: u64, min_delay: u64 },
    RevealExpired  { committed_slot: u64, current_slot: u64, max_delay: u64 },
    RevealMismatch,
    AlreadyRevealed,
    NullNonce,
}

impl core::fmt::Display for CommitRevealError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{:?}", self)
    }
}

// ── Types ─────────────────────────────────────────────────────────────────────

/// On-chain (or stub) state stored after TX-1.
#[derive(Debug, Clone, PartialEq)]
pub struct PaymentCommitment {
    /// Unique commitment ID = H(DOMAIN_COMMIT || commit_hash || committed_slot)
    pub commitment_id:   [u8; 32],
    /// commit_hash = H(DOMAIN_COMMIT || amount_le || recipient || nonce || epoch_le)
    pub commit_hash:     [u8; 32],
    /// Slot at which TX-1 was submitted.
    pub committed_slot:  u64,
    /// True after a matching reveal has been accepted.
    pub is_revealed:     bool,
    pub is_stub:         bool,
    pub mainnet_ready:   bool,
}

/// Payload posted in TX-2.
#[derive(Debug, Clone, PartialEq)]
pub struct PaymentReveal {
    pub commitment_id: [u8; 32],
    pub amount_lamports: u64,
    /// 32-byte recipient public key (Solana Pubkey bytes).
    pub recipient:     [u8; 32],
    /// Random nonce chosen by the payer at commit time.
    pub nonce:         [u8; 32],
    /// Slot-epoch used to domain-separate commitments across epochs.
    pub epoch:         u64,
}

/// Receipt produced when a reveal is accepted.
#[derive(Debug, Clone, PartialEq)]
pub struct RevealReceipt {
    pub commitment_id:   [u8; 32],
    pub reveal_hash:     [u8; 32],
    pub amount_lamports: u64,
    pub recipient:       [u8; 32],
    pub revealed_at_slot: u64,
    pub is_stub:         bool,
}

// ── Core hash helpers ─────────────────────────────────────────────────────────

/// Derive the commit hash from payment parameters.
/// commit_hash = H(DOMAIN_COMMIT || amount_le8 || recipient[32] || nonce[32] || epoch_le8)
pub fn compute_commit_hash(
    amount_lamports: u64,
    recipient:       &[u8; 32],
    nonce:           &[u8; 32],
    epoch:           u64,
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN_COMMIT);
    h.update(amount_lamports.to_le_bytes());
    h.update(recipient);
    h.update(nonce);
    h.update(epoch.to_le_bytes());
    h.finalize().into()
}

/// Derive the commitment_id from the commit_hash and slot.
fn compute_commitment_id(commit_hash: &[u8; 32], committed_slot: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN_COMMIT);
    h.update(commit_hash);
    h.update(committed_slot.to_le_bytes());
    h.finalize().into()
}

/// Generate a random-looking nonce from a seed (deterministic for testing).
pub fn derive_nonce(seed: &[u8; 32], counter: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN_NONCE);
    h.update(seed);
    h.update(counter.to_le_bytes());
    h.finalize().into()
}

// ── Commit ────────────────────────────────────────────────────────────────────

/// Create a payment commitment (TX-1 payload).
///
/// `committed_slot` — the current network slot (caller supplies; in real use,
///   obtain from `Clock::get()?.slot` inside the on-chain program).
pub fn create_commitment(
    amount_lamports:  u64,
    recipient:        &[u8; 32],
    nonce:            &[u8; 32],
    epoch:            u64,
    committed_slot:   u64,
) -> Result<PaymentCommitment, CommitRevealError> {
    if MAINNET_READY {
        return Err(CommitRevealError::MainnetNotReady);
    }
    if amount_lamports == 0 {
        return Err(CommitRevealError::ZeroAmount);
    }
    if nonce == &[0u8; 32] {
        return Err(CommitRevealError::NullNonce);
    }

    let commit_hash    = compute_commit_hash(amount_lamports, recipient, nonce, epoch);
    let commitment_id  = compute_commitment_id(&commit_hash, committed_slot);

    Ok(PaymentCommitment {
        commitment_id,
        commit_hash,
        committed_slot,
        is_revealed:   false,
        is_stub:       IS_STUB,
        mainnet_ready: MAINNET_READY,
    })
}

// ── Reveal ────────────────────────────────────────────────────────────────────

/// Build the reveal payload (TX-2).
pub fn create_reveal(
    commitment_id:   [u8; 32],
    amount_lamports: u64,
    recipient:       [u8; 32],
    nonce:           [u8; 32],
    epoch:           u64,
) -> PaymentReveal {
    PaymentReveal { commitment_id, amount_lamports, recipient, nonce, epoch }
}

/// Verify a reveal against its commitment.
///
/// Checks:
///   1. Timing window [committed_slot + min_delay, committed_slot + max_delay]
///   2. Hash pre-image matches
///   3. Commitment not already revealed
///
/// Returns a `RevealReceipt` on success.
pub fn verify_reveal(
    commitment:   &PaymentCommitment,
    reveal:       &PaymentReveal,
    current_slot: u64,
    min_delay:    u64,
    max_delay:    u64,
) -> Result<RevealReceipt, CommitRevealError> {
    // Guard: not already revealed.
    if commitment.is_revealed {
        return Err(CommitRevealError::AlreadyRevealed);
    }

    // Timing: too early.
    let earliest = commitment.committed_slot.saturating_add(min_delay);
    if current_slot < earliest {
        return Err(CommitRevealError::RevealTooEarly {
            committed_slot: commitment.committed_slot,
            current_slot,
            min_delay,
        });
    }

    // Timing: expired.
    let latest = commitment.committed_slot.saturating_add(max_delay);
    if current_slot > latest {
        return Err(CommitRevealError::RevealExpired {
            committed_slot: commitment.committed_slot,
            current_slot,
            max_delay,
        });
    }

    // Hash check.
    let expected = compute_commit_hash(
        reveal.amount_lamports,
        &reveal.recipient,
        &reveal.nonce,
        reveal.epoch,
    );
    if expected != commitment.commit_hash {
        return Err(CommitRevealError::RevealMismatch);
    }

    // Build reveal hash for receipt.
    let mut h = Sha256::new();
    h.update(DOMAIN_REVEAL);
    h.update(&commitment.commit_hash);
    h.update(current_slot.to_le_bytes());
    let reveal_hash: [u8; 32] = h.finalize().into();

    Ok(RevealReceipt {
        commitment_id:    commitment.commitment_id,
        reveal_hash,
        amount_lamports:  reveal.amount_lamports,
        recipient:        reveal.recipient,
        revealed_at_slot: current_slot,
        is_stub:          IS_STUB,
    })
}

/// Mark a commitment as revealed (consume-style; returns updated commitment).
pub fn mark_revealed(mut commitment: PaymentCommitment) -> PaymentCommitment {
    commitment.is_revealed = true;
    commitment
}

/// Quick window check without full reveal verification.
pub fn is_within_reveal_window(
    commitment:   &PaymentCommitment,
    current_slot: u64,
    min_delay:    u64,
    max_delay:    u64,
) -> bool {
    let earliest = commitment.committed_slot.saturating_add(min_delay);
    let latest   = commitment.committed_slot.saturating_add(max_delay);
    current_slot >= earliest && current_slot <= latest
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn test_recipient() -> [u8; 32] { [0xAB; 32] }
    fn test_nonce()     -> [u8; 32] { [0x7F; 32] }

    fn make_commitment(slot: u64) -> PaymentCommitment {
        create_commitment(1_000_000, &test_recipient(), &test_nonce(), 1, slot).unwrap()
    }

    // ── Create commitment ────────────────────────────────────────────────────

    #[test]
    fn test_create_commitment_succeeds() {
        let c = create_commitment(1_000_000, &test_recipient(), &test_nonce(), 1, 100).unwrap();
        assert_eq!(c.is_stub, true);
        assert_eq!(c.mainnet_ready, false);
        assert!(!c.is_revealed);
        assert_eq!(c.committed_slot, 100);
    }

    #[test]
    fn test_zero_amount_rejected() {
        let err = create_commitment(0, &test_recipient(), &test_nonce(), 1, 100).unwrap_err();
        assert_eq!(err, CommitRevealError::ZeroAmount);
    }

    #[test]
    fn test_null_nonce_rejected() {
        let err = create_commitment(1_000_000, &test_recipient(), &[0u8; 32], 1, 100).unwrap_err();
        assert_eq!(err, CommitRevealError::NullNonce);
    }

    #[test]
    fn test_mainnet_ready_always_false() {
        let c = make_commitment(0);
        assert_eq!(c.mainnet_ready, false);
    }

    // ── Commit hash determinism ───────────────────────────────────────────────

    #[test]
    fn test_commit_hash_deterministic() {
        let h1 = compute_commit_hash(500_000, &test_recipient(), &test_nonce(), 3);
        let h2 = compute_commit_hash(500_000, &test_recipient(), &test_nonce(), 3);
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_commit_hash_sensitive_to_amount() {
        let h1 = compute_commit_hash(1_000, &test_recipient(), &test_nonce(), 1);
        let h2 = compute_commit_hash(1_001, &test_recipient(), &test_nonce(), 1);
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_commit_hash_sensitive_to_recipient() {
        let r1 = [0xABu8; 32];
        let mut r2 = r1;
        r2[0] ^= 0xFF;
        let h1 = compute_commit_hash(1_000, &r1, &test_nonce(), 1);
        let h2 = compute_commit_hash(1_000, &r2, &test_nonce(), 1);
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_commit_hash_sensitive_to_nonce() {
        let n1 = [0x01u8; 32];
        let n2 = [0x02u8; 32];
        let h1 = compute_commit_hash(1_000, &test_recipient(), &n1, 1);
        let h2 = compute_commit_hash(1_000, &test_recipient(), &n2, 1);
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_commit_hash_sensitive_to_epoch() {
        let h1 = compute_commit_hash(1_000, &test_recipient(), &test_nonce(), 1);
        let h2 = compute_commit_hash(1_000, &test_recipient(), &test_nonce(), 2);
        assert_ne!(h1, h2);
    }

    // ── Commitment ID uniqueness ───────────────────────────────────────────────

    #[test]
    fn test_different_slots_different_ids() {
        let c1 = make_commitment(100);
        let c2 = make_commitment(101);
        assert_ne!(c1.commitment_id, c2.commitment_id);
    }

    // ── Reveal happy path ─────────────────────────────────────────────────────

    #[test]
    fn test_reveal_happy_path() {
        let c     = make_commitment(100);
        let rev   = create_reveal(c.commitment_id, 1_000_000, test_recipient(), test_nonce(), 1);
        let receipt = verify_reveal(&c, &rev, 102, DEFAULT_MIN_DELAY_SLOTS, DEFAULT_MAX_DELAY_SLOTS).unwrap();
        assert_eq!(receipt.amount_lamports, 1_000_000);
        assert_eq!(receipt.recipient, test_recipient());
        assert_eq!(receipt.is_stub, true);
    }

    // ── Reveal timing ─────────────────────────────────────────────────────────

    #[test]
    fn test_reveal_too_early() {
        let c   = make_commitment(100);
        let rev = create_reveal(c.commitment_id, 1_000_000, test_recipient(), test_nonce(), 1);
        // current_slot = 100, min_delay = 2 → must be >= 102
        let err = verify_reveal(&c, &rev, 100, DEFAULT_MIN_DELAY_SLOTS, DEFAULT_MAX_DELAY_SLOTS).unwrap_err();
        assert!(matches!(err, CommitRevealError::RevealTooEarly { .. }));
    }

    #[test]
    fn test_reveal_expired() {
        let c   = make_commitment(100);
        let rev = create_reveal(c.commitment_id, 1_000_000, test_recipient(), test_nonce(), 1);
        // current_slot = 100 + 150 + 1 = 251
        let err = verify_reveal(&c, &rev, 251, DEFAULT_MIN_DELAY_SLOTS, DEFAULT_MAX_DELAY_SLOTS).unwrap_err();
        assert!(matches!(err, CommitRevealError::RevealExpired { .. }));
    }

    #[test]
    fn test_reveal_at_boundary_slots() {
        let c   = make_commitment(100);
        let rev = create_reveal(c.commitment_id, 1_000_000, test_recipient(), test_nonce(), 1);
        // Exactly at min boundary (100 + 2 = 102)
        let ok = verify_reveal(&c, &rev, 102, DEFAULT_MIN_DELAY_SLOTS, DEFAULT_MAX_DELAY_SLOTS);
        assert!(ok.is_ok());
        // Exactly at max boundary (100 + 150 = 250)
        let ok2 = verify_reveal(&c, &rev, 250, DEFAULT_MIN_DELAY_SLOTS, DEFAULT_MAX_DELAY_SLOTS);
        assert!(ok2.is_ok());
    }

    // ── Reveal mismatch ───────────────────────────────────────────────────────

    #[test]
    fn test_reveal_wrong_amount_rejected() {
        let c   = make_commitment(100);
        let rev = create_reveal(c.commitment_id, 999_999, test_recipient(), test_nonce(), 1); // wrong amount
        let err = verify_reveal(&c, &rev, 102, DEFAULT_MIN_DELAY_SLOTS, DEFAULT_MAX_DELAY_SLOTS).unwrap_err();
        assert_eq!(err, CommitRevealError::RevealMismatch);
    }

    #[test]
    fn test_reveal_wrong_nonce_rejected() {
        let c   = make_commitment(100);
        let bad_nonce = [0xFFu8; 32];
        let rev = create_reveal(c.commitment_id, 1_000_000, test_recipient(), bad_nonce, 1);
        let err = verify_reveal(&c, &rev, 102, DEFAULT_MIN_DELAY_SLOTS, DEFAULT_MAX_DELAY_SLOTS).unwrap_err();
        assert_eq!(err, CommitRevealError::RevealMismatch);
    }

    #[test]
    fn test_double_reveal_rejected() {
        let c   = make_commitment(100);
        let rev = create_reveal(c.commitment_id, 1_000_000, test_recipient(), test_nonce(), 1);
        let c   = mark_revealed(c);
        let err = verify_reveal(&c, &rev, 102, DEFAULT_MIN_DELAY_SLOTS, DEFAULT_MAX_DELAY_SLOTS).unwrap_err();
        assert_eq!(err, CommitRevealError::AlreadyRevealed);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    #[test]
    fn test_is_within_reveal_window() {
        let c = make_commitment(100);
        assert!(!is_within_reveal_window(&c, 101, DEFAULT_MIN_DELAY_SLOTS, DEFAULT_MAX_DELAY_SLOTS));
        assert!( is_within_reveal_window(&c, 102, DEFAULT_MIN_DELAY_SLOTS, DEFAULT_MAX_DELAY_SLOTS));
        assert!( is_within_reveal_window(&c, 200, DEFAULT_MIN_DELAY_SLOTS, DEFAULT_MAX_DELAY_SLOTS));
        assert!(!is_within_reveal_window(&c, 251, DEFAULT_MIN_DELAY_SLOTS, DEFAULT_MAX_DELAY_SLOTS));
    }

    #[test]
    fn test_derive_nonce_deterministic() {
        let seed = [0x42u8; 32];
        let n1 = derive_nonce(&seed, 0);
        let n2 = derive_nonce(&seed, 0);
        assert_eq!(n1, n2);
    }

    #[test]
    fn test_derive_nonce_unique_per_counter() {
        let seed = [0x42u8; 32];
        let n1 = derive_nonce(&seed, 0);
        let n2 = derive_nonce(&seed, 1);
        assert_ne!(n1, n2);
    }

    #[test]
    fn test_mark_revealed_sets_flag() {
        let c = make_commitment(100);
        assert!(!c.is_revealed);
        let c = mark_revealed(c);
        assert!(c.is_revealed);
    }
}
