use sha2::{Digest, Sha256};

pub const DOMAIN_FUSE: u8 = 0x60;

#[derive(Clone, Debug)]
pub struct LossFuse {
    pub session_id: [u8; 32],
    pub starting_balance_lamports: u64,
    /// Maximum drawdown in basis points (e.g. 2000 = 20%)
    pub max_drawdown_bps: u32,
    pub max_failed_spends: u32,
    pub max_spends_per_window: u32,
    pub window_slots: u64,
    pub cooloff_slots: u64,
    pub requires_user_rearm: bool,
}

#[derive(Clone, Debug)]
pub struct FuseState {
    pub fuse: LossFuse,
    pub current_balance_lamports: u64,
    pub failed_spend_count: u32,
    pub window_spend_count: u32,
    pub window_start_slot: u64,
    pub tripped: bool,
    pub tripped_at_slot: Option<u64>,
    pub armed: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FuseError {
    Tripped,
    DrawdownExceeded,
    FailedSpendLimitExceeded,
    WindowSpendLimitExceeded,
    CooloffActive,
    AgentCannotRearm,
}

impl FuseState {
    pub fn new(fuse: LossFuse, current_slot: u64) -> Self {
        let start_bal = fuse.starting_balance_lamports;
        Self {
            fuse,
            current_balance_lamports: start_bal,
            failed_spend_count: 0,
            window_spend_count: 0,
            window_start_slot: current_slot,
            tripped: false,
            tripped_at_slot: None,
            armed: true,
        }
    }

    pub fn record_spend(
        &mut self,
        amount: u64,
        success: bool,
        current_slot: u64,
    ) -> Result<(), FuseError> {
        if self.tripped {
            return Err(FuseError::Tripped);
        }

        // Reset window if expired
        if current_slot >= self.window_start_slot + self.fuse.window_slots {
            self.window_spend_count = 0;
            self.window_start_slot = current_slot;
        }

        // Check window limit before incrementing
        if self.window_spend_count >= self.fuse.max_spends_per_window {
            self.trip(current_slot);
            return Err(FuseError::WindowSpendLimitExceeded);
        }

        self.window_spend_count += 1;

        if !success {
            self.failed_spend_count += 1;
            if self.failed_spend_count >= self.fuse.max_failed_spends {
                self.trip(current_slot);
                return Err(FuseError::FailedSpendLimitExceeded);
            }
        } else {
            self.current_balance_lamports = self.current_balance_lamports.saturating_sub(amount);
            let loss = self
                .fuse
                .starting_balance_lamports
                .saturating_sub(self.current_balance_lamports);
            let max_loss = self.fuse.starting_balance_lamports as u128
                * self.fuse.max_drawdown_bps as u128
                / 10_000;
            if loss as u128 > max_loss {
                self.trip(current_slot);
                return Err(FuseError::DrawdownExceeded);
            }
        }
        Ok(())
    }

    fn trip(&mut self, slot: u64) {
        self.tripped = true;
        self.tripped_at_slot = Some(slot);
    }

    /// Only user can rearm (not agent). Agent calling this is rejected via AgentCannotRearm
    /// by the calling convention — here we check cooloff only.
    pub fn user_rearm(&mut self, current_slot: u64) -> Result<(), FuseError> {
        if let Some(tripped_at) = self.tripped_at_slot {
            if current_slot < tripped_at + self.fuse.cooloff_slots {
                return Err(FuseError::CooloffActive);
            }
        }
        self.tripped = false;
        self.tripped_at_slot = None;
        self.failed_spend_count = 0;
        self.window_spend_count = 0;
        self.window_start_slot = current_slot;
        // Restore balance baseline so drawdown calculation starts fresh
        self.current_balance_lamports = self.fuse.starting_balance_lamports;
        self.armed = true;
        Ok(())
    }

    /// Deterministic hash of the fuse configuration (not mutable state).
    pub fn fuse_hash(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update([DOMAIN_FUSE]);
        h.update(&self.fuse.session_id);
        h.update(self.fuse.starting_balance_lamports.to_le_bytes());
        h.update(self.fuse.max_drawdown_bps.to_le_bytes());
        h.update([self.fuse.requires_user_rearm as u8]);
        h.finalize().into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_fuse() -> LossFuse {
        LossFuse {
            session_id: [0xCCu8; 32],
            starting_balance_lamports: 10_000_000,
            max_drawdown_bps: 2000, // 20%
            max_failed_spends: 3,
            max_spends_per_window: 5,
            window_slots: 100,
            cooloff_slots: 50,
            requires_user_rearm: true,
        }
    }

    #[test]
    fn test_drawdown_trips_fuse() {
        let fuse = make_fuse(); // 20% of 10_000_000 = 2_000_000
        let mut state = FuseState::new(fuse, 0);
        // Spend 2_000_001 (just over 20%)
        let result = state.record_spend(2_000_001, true, 1);
        assert_eq!(result, Err(FuseError::DrawdownExceeded));
        assert!(state.tripped);
    }

    #[test]
    fn test_failed_spend_trips_fuse() {
        let fuse = make_fuse(); // max_failed_spends=3
        let mut state = FuseState::new(fuse, 0);
        assert!(state.record_spend(100, false, 1).is_ok());
        assert!(state.record_spend(100, false, 2).is_ok());
        let result = state.record_spend(100, false, 3);
        assert_eq!(result, Err(FuseError::FailedSpendLimitExceeded));
        assert!(state.tripped);
    }

    #[test]
    fn test_window_limit_trips_fuse() {
        let fuse = make_fuse(); // max_spends_per_window=5
        let mut state = FuseState::new(fuse, 0);
        for i in 0..5u64 {
            assert!(state.record_spend(1, true, i).is_ok());
        }
        // 6th spend in same window should trip
        let result = state.record_spend(1, true, 5);
        assert_eq!(result, Err(FuseError::WindowSpendLimitExceeded));
        assert!(state.tripped);
    }

    #[test]
    fn test_tripped_rejects_all() {
        let fuse = make_fuse();
        let mut state = FuseState::new(fuse, 0);
        // Force trip via drawdown
        let _ = state.record_spend(2_000_001, true, 1);
        assert!(state.tripped);
        // Any subsequent spend is rejected
        let result = state.record_spend(1, true, 2);
        assert_eq!(result, Err(FuseError::Tripped));
    }

    #[test]
    fn test_cooloff_prevents_rearm() {
        let fuse = make_fuse(); // cooloff_slots=50
        let mut state = FuseState::new(fuse, 0);
        let _ = state.record_spend(2_000_001, true, 10);
        assert!(state.tripped);
        // Try to rearm 30 slots later (within cooloff of 50)
        let result = state.user_rearm(40);
        assert_eq!(result, Err(FuseError::CooloffActive));
    }

    #[test]
    fn test_user_rearm_after_cooloff() {
        let fuse = make_fuse(); // cooloff_slots=50, tripped at slot 10
        let mut state = FuseState::new(fuse, 0);
        let _ = state.record_spend(2_000_001, true, 10);
        assert!(state.tripped);
        // Rearm at slot 60 (10 + 50 = 60 — exactly at cooloff boundary)
        let result = state.user_rearm(60);
        assert!(result.is_ok(), "should rearm after cooloff");
        assert!(!state.tripped);
        assert!(state.armed);
        // Can spend again
        assert!(state.record_spend(100, true, 61).is_ok());
    }

    #[test]
    fn test_fuse_hash_stable() {
        let fuse = make_fuse();
        let state = FuseState::new(fuse, 0);
        let h1 = state.fuse_hash();
        let h2 = state.fuse_hash();
        assert_eq!(h1, h2);
        assert_ne!(h1, [0u8; 32]);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_fuse_hash_nonzero() {
        let fuse = make_fuse();
        let state = FuseState::new(fuse, 0);
        assert_ne!(state.fuse_hash(), [0u8; 32]);
    }

    #[test]
    fn test_fuse_hash_session_sensitive() {
        let mut fuse_a = make_fuse();
        let mut fuse_b = make_fuse();
        fuse_a.session_id = [0x01u8; 32];
        fuse_b.session_id = [0x02u8; 32];
        let state_a = FuseState::new(fuse_a, 0);
        let state_b = FuseState::new(fuse_b, 0);
        assert_ne!(state_a.fuse_hash(), state_b.fuse_hash());
    }

    #[test]
    fn test_window_resets_after_expiry() {
        let fuse = make_fuse(); // max_spends_per_window=5, window_slots=100
        let mut state = FuseState::new(fuse, 0);
        // Fill the window (5 spends)
        for i in 0..5u64 {
            assert!(state.record_spend(1, true, i).is_ok());
        }
        // After window expiry (slot 100), window resets and another spend is allowed
        assert!(
            state.record_spend(1, true, 100).is_ok(),
            "spend after window expiry should succeed after reset"
        );
    }

    #[test]
    fn test_drawdown_at_exact_limit_ok() {
        // max_drawdown_bps=2000 of 10_000_000 → max_loss = 2_000_000
        // spending exactly 2_000_000 → loss == max_loss → 2_000_000 > 2_000_000 is false → Ok
        let fuse = make_fuse();
        let mut state = FuseState::new(fuse, 0);
        let result = state.record_spend(2_000_000, true, 1);
        assert!(
            result.is_ok(),
            "spending exactly at drawdown limit must be ok"
        );
        assert!(!state.tripped);
    }

    #[test]
    fn test_failed_spend_before_limit_ok() {
        // max_failed_spends=3 — two failures should not trip
        let fuse = make_fuse();
        let mut state = FuseState::new(fuse, 0);
        assert!(state.record_spend(1, false, 1).is_ok());
        assert!(state.record_spend(1, false, 2).is_ok());
        assert!(
            !state.tripped,
            "two failures below limit must not trip fuse"
        );
    }

    #[test]
    fn test_rearm_resets_counts() {
        let fuse = make_fuse();
        let mut state = FuseState::new(fuse, 0);
        // Trip it via drawdown
        let _ = state.record_spend(2_000_001, true, 10);
        // Rearm after cooloff
        let _ = state.user_rearm(60);
        assert_eq!(state.failed_spend_count, 0);
        assert_eq!(state.window_spend_count, 0);
    }

    #[test]
    fn test_state_starts_armed() {
        let fuse = make_fuse();
        let state = FuseState::new(fuse, 0);
        assert!(state.armed);
        assert!(!state.tripped);
    }

    #[test]
    fn test_tripped_at_slot_recorded() {
        let fuse = make_fuse();
        let mut state = FuseState::new(fuse, 0);
        let _ = state.record_spend(2_000_001, true, 42);
        assert_eq!(state.tripped_at_slot, Some(42));
    }

    #[test]
    fn test_cooloff_one_slot_early_fails() {
        // tripped at slot 10, cooloff=50 → must rearm at >= 60; slot 59 → CooloffActive
        let fuse = make_fuse();
        let mut state = FuseState::new(fuse, 0);
        let _ = state.record_spend(2_000_001, true, 10);
        assert_eq!(state.user_rearm(59), Err(FuseError::CooloffActive));
    }
}
