// NULL_FLYWHEEL_VAULT_V1 — commit-reveal schedule randomizer
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct ScheduleCommitment {
    pub commitment_hash: [u8; 32], // SHA256("flywheel-sched-v1" || seed || epoch.to_le || window_slots.to_le)
    pub epoch: u64,
    pub window_slots: u64, // how many slots wide the execution window is
    pub committed_at_slot: u64,
    pub reveal_after_slot: u64, // committed_at_slot + window_slots
}

#[derive(Debug, Clone)]
pub struct ScheduleReveal {
    pub seed: [u8; 32],
    pub epoch: u64,
    pub revealed_at_slot: u64,
    pub scheduled_slot: u64, // computed from seed
}

#[derive(Debug, Clone, PartialEq)]
pub enum ScheduleError {
    TooEarlyToReveal, // revealed_at_slot < reveal_after_slot
    SeedMismatch,     // recomputed commitment != stored commitment
    EpochMismatch,    // reveal epoch != commitment epoch
    InvalidWindow,    // window_slots == 0
}

/// Create a commitment for a future schedule.
/// commitment_hash = SHA256("flywheel-sched-v1" || seed || epoch.to_le_bytes() || window_slots.to_le_bytes())
/// reveal_after_slot = committed_at_slot + window_slots
/// Returns Err(InvalidWindow) if window_slots == 0
pub fn commit_next_schedule(
    seed: &[u8; 32],
    epoch: u64,
    window_slots: u64,
    committed_at_slot: u64,
) -> Result<ScheduleCommitment, ScheduleError> {
    if window_slots == 0 {
        return Err(ScheduleError::InvalidWindow);
    }

    let commitment_hash = compute_commitment_hash(seed, epoch, window_slots);

    Ok(ScheduleCommitment {
        commitment_hash,
        epoch,
        window_slots,
        committed_at_slot,
        reveal_after_slot: committed_at_slot + window_slots,
    })
}

/// Compute the pseudo-random scheduled slot within the window.
/// slot = epoch * window_slots + (SHA256("sched-slot" || seed)[0..8] as u64) % window_slots
pub fn compute_scheduled_slot(seed: &[u8; 32], epoch: u64, window_slots: u64) -> u64 {
    let mut hasher = Sha256::new();
    hasher.update(b"sched-slot");
    hasher.update(seed);
    let hash = hasher.finalize();

    let slot_offset = u64::from_le_bytes(hash[0..8].try_into().unwrap()) % window_slots;
    epoch * window_slots + slot_offset
}

/// Verify the seed matches the commitment, then compute the scheduled_slot.
/// Returns Err(TooEarlyToReveal) if revealed_at_slot < commitment.reveal_after_slot
/// Returns Err(EpochMismatch) if reveal epoch != commitment epoch
/// Returns Err(SeedMismatch) if recomputed commitment_hash != stored commitment_hash
pub fn reveal_schedule(
    commitment: &ScheduleCommitment,
    seed: &[u8; 32],
    epoch: u64,
    revealed_at_slot: u64,
) -> Result<ScheduleReveal, ScheduleError> {
    if revealed_at_slot < commitment.reveal_after_slot {
        return Err(ScheduleError::TooEarlyToReveal);
    }

    if epoch != commitment.epoch {
        return Err(ScheduleError::EpochMismatch);
    }

    let recomputed = compute_commitment_hash(seed, epoch, commitment.window_slots);
    if recomputed != commitment.commitment_hash {
        return Err(ScheduleError::SeedMismatch);
    }

    let scheduled_slot = compute_scheduled_slot(seed, epoch, commitment.window_slots);

    Ok(ScheduleReveal {
        seed: *seed,
        epoch,
        revealed_at_slot,
        scheduled_slot,
    })
}

/// Verify a reveal against a commitment. Returns true if valid.
pub fn verify_schedule(commitment: &ScheduleCommitment, reveal: &ScheduleReveal) -> bool {
    if reveal.revealed_at_slot < commitment.reveal_after_slot {
        return false;
    }
    if reveal.epoch != commitment.epoch {
        return false;
    }
    let recomputed = compute_commitment_hash(&reveal.seed, reveal.epoch, commitment.window_slots);
    if recomputed != commitment.commitment_hash {
        return false;
    }
    let expected_slot = compute_scheduled_slot(&reveal.seed, reveal.epoch, commitment.window_slots);
    reveal.scheduled_slot == expected_slot
}

/// Returns true if revealing too early (current_slot < reveal_after_slot).
pub fn reject_early_reveal(commitment: &ScheduleCommitment, current_slot: u64) -> bool {
    current_slot < commitment.reveal_after_slot
}

/// Recompute commitment from seed, return true if mismatch.
pub fn reject_seed_mismatch(commitment: &ScheduleCommitment, seed: &[u8; 32]) -> bool {
    let recomputed = compute_commitment_hash(seed, commitment.epoch, commitment.window_slots);
    recomputed != commitment.commitment_hash
}

// Internal helper: compute SHA256("flywheel-sched-v1" || seed || epoch.to_le_bytes() || window_slots.to_le_bytes())
fn compute_commitment_hash(seed: &[u8; 32], epoch: u64, window_slots: u64) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"flywheel-sched-v1");
    hasher.update(seed);
    hasher.update(epoch.to_le_bytes());
    hasher.update(window_slots.to_le_bytes());
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_seed() -> [u8; 32] {
        let mut seed = [0u8; 32];
        seed[0] = 0xde;
        seed[1] = 0xad;
        seed[2] = 0xbe;
        seed[3] = 0xef;
        seed
    }

    fn wrong_seed() -> [u8; 32] {
        let mut seed = [0u8; 32];
        seed[0] = 0xba;
        seed[1] = 0xad;
        seed[2] = 0xf0;
        seed[3] = 0x0d;
        seed
    }

    #[test]
    fn test_commit_reveal_roundtrip() {
        let seed = test_seed();
        let epoch = 7u64;
        let window_slots = 100u64;
        let committed_at_slot = 500u64;

        let commitment = commit_next_schedule(&seed, epoch, window_slots, committed_at_slot)
            .expect("commit should succeed");

        assert_eq!(commitment.epoch, epoch);
        assert_eq!(commitment.window_slots, window_slots);
        assert_eq!(commitment.committed_at_slot, committed_at_slot);
        assert_eq!(
            commitment.reveal_after_slot,
            committed_at_slot + window_slots
        );

        let reveal = reveal_schedule(&commitment, &seed, epoch, commitment.reveal_after_slot)
            .expect("reveal should succeed");

        assert!(verify_schedule(&commitment, &reveal));
        assert_eq!(reveal.epoch, epoch);
        assert_eq!(reveal.revealed_at_slot, commitment.reveal_after_slot);

        let window_start = epoch * window_slots;
        assert!(reveal.scheduled_slot >= window_start);
        assert!(reveal.scheduled_slot < window_start + window_slots);
    }

    #[test]
    fn test_reject_early_reveal() {
        let seed = test_seed();
        let epoch = 3u64;
        let window_slots = 50u64;
        let committed_at_slot = 200u64;

        let commitment = commit_next_schedule(&seed, epoch, window_slots, committed_at_slot)
            .expect("commit should succeed");

        let early_slot = commitment.reveal_after_slot - 1;
        let err = reveal_schedule(&commitment, &seed, epoch, early_slot)
            .expect_err("should reject early reveal");

        assert_eq!(err, ScheduleError::TooEarlyToReveal);
        assert!(reject_early_reveal(&commitment, early_slot));
        assert!(!reject_early_reveal(
            &commitment,
            commitment.reveal_after_slot
        ));
    }

    #[test]
    fn test_reject_seed_mismatch() {
        let seed = test_seed();
        let bad_seed = wrong_seed();
        let epoch = 1u64;
        let window_slots = 64u64;
        let committed_at_slot = 100u64;

        let commitment = commit_next_schedule(&seed, epoch, window_slots, committed_at_slot)
            .expect("commit should succeed");

        let err = reveal_schedule(&commitment, &bad_seed, epoch, commitment.reveal_after_slot)
            .expect_err("should reject seed mismatch");

        assert_eq!(err, ScheduleError::SeedMismatch);
        assert!(reject_seed_mismatch(&commitment, &bad_seed));
        assert!(!reject_seed_mismatch(&commitment, &seed));
    }

    #[test]
    fn test_epoch_mismatch_rejected() {
        let seed = test_seed();
        let epoch = 5u64;
        let wrong_epoch = 6u64;
        let window_slots = 80u64;
        let committed_at_slot = 400u64;

        let commitment = commit_next_schedule(&seed, epoch, window_slots, committed_at_slot)
            .expect("commit should succeed");

        let err = reveal_schedule(
            &commitment,
            &seed,
            wrong_epoch,
            commitment.reveal_after_slot,
        )
        .expect_err("should reject epoch mismatch");

        assert_eq!(err, ScheduleError::EpochMismatch);
    }

    #[test]
    fn test_scheduled_slot_within_window() {
        let seed = test_seed();
        let epoch = 10u64;
        let window_slots = 256u64;

        let slot = compute_scheduled_slot(&seed, epoch, window_slots);
        let window_start = epoch * window_slots;
        let window_end = window_start + window_slots;

        assert!(
            slot >= window_start && slot < window_end,
            "scheduled_slot {} must be in [{}, {})",
            slot,
            window_start,
            window_end
        );
    }

    #[test]
    fn test_invalid_window_rejected() {
        let seed = test_seed();
        let epoch = 0u64;
        let window_slots = 0u64;
        let committed_at_slot = 0u64;

        let err = commit_next_schedule(&seed, epoch, window_slots, committed_at_slot)
            .expect_err("should reject zero window");

        assert_eq!(err, ScheduleError::InvalidWindow);
    }
}
