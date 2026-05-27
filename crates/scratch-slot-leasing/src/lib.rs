use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SlotState {
    Available,
    Leased,
    Expired,
    Dirty,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScratchSlot {
    pub slot_id: [u8; 32],
    pub state: SlotState,
    pub current_lease_hash: [u8; 32],
    pub expires_at_slot: u64,
    pub state_hash: [u8; 32],
    pub rent_deposit_lamports: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaseRequest {
    pub user_hash: [u8; 32],
    pub job_hash: [u8; 32],
    pub requested_slots: u32,
    pub max_lamports: u64,
    pub expires_at_slot: u64,
}

#[derive(Debug, PartialEq)]
pub enum LeaseError {
    SlotOccupied,
    SlotDirty,
    NotExpired,
    TooManySlots,
    InsufficientFunds,
}

pub fn lease_slot(
    slot: &mut ScratchSlot,
    request: &LeaseRequest,
    current_slot: u64,
) -> Result<[u8; 32], LeaseError> {
    match slot.state {
        SlotState::Leased => {
            if slot.expires_at_slot >= current_slot {
                return Err(LeaseError::SlotOccupied);
            }
        }
        SlotState::Dirty => return Err(LeaseError::SlotDirty),
        _ => {}
    }

    if request.max_lamports < slot.rent_deposit_lamports {
        return Err(LeaseError::InsufficientFunds);
    }

    let mut h = Sha256::new();
    h.update(b"scratch_lease_v1");
    h.update(slot.slot_id);
    h.update(request.job_hash);
    let lease_hash: [u8; 32] = h.finalize().into();

    slot.state = SlotState::Leased;
    slot.current_lease_hash = lease_hash;
    slot.expires_at_slot = request.expires_at_slot;

    Ok(lease_hash)
}

pub fn release_slot(slot: &mut ScratchSlot, _current_slot: u64) -> Result<u64, LeaseError> {
    let rent = slot.rent_deposit_lamports;
    slot.state = SlotState::Available;
    slot.current_lease_hash = [0u8; 32];
    Ok(rent)
}

pub fn cleanup_expired_lease(slot: &mut ScratchSlot, current_slot: u64) -> Result<(), LeaseError> {
    if current_slot <= slot.expires_at_slot {
        return Err(LeaseError::NotExpired);
    }
    slot.state = SlotState::Available;
    slot.current_lease_hash = [0u8; 32];
    Ok(())
}

pub fn compute_rent_saved_vs_new_pda(rent_per_pda: u64, slots_reused: u32) -> u64 {
    rent_per_pda * slots_reused as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_slot(state: SlotState, expires: u64, rent: u64) -> ScratchSlot {
        ScratchSlot {
            slot_id: [0xABu8; 32],
            state,
            current_lease_hash: [0u8; 32],
            expires_at_slot: expires,
            state_hash: [0u8; 32],
            rent_deposit_lamports: rent,
        }
    }

    fn make_request(max_lamports: u64, expires: u64) -> LeaseRequest {
        LeaseRequest {
            user_hash: [1u8; 32],
            job_hash: [2u8; 32],
            requested_slots: 1,
            max_lamports,
            expires_at_slot: expires,
        }
    }

    #[test]
    fn test_cannot_lease_occupied_slot() {
        let mut slot = make_slot(SlotState::Leased, 2000, 1_000);
        let req = make_request(5_000, 3000);
        assert_eq!(
            lease_slot(&mut slot, &req, 1000),
            Err(LeaseError::SlotOccupied)
        );
    }

    #[test]
    fn test_dirty_slot_rejected() {
        let mut slot = make_slot(SlotState::Dirty, 0, 1_000);
        let req = make_request(5_000, 3000);
        assert_eq!(
            lease_slot(&mut slot, &req, 1000),
            Err(LeaseError::SlotDirty)
        );
    }

    #[test]
    fn test_expired_slot_can_be_reclaimed() {
        let mut slot = make_slot(SlotState::Leased, 500, 1_000);
        let req = make_request(5_000, 3000);
        assert!(lease_slot(&mut slot, &req, 1000).is_ok());
    }

    #[test]
    fn test_rent_saved_positive() {
        let saved = compute_rent_saved_vs_new_pda(2_039_280, 3);
        assert!(saved > 0);
        assert_eq!(saved, 2_039_280 * 3);
    }

    #[test]
    fn test_lease_hash_binds_job() {
        let mut slot = make_slot(SlotState::Available, 0, 500);
        let req = make_request(5_000, 3000);
        let hash1 = lease_slot(&mut slot, &req, 1000).unwrap();

        let mut slot2 = make_slot(SlotState::Available, 0, 500);
        let mut req2 = make_request(5_000, 3000);
        req2.job_hash = [3u8; 32];
        let hash2 = lease_slot(&mut slot2, &req2, 1000).unwrap();

        assert_ne!(hash1, hash2);
    }

    #[test]
    fn test_insufficient_funds_rejected() {
        let mut slot = make_slot(SlotState::Available, 0, 10_000);
        let req = make_request(500, 3000);
        assert_eq!(
            lease_slot(&mut slot, &req, 1000),
            Err(LeaseError::InsufficientFunds)
        );
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_lease_hash_nonzero() {
        let mut slot = make_slot(SlotState::Available, 0, 500);
        let req = make_request(5_000, 3000);
        let hash = lease_slot(&mut slot, &req, 1000).unwrap();
        assert_ne!(hash, [0u8; 32]);
    }

    #[test]
    fn test_lease_hash_deterministic() {
        let req = make_request(5_000, 3000);
        let mut s1 = make_slot(SlotState::Available, 0, 500);
        let mut s2 = make_slot(SlotState::Available, 0, 500);
        let h1 = lease_slot(&mut s1, &req, 1000).unwrap();
        let h2 = lease_slot(&mut s2, &req, 1000).unwrap();
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_available_slot_leased_ok() {
        let mut slot = make_slot(SlotState::Available, 0, 1_000);
        let req = make_request(5_000, 5000);
        assert!(lease_slot(&mut slot, &req, 1000).is_ok());
    }

    #[test]
    fn test_release_slot_returns_rent() {
        let mut slot = make_slot(SlotState::Leased, 100, 7_500);
        let rent = release_slot(&mut slot, 200).unwrap();
        assert_eq!(rent, 7_500);
    }

    #[test]
    fn test_cleanup_expired_ok() {
        let mut slot = make_slot(SlotState::Leased, 100, 1_000);
        assert!(cleanup_expired_lease(&mut slot, 101).is_ok());
        assert_eq!(slot.state, SlotState::Available);
    }

    #[test]
    fn test_cleanup_not_expired_rejected() {
        // current_slot <= expires_at_slot → NotExpired; equality is not expired
        let mut slot = make_slot(SlotState::Leased, 100, 1_000);
        assert_eq!(
            cleanup_expired_lease(&mut slot, 100),
            Err(LeaseError::NotExpired)
        );
    }

    #[test]
    fn test_slot_state_becomes_leased() {
        let mut slot = make_slot(SlotState::Available, 0, 500);
        let req = make_request(5_000, 9999);
        lease_slot(&mut slot, &req, 1).unwrap();
        assert_eq!(slot.state, SlotState::Leased);
    }

    #[test]
    fn test_slot_expires_updated() {
        let mut slot = make_slot(SlotState::Available, 0, 500);
        let req = make_request(5_000, 8888);
        lease_slot(&mut slot, &req, 1).unwrap();
        assert_eq!(slot.expires_at_slot, 8888);
    }

    #[test]
    fn test_rent_saved_zero_reuses() {
        assert_eq!(compute_rent_saved_vs_new_pda(2_039_280, 0), 0);
    }

    #[test]
    fn test_release_clears_lease_hash() {
        let mut slot = make_slot(SlotState::Leased, 100, 1_000);
        slot.current_lease_hash = [0xFFu8; 32];
        release_slot(&mut slot, 200).unwrap();
        assert_eq!(slot.current_lease_hash, [0u8; 32]);
    }
}
