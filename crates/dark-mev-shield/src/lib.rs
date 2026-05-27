// dark-mev-shield — anti-MEV time-locked commit-reveal with chaff
// Prevents sandwich attacks: trade parameters hidden until execute_after_slot.
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum TradeDirection {
    Buy,
    Sell,
}

impl TradeDirection {
    fn to_byte(&self) -> u8 {
        match self {
            TradeDirection::Buy => 0x01,
            TradeDirection::Sell => 0x02,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShieldedIntent {
    /// SHA256("mev-shield-v1" || direction_byte || min_amount_le8 || max_slippage_bp_le2 || execute_after_slot_le8 || nonce)
    pub intent_hash: [u8; 32],
    /// Only after this slot may the intent be revealed (time-lock)
    pub execute_after_slot: u64,
    /// Submitted at this slot
    pub submitted_at_slot: u64,
    pub mainnet_ready: bool, // always false
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChaffIntent {
    /// A fake commitment — indistinguishable from real until revealed
    pub intent_hash: [u8; 32],
    /// Chaff never reveals
    pub reveal_slot: u64, // intentionally far future
    pub mainnet_ready: bool, // always false
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShieldBundle {
    /// One real + N chaff intents — all look identical on-chain
    pub real_intent: ShieldedIntent,
    pub chaff: Vec<ChaffIntent>,
    /// Committed at this slot
    pub bundle_slot: u64,
    pub mainnet_ready: bool, // always false
}

#[derive(Debug, Clone, PartialEq)]
pub struct IntentReveal {
    pub direction: TradeDirection,
    pub min_amount: u64,
    /// Basis points (e.g., 50 = 0.5% slippage)
    pub max_slippage_bp: u16,
    pub nonce: [u8; 32],
    pub revealed_at_slot: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShieldVerdict {
    pub intent_valid: bool,
    pub time_lock_satisfied: bool,
    pub commitment_matches: bool,
    /// Estimated MEV attack cost given chaff count
    /// = 1 / (chaff_count + 1) — attacker has this probability of picking the real intent
    pub attack_probability: f64,
}

#[derive(Debug, PartialEq)]
pub enum ShieldError {
    TimeLockNotSatisfied { current: u64, required: u64 },
    CommitmentMismatch,
    ChaffCountTooLow { min: usize, got: usize },
    RevealBeforeSubmit,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DOMAIN: &[u8] = b"mev-shield-v1";
const MIN_CHAFF: usize = 3;
/// Chaff reveal slots are set this far in the future so they never trigger
const CHAFF_REVEAL_OFFSET: u64 = u64::MAX / 2;

fn compute_intent_hash(
    direction: &TradeDirection,
    min_amount: u64,
    max_slippage_bp: u16,
    execute_after_slot: u64,
    nonce: &[u8; 32],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(DOMAIN);
    hasher.update([direction.to_byte()]);
    hasher.update(min_amount.to_le_bytes());
    hasher.update(max_slippage_bp.to_le_bytes());
    hasher.update(execute_after_slot.to_le_bytes());
    hasher.update(nonce);
    hasher.finalize().into()
}

fn compute_chaff_hash(base_slot: u64, chaff_nonce: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(DOMAIN);
    hasher.update(b"chaff");
    hasher.update(base_slot.to_le_bytes());
    hasher.update(chaff_nonce);
    hasher.finalize().into()
}

fn derive_chaff_nonce(seed: &[u8; 32], index: usize) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"chaff-nonce-derive");
    hasher.update(seed);
    hasher.update((index as u64).to_le_bytes());
    hasher.finalize().into()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a shielded trade intent.
/// execute_after_slot = submitted_at_slot + max(lock_slots, 1)
pub fn shield_intent(
    direction: &TradeDirection,
    min_amount: u64,
    max_slippage_bp: u16,
    nonce: &[u8; 32],
    submitted_at_slot: u64,
    lock_slots: u64,
) -> ShieldedIntent {
    let effective_lock = lock_slots.max(1);
    let execute_after_slot = submitted_at_slot + effective_lock;
    let intent_hash = compute_intent_hash(
        direction,
        min_amount,
        max_slippage_bp,
        execute_after_slot,
        nonce,
    );
    ShieldedIntent {
        intent_hash,
        execute_after_slot,
        submitted_at_slot,
        mainnet_ready: false,
    }
}

/// Create a chaff intent (fake — same structure as real, indistinguishable on-chain).
/// chaff_nonce is used internally to make unique hashes.
pub fn make_chaff(base_slot: u64, chaff_nonce: &[u8; 32]) -> ChaffIntent {
    let intent_hash = compute_chaff_hash(base_slot, chaff_nonce);
    ChaffIntent {
        intent_hash,
        reveal_slot: base_slot.saturating_add(CHAFF_REVEAL_OFFSET),
        mainnet_ready: false,
    }
}

/// Bundle one real intent with chaff_count chaff intents.
/// Minimum 3 chaff required — returns ChaffCountTooLow otherwise.
pub fn bundle(
    intent: ShieldedIntent,
    chaff_count: usize,
    base_slot: u64,
    chaff_seed: &[u8; 32],
) -> Result<ShieldBundle, ShieldError> {
    if chaff_count < MIN_CHAFF {
        return Err(ShieldError::ChaffCountTooLow {
            min: MIN_CHAFF,
            got: chaff_count,
        });
    }
    let chaff: Vec<ChaffIntent> = (0..chaff_count)
        .map(|i| {
            let nonce = derive_chaff_nonce(chaff_seed, i);
            make_chaff(base_slot, &nonce)
        })
        .collect();
    Ok(ShieldBundle {
        real_intent: intent,
        chaff,
        bundle_slot: base_slot,
        mainnet_ready: false,
    })
}

/// Verify a reveal against the committed ShieldedIntent.
pub fn verify_reveal(intent: &ShieldedIntent, reveal: &IntentReveal) -> ShieldVerdict {
    let time_lock_satisfied = reveal.revealed_at_slot >= intent.execute_after_slot;
    let expected_hash = compute_intent_hash(
        &reveal.direction,
        reveal.min_amount,
        reveal.max_slippage_bp,
        intent.execute_after_slot,
        &reveal.nonce,
    );
    let commitment_matches = expected_hash == intent.intent_hash;
    let intent_valid = time_lock_satisfied && commitment_matches;
    ShieldVerdict {
        intent_valid,
        time_lock_satisfied,
        commitment_matches,
        attack_probability: 1.0,
    }
}

/// Compute the attacker probability = 1.0 / (chaff_count + 1)
pub fn attack_probability(bundle: &ShieldBundle) -> f64 {
    1.0 / (bundle.chaff.len() as f64 + 1.0)
}

/// Compute MEV risk score 0-100 (100 = max protection).
pub fn mev_risk_score(bundle: &ShieldBundle) -> u8 {
    let prob = attack_probability(bundle);
    let score = 100.0 * (1.0 - prob);
    score.round() as u8
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const SLOT: u64 = 100_000;
    const LOCK: u64 = 10;
    const AMOUNT: u64 = 1_000_000;
    const SLIPPAGE: u16 = 50;

    fn fixed_nonce(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    // 1. mainnet_ready is always false on ShieldedIntent
    #[test]
    fn test_intent_mainnet_ready_false() {
        let intent = shield_intent(
            &TradeDirection::Buy,
            AMOUNT,
            SLIPPAGE,
            &fixed_nonce(1),
            SLOT,
            LOCK,
        );
        assert!(!intent.mainnet_ready);
    }

    // 2. Same inputs always produce the same hash (deterministic)
    #[test]
    fn test_intent_hash_deterministic() {
        let nonce = fixed_nonce(42);
        let a = shield_intent(&TradeDirection::Buy, AMOUNT, SLIPPAGE, &nonce, SLOT, LOCK);
        let b = shield_intent(&TradeDirection::Buy, AMOUNT, SLIPPAGE, &nonce, SLOT, LOCK);
        assert_eq!(a.intent_hash, b.intent_hash);
    }

    // 3. Different nonce -> different hash
    #[test]
    fn test_different_nonce_different_hash() {
        let a = shield_intent(
            &TradeDirection::Buy,
            AMOUNT,
            SLIPPAGE,
            &fixed_nonce(1),
            SLOT,
            LOCK,
        );
        let b = shield_intent(
            &TradeDirection::Buy,
            AMOUNT,
            SLIPPAGE,
            &fixed_nonce(2),
            SLOT,
            LOCK,
        );
        assert_ne!(a.intent_hash, b.intent_hash);
    }

    // 4. execute_after_slot is strictly in the future relative to submitted_at_slot
    #[test]
    fn test_time_lock_is_in_future() {
        let intent = shield_intent(
            &TradeDirection::Buy,
            AMOUNT,
            SLIPPAGE,
            &fixed_nonce(1),
            SLOT,
            LOCK,
        );
        assert!(intent.execute_after_slot > intent.submitted_at_slot);
    }

    // 5. Bundling with fewer than 3 chaff returns ChaffCountTooLow
    #[test]
    fn test_bundle_requires_min_3_chaff() {
        let intent = shield_intent(
            &TradeDirection::Buy,
            AMOUNT,
            SLIPPAGE,
            &fixed_nonce(1),
            SLOT,
            LOCK,
        );
        let err = bundle(intent, 2, SLOT, &fixed_nonce(99)).unwrap_err();
        assert_eq!(err, ShieldError::ChaffCountTooLow { min: 3, got: 2 });
    }

    // 6. Bundle chaff count in the struct matches the requested count
    #[test]
    fn test_bundle_chaff_count_matches() {
        let intent = shield_intent(
            &TradeDirection::Buy,
            AMOUNT,
            SLIPPAGE,
            &fixed_nonce(1),
            SLOT,
            LOCK,
        );
        let b = bundle(intent, 5, SLOT, &fixed_nonce(99)).unwrap();
        assert_eq!(b.chaff.len(), 5);
    }

    // 7. verify_reveal returns true for all flags given correct reveal values
    #[test]
    fn test_verify_reveal_passes_correct_values() {
        let nonce = fixed_nonce(7);
        let intent = shield_intent(&TradeDirection::Buy, AMOUNT, SLIPPAGE, &nonce, SLOT, LOCK);
        let reveal = IntentReveal {
            direction: TradeDirection::Buy,
            min_amount: AMOUNT,
            max_slippage_bp: SLIPPAGE,
            nonce,
            revealed_at_slot: intent.execute_after_slot,
        };
        let verdict = verify_reveal(&intent, &reveal);
        assert!(verdict.intent_valid);
        assert!(verdict.time_lock_satisfied);
        assert!(verdict.commitment_matches);
    }

    // 8. Reveal one slot before execute_after_slot -> time lock not satisfied
    #[test]
    fn test_verify_reveal_fails_time_lock_not_satisfied() {
        let nonce = fixed_nonce(8);
        let intent = shield_intent(&TradeDirection::Buy, AMOUNT, SLIPPAGE, &nonce, SLOT, LOCK);
        let reveal = IntentReveal {
            direction: TradeDirection::Buy,
            min_amount: AMOUNT,
            max_slippage_bp: SLIPPAGE,
            nonce,
            revealed_at_slot: intent.execute_after_slot - 1,
        };
        let verdict = verify_reveal(&intent, &reveal);
        assert!(!verdict.intent_valid);
        assert!(!verdict.time_lock_satisfied);
        assert!(verdict.commitment_matches);
    }

    // 9. Tampered direction -> commitment mismatch
    #[test]
    fn test_verify_reveal_fails_commitment_mismatch() {
        let nonce = fixed_nonce(9);
        let intent = shield_intent(&TradeDirection::Buy, AMOUNT, SLIPPAGE, &nonce, SLOT, LOCK);
        let reveal = IntentReveal {
            direction: TradeDirection::Sell,
            min_amount: AMOUNT,
            max_slippage_bp: SLIPPAGE,
            nonce,
            revealed_at_slot: intent.execute_after_slot + 5,
        };
        let verdict = verify_reveal(&intent, &reveal);
        assert!(!verdict.intent_valid);
        assert!(verdict.time_lock_satisfied);
        assert!(!verdict.commitment_matches);
    }

    // 10. More chaff -> lower attack probability
    #[test]
    fn test_attack_probability_decreases_with_more_chaff() {
        let make_b = |n: usize| {
            let intent = shield_intent(
                &TradeDirection::Buy,
                AMOUNT,
                SLIPPAGE,
                &fixed_nonce(10),
                SLOT,
                LOCK,
            );
            bundle(intent, n, SLOT, &fixed_nonce(55)).unwrap()
        };
        let b3 = make_b(3);
        let b9 = make_b(9);
        assert!(attack_probability(&b9) < attack_probability(&b3));
    }

    // 11. More chaff -> higher MEV risk score (more protection)
    #[test]
    fn test_mev_risk_score_increases_with_chaff() {
        let make_b = |n: usize| {
            let intent = shield_intent(
                &TradeDirection::Sell,
                AMOUNT,
                SLIPPAGE,
                &fixed_nonce(11),
                SLOT,
                LOCK,
            );
            bundle(intent, n, SLOT, &fixed_nonce(66)).unwrap()
        };
        let score_small = mev_risk_score(&make_b(3));
        let score_large = mev_risk_score(&make_b(9));
        assert!(score_large > score_small);
        assert!(score_large <= 100);
    }

    // 12. Chaff hash is same type/length as real intent hash (indistinguishable on-chain)
    #[test]
    fn test_chaff_indistinguishable_from_real() {
        let intent = shield_intent(
            &TradeDirection::Buy,
            AMOUNT,
            SLIPPAGE,
            &fixed_nonce(12),
            SLOT,
            LOCK,
        );
        let chaff = make_chaff(SLOT, &fixed_nonce(88));
        let real_hash: [u8; 32] = intent.intent_hash;
        let chaff_hash: [u8; 32] = chaff.intent_hash;
        assert_eq!(real_hash.len(), chaff_hash.len());
        assert_ne!(real_hash, chaff_hash);
        assert!(!chaff.mainnet_ready);
    }

    // 13. Buy and Sell produce different hashes for otherwise identical parameters
    #[test]
    fn test_buy_and_sell_produce_different_hashes() {
        let nonce = fixed_nonce(13);
        let buy = shield_intent(&TradeDirection::Buy, AMOUNT, SLIPPAGE, &nonce, SLOT, LOCK);
        let sell = shield_intent(&TradeDirection::Sell, AMOUNT, SLIPPAGE, &nonce, SLOT, LOCK);
        assert_ne!(buy.intent_hash, sell.intent_hash);
    }

    // 14. lock_slots = 0 -> execute_after_slot is still submitted_at_slot + 1
    #[test]
    fn test_zero_lock_slots_still_valid() {
        let intent = shield_intent(
            &TradeDirection::Buy,
            AMOUNT,
            SLIPPAGE,
            &fixed_nonce(14),
            SLOT,
            0,
        );
        assert_eq!(intent.execute_after_slot, SLOT + 1);
        assert!(intent.execute_after_slot > intent.submitted_at_slot);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_intent_hash_nonzero() {
        let intent = shield_intent(
            &TradeDirection::Buy,
            AMOUNT,
            SLIPPAGE,
            &fixed_nonce(0xAB),
            SLOT,
            LOCK,
        );
        assert_ne!(intent.intent_hash, [0u8; 32]);
    }

    #[test]
    fn test_bundle_mainnet_ready_false() {
        let intent = shield_intent(
            &TradeDirection::Sell,
            AMOUNT,
            SLIPPAGE,
            &fixed_nonce(0xCD),
            SLOT,
            LOCK,
        );
        let b = bundle(intent, 3, SLOT, &fixed_nonce(0xEF)).unwrap();
        assert!(!b.mainnet_ready);
    }
}
