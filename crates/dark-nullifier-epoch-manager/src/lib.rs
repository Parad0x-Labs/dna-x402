//! dark-nullifier-epoch-manager
//!
//! Manages the full lifecycle of Dark Null nullifier submission:
//!
//! ```text
//! 1. Receive a BridgeNullifier (from dark-x402-nullifier-bridge)
//! 2. Look up the target shard (same formula as dark_nullifier_banks on-chain)
//! 3. Decide if InitBank instruction is needed (bank not yet created this epoch)
//! 4. Detect if nullifier was already submitted (replay guard)
//! 5. Build the instruction sequence: [optional InitBank] + InsertNullifier
//! 6. Track confirmed nullifiers in an EpochSet for this epoch
//! ```
//!
//! ## Epoch lifecycle
//!
//! Each Solana epoch, the 256 nullifier bank shards are recycled:
//! - A new bank PDA is created for (shard, epoch)
//! - Old banks from previous epochs can be closed to reclaim rent
//! - The EpochManager tracks which banks have been initialized this epoch
//!
//! ## Replay protection
//!
//! The `EpochSet` holds all nullifiers confirmed in the current epoch.
//! `NullifierManager::check_replay` returns `Err(AlreadySpent)` if the
//! nullifier is already in the set — prevents double-submission.
//!
//! Off-chain replay detection (this crate) is a SUPPLEMENT to the on-chain
//! `dark_nullifier_banks` guard, not a replacement.
//!
//! mainnet_ready = false — devnet only

use dark_x402_nullifier_bridge::{
    bank_pda, build_init_bank_instruction_data, build_insert_instruction_data, null_rec_pda,
    BridgeNullifier,
};
use solana_program::pubkey::Pubkey;
use std::collections::{HashMap, HashSet};

// ── Types ─────────────────────────────────────────────────────────────────────

/// Error from the epoch manager.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EpochManagerError {
    /// This nullifier was already submitted this epoch (local replay guard).
    AlreadySpent { nullifier: [u8; 32], shard: u8 },
    /// The BridgeNullifier's epoch does not match the manager's active epoch.
    EpochMismatch { got: u64, expected: u64 },
    /// Epoch is 0 — invalid (same guard as BridgeError::EpochZero).
    EpochZero,
    /// Shard index is out of range (should never happen for u8, but defensive).
    InvalidShard,
}

impl std::fmt::Display for EpochManagerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadySpent { nullifier, shard } => {
                let hex: String = nullifier.iter().map(|b| format!("{:02x}", b)).collect();
                write!(
                    f,
                    "nullifier already spent this epoch: shard={} null={}",
                    shard,
                    &hex[..16]
                )
            }
            Self::EpochMismatch { got, expected } => write!(
                f,
                "epoch mismatch: got {}, manager is on epoch {}",
                got, expected
            ),
            Self::EpochZero => write!(f, "epoch 0 is invalid"),
            Self::InvalidShard => write!(f, "shard index invalid"),
        }
    }
}

impl std::error::Error for EpochManagerError {}

/// A single submitted nullifier record, kept in the epoch set.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NullifierRecord {
    /// The 32-byte nullifier hash.
    pub nullifier: [u8; 32],
    /// Target shard (0..255).
    pub shard: u8,
    /// Epoch this nullifier belongs to.
    pub epoch: u64,
    /// Bank PDA (address, bump) for this shard/epoch.
    pub bank_pda: ([u8; 32], u8),
    /// Nullifier record PDA.
    pub null_rec_pda: ([u8; 32], u8),
}

/// Instruction sequence needed to submit one nullifier.
#[derive(Debug, Clone)]
pub struct SubmissionInstructions {
    /// `Some(data)` if the bank PDA needs to be initialized first.
    /// None if the bank is already known to exist.
    pub init_bank_ix: Option<[u8; 10]>,
    /// `InsertNullifier` instruction data (always present).
    pub insert_nullifier_ix: [u8; 41],
    /// Bank PDA that must be writable in the transaction.
    pub bank_pda: Pubkey,
    pub bank_bump: u8,
    /// NullifierRecord PDA that will be created.
    pub null_rec_pda: Pubkey,
    pub null_rec_bump: u8,
}

/// Per-epoch state: which banks exist, which nullifiers have been confirmed.
#[derive(Debug, Default)]
struct EpochState {
    /// Shards (0..255) that have been initialized this epoch.
    initialized_banks: HashSet<u8>,
    /// Confirmed nullifiers indexed by shard.
    nullifiers_by_shard: HashMap<u8, HashSet<[u8; 32]>>,
}

impl EpochState {
    fn is_bank_initialized(&self, shard: u8) -> bool {
        self.initialized_banks.contains(&shard)
    }

    fn mark_bank_initialized(&mut self, shard: u8) {
        self.initialized_banks.insert(shard);
    }

    fn is_spent(&self, nullifier: &[u8; 32], shard: u8) -> bool {
        self.nullifiers_by_shard
            .get(&shard)
            .map_or(false, |set| set.contains(nullifier))
    }

    fn mark_spent(&mut self, nullifier: [u8; 32], shard: u8) {
        self.nullifiers_by_shard
            .entry(shard)
            .or_default()
            .insert(nullifier);
    }

    fn nullifier_count(&self) -> usize {
        self.nullifiers_by_shard.values().map(|s| s.len()).sum()
    }
}

/// Manages nullifier submission lifecycle for one or more epochs.
///
/// ## Usage
///
/// ```rust,ignore
/// let mut mgr = NullifierManager::new(program_id, current_epoch);
/// let instrs = mgr.prepare_submission(&bridge_nullifier)?;
/// // Send instrs.init_bank_ix (if Some) + instrs.insert_nullifier_ix to the network
/// mgr.confirm_submission(&bridge_nullifier);
/// ```
pub struct NullifierManager {
    /// Program ID of `dark_nullifier_banks` on-chain.
    program_id: Pubkey,
    /// The currently active Solana epoch.
    active_epoch: u64,
    /// Per-epoch state.
    epoch_states: HashMap<u64, EpochState>,
    /// Always false.
    pub mainnet_ready: bool,
}

impl NullifierManager {
    /// Create a new manager for `program_id` at `active_epoch`.
    pub fn new(program_id: Pubkey, active_epoch: u64) -> Self {
        assert_ne!(active_epoch, 0, "epoch 0 is invalid");
        let mut epoch_states = HashMap::new();
        epoch_states.insert(active_epoch, EpochState::default());
        Self {
            program_id,
            active_epoch,
            epoch_states,
            mainnet_ready: false,
        }
    }

    /// Advance the manager to a new epoch.
    ///
    /// Old epoch state is retained for replay detection of late submissions.
    pub fn advance_epoch(&mut self, new_epoch: u64) {
        assert!(
            new_epoch > self.active_epoch,
            "new epoch must be greater than current"
        );
        self.active_epoch = new_epoch;
        self.epoch_states.entry(new_epoch).or_default();
    }

    /// Returns the current active epoch.
    pub fn active_epoch(&self) -> u64 {
        self.active_epoch
    }

    /// Check if a nullifier is already spent in its target epoch.
    pub fn is_spent(&self, nullifier: &[u8; 32], shard: u8, epoch: u64) -> bool {
        self.epoch_states
            .get(&epoch)
            .map_or(false, |s| s.is_spent(nullifier, shard))
    }

    /// Check if the bank for (shard, epoch) is known to be initialized.
    pub fn is_bank_initialized(&self, shard: u8, epoch: u64) -> bool {
        self.epoch_states
            .get(&epoch)
            .map_or(false, |s| s.is_bank_initialized(shard))
    }

    /// Prepare the instruction sequence for a nullifier submission.
    ///
    /// Returns `Err(AlreadySpent)` if the nullifier is already confirmed.
    /// Returns `Err(EpochMismatch)` if the nullifier is for a different epoch.
    ///
    /// # Bank initialization
    /// If the target bank is not yet known to be initialized, `init_bank_ix` will
    /// be `Some(...)`. The caller should send it before `insert_nullifier_ix`
    /// (safe to send even if bank exists — on-chain it will just fail gracefully,
    /// or you can check `is_bank_initialized()` first to skip it).
    pub fn prepare_submission(
        &self,
        bn: &BridgeNullifier,
    ) -> Result<SubmissionInstructions, EpochManagerError> {
        if bn.epoch == 0 {
            return Err(EpochManagerError::EpochZero);
        }
        if bn.epoch != self.active_epoch {
            return Err(EpochManagerError::EpochMismatch {
                got: bn.epoch,
                expected: self.active_epoch,
            });
        }

        // Local replay check
        if let Some(state) = self.epoch_states.get(&bn.epoch) {
            if state.is_spent(&bn.nullifier, bn.shard) {
                return Err(EpochManagerError::AlreadySpent {
                    nullifier: bn.nullifier,
                    shard: bn.shard,
                });
            }
        }

        // Decide whether to include InitBank
        let needs_init = !self.is_bank_initialized(bn.shard, bn.epoch);
        let init_bank_ix = needs_init.then(|| build_init_bank_instruction_data(bn.shard, bn.epoch));

        let insert_nullifier_ix = build_insert_instruction_data(bn);

        let (bp, bank_bump) = bank_pda(&self.program_id, bn.shard, bn.epoch);
        let (nrp, null_rec_bump) = null_rec_pda(&self.program_id, &bn.nullifier);

        Ok(SubmissionInstructions {
            init_bank_ix,
            insert_nullifier_ix,
            bank_pda: bp,
            bank_bump,
            null_rec_pda: nrp,
            null_rec_bump,
        })
    }

    /// Mark a nullifier as confirmed (call after successful on-chain transaction).
    ///
    /// Also marks the bank as initialized (since the tx necessarily created/used it).
    pub fn confirm_submission(&mut self, bn: &BridgeNullifier) {
        let state = self.epoch_states.entry(bn.epoch).or_default();
        state.mark_bank_initialized(bn.shard);
        state.mark_spent(bn.nullifier, bn.shard);
    }

    /// Pre-mark a bank as initialized (e.g., you know it was created in a prior tx).
    pub fn mark_bank_initialized(&mut self, shard: u8, epoch: u64) {
        self.epoch_states
            .entry(epoch)
            .or_default()
            .mark_bank_initialized(shard);
    }

    /// Total number of confirmed nullifiers in the active epoch.
    pub fn confirmed_count(&self) -> usize {
        self.epoch_states
            .get(&self.active_epoch)
            .map_or(0, |s| s.nullifier_count())
    }

    /// Total across ALL tracked epochs.
    pub fn confirmed_count_all_epochs(&self) -> usize {
        self.epoch_states
            .values()
            .map(|s| s.nullifier_count())
            .sum()
    }

    /// Number of initialized banks in the active epoch.
    pub fn initialized_bank_count(&self) -> usize {
        self.epoch_states
            .get(&self.active_epoch)
            .map_or(0, |s| s.initialized_banks.len())
    }

    /// Build a NullifierRecord snapshot for a confirmed nullifier.
    pub fn build_record(&self, bn: &BridgeNullifier) -> NullifierRecord {
        let (bp, bp_bump) = bank_pda(&self.program_id, bn.shard, bn.epoch);
        let (nrp, nrp_bump) = null_rec_pda(&self.program_id, &bn.nullifier);
        NullifierRecord {
            nullifier: bn.nullifier,
            shard: bn.shard,
            epoch: bn.epoch,
            bank_pda: (bp.to_bytes(), bp_bump),
            null_rec_pda: (nrp.to_bytes(), nrp_bump),
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use dark_x402_nullifier_bridge::bank_index;
    use sha2::{Digest, Sha256};

    /// Build a deterministic `BridgeNullifier` directly — no x402 payment flow needed.
    /// `scope` is mixed in to produce distinct nullifiers per test.
    fn mock_bridge_nullifier(epoch: u64, scope: u8) -> BridgeNullifier {
        // Deterministic nullifier: SHA256("test-null-v1" || epoch_le8 || scope)
        let mut h = Sha256::new();
        h.update(b"test-null-v1");
        h.update(&epoch.to_le_bytes());
        h.update(&[scope]);
        let nullifier: [u8; 32] = h.finalize().into();

        let shard = bank_index(&nullifier, epoch, b"dark_null_v1");

        BridgeNullifier {
            nullifier,
            shard,
            epoch,
            receipt_id: [scope; 32],
            is_real_payment: false,
            mainnet_ready: false,
        }
    }

    fn test_program_id() -> Pubkey {
        Pubkey::new_from_array([0xEE; 32])
    }

    #[test]
    fn test_manager_new_active_epoch() {
        let mgr = NullifierManager::new(test_program_id(), 5);
        assert_eq!(mgr.active_epoch(), 5);
        assert!(!mgr.mainnet_ready);
    }

    #[test]
    fn test_prepare_submission_includes_init_bank_first_time() {
        let mgr = NullifierManager::new(test_program_id(), 7);
        let bn = mock_bridge_nullifier(7, 1);
        let instrs = mgr.prepare_submission(&bn).unwrap();
        assert!(
            instrs.init_bank_ix.is_some(),
            "first submission to a shard must include InitBank"
        );
        assert_eq!(instrs.insert_nullifier_ix[0], 0x01);
        assert_ne!(instrs.bank_pda, Pubkey::default());
        assert_ne!(instrs.null_rec_pda, Pubkey::default());
    }

    #[test]
    fn test_prepare_submission_no_init_bank_if_known_initialized() {
        let mut mgr = NullifierManager::new(test_program_id(), 7);
        let bn = mock_bridge_nullifier(7, 2);
        mgr.mark_bank_initialized(bn.shard, 7);
        let instrs = mgr.prepare_submission(&bn).unwrap();
        assert!(
            instrs.init_bank_ix.is_none(),
            "known-initialized bank must NOT include InitBank"
        );
    }

    #[test]
    fn test_confirm_marks_bank_initialized_and_nullifier_spent() {
        let mut mgr = NullifierManager::new(test_program_id(), 8);
        let bn = mock_bridge_nullifier(8, 3);
        assert_eq!(mgr.confirmed_count(), 0);
        mgr.confirm_submission(&bn);
        assert_eq!(mgr.confirmed_count(), 1);
        assert!(mgr.is_bank_initialized(bn.shard, 8));
        assert!(mgr.is_spent(&bn.nullifier, bn.shard, 8));
    }

    #[test]
    fn test_double_submission_rejected_after_confirm() {
        let mut mgr = NullifierManager::new(test_program_id(), 9);
        let bn = mock_bridge_nullifier(9, 4);
        mgr.confirm_submission(&bn);
        let err = mgr.prepare_submission(&bn).unwrap_err();
        assert_eq!(
            err,
            EpochManagerError::AlreadySpent {
                nullifier: bn.nullifier,
                shard: bn.shard,
            }
        );
    }

    #[test]
    fn test_epoch_mismatch_rejected() {
        let mgr = NullifierManager::new(test_program_id(), 10);
        let bn = mock_bridge_nullifier(11, 5); // epoch 11 ≠ active 10
        let err = mgr.prepare_submission(&bn).unwrap_err();
        assert_eq!(
            err,
            EpochManagerError::EpochMismatch {
                got: 11,
                expected: 10
            }
        );
    }

    #[test]
    fn test_advance_epoch_resets_state() {
        let mut mgr = NullifierManager::new(test_program_id(), 3);
        let bn = mock_bridge_nullifier(3, 6);
        mgr.confirm_submission(&bn);
        assert_eq!(mgr.confirmed_count(), 1);

        mgr.advance_epoch(4);
        assert_eq!(mgr.active_epoch(), 4);
        assert_eq!(
            mgr.confirmed_count(),
            0,
            "new epoch starts with 0 confirmed"
        );
        // Old epoch still retained
        assert_eq!(mgr.confirmed_count_all_epochs(), 1);
    }

    #[test]
    fn test_multiple_shards_tracked_independently() {
        let mut mgr = NullifierManager::new(test_program_id(), 5);
        // Submit to up to 3 different resources (different nullifiers/shards)
        let bn1 = mock_bridge_nullifier(5, 10);
        let bn2 = mock_bridge_nullifier(5, 20);
        let bn3 = mock_bridge_nullifier(5, 30);

        mgr.confirm_submission(&bn1);
        mgr.confirm_submission(&bn2);
        mgr.confirm_submission(&bn3);

        assert_eq!(mgr.confirmed_count(), 3);
        assert!(mgr.is_spent(&bn1.nullifier, bn1.shard, 5));
        assert!(mgr.is_spent(&bn2.nullifier, bn2.shard, 5));
        assert!(mgr.is_spent(&bn3.nullifier, bn3.shard, 5));
    }

    #[test]
    fn test_build_record_pda_nonzero() {
        let mgr = NullifierManager::new(test_program_id(), 6);
        let bn = mock_bridge_nullifier(6, 7);
        let rec = mgr.build_record(&bn);
        assert_ne!(rec.bank_pda.0, [0u8; 32]);
        assert_ne!(rec.null_rec_pda.0, [0u8; 32]);
        assert_eq!(rec.epoch, 6);
        assert_eq!(rec.nullifier, bn.nullifier);
        assert_eq!(rec.shard, bn.shard);
    }

    #[test]
    fn test_init_bank_ix_shard_and_epoch_correct() {
        let mgr = NullifierManager::new(test_program_id(), 11);
        let bn = mock_bridge_nullifier(11, 9);
        let instrs = mgr.prepare_submission(&bn).unwrap();
        let ix = instrs.init_bank_ix.expect("must have init bank ix");
        assert_eq!(ix[0], 0x00); // InitBank discriminant
        assert_eq!(ix[1], bn.shard);
        let parsed_epoch = u64::from_le_bytes(ix[2..10].try_into().unwrap());
        assert_eq!(parsed_epoch, 11u64);
    }

    #[test]
    fn test_insert_ix_nullifier_and_epoch_correct() {
        let mgr = NullifierManager::new(test_program_id(), 12);
        let bn = mock_bridge_nullifier(12, 8);
        let instrs = mgr.prepare_submission(&bn).unwrap();
        assert_eq!(instrs.insert_nullifier_ix[0], 0x01);
        assert_eq!(&instrs.insert_nullifier_ix[1..33], &bn.nullifier);
        let parsed_epoch =
            u64::from_le_bytes(instrs.insert_nullifier_ix[33..41].try_into().unwrap());
        assert_eq!(parsed_epoch, 12u64);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_false() {
        let mgr = NullifierManager::new(test_program_id(), 1);
        assert!(!mgr.mainnet_ready);
    }

    #[test]
    #[should_panic(expected = "epoch 0 is invalid")]
    fn test_epoch_zero_panics() {
        let _ = NullifierManager::new(test_program_id(), 0);
    }

    #[test]
    fn test_initialized_bank_count_increments() {
        let mut mgr = NullifierManager::new(test_program_id(), 15);
        assert_eq!(mgr.initialized_bank_count(), 0);
        let bn = mock_bridge_nullifier(15, 1);
        mgr.confirm_submission(&bn);
        assert_eq!(mgr.initialized_bank_count(), 1);
    }

    #[test]
    fn test_is_spent_false_before_confirm() {
        let mgr = NullifierManager::new(test_program_id(), 16);
        let bn = mock_bridge_nullifier(16, 1);
        assert!(!mgr.is_spent(&bn.nullifier, bn.shard, 16));
    }

    #[test]
    fn test_confirmed_count_all_epochs_includes_old() {
        let mut mgr = NullifierManager::new(test_program_id(), 20);
        let bn = mock_bridge_nullifier(20, 1);
        mgr.confirm_submission(&bn);
        mgr.advance_epoch(21);
        let bn2 = mock_bridge_nullifier(21, 2);
        mgr.confirm_submission(&bn2);
        assert_eq!(mgr.confirmed_count_all_epochs(), 2);
        assert_eq!(mgr.confirmed_count(), 1); // active epoch only
    }
}
