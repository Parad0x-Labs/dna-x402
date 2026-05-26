use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub const DOMAIN_METER: u8 = 0x70;
pub const DOMAIN_CALL: u8 = 0x71;

#[derive(Clone, Debug)]
pub struct MeterNote {
    pub meter_id: [u8; 32],
    pub scope_hash: [u8; 32],
    pub total_calls: u32,
    pub epoch: u64,
}

impl MeterNote {
    pub fn meter_root(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update([DOMAIN_METER]);
        h.update(&self.meter_id);
        h.update(&self.scope_hash);
        h.update(self.total_calls.to_le_bytes());
        h.update(self.epoch.to_le_bytes());
        h.finalize().into()
    }

    /// Nullifier for call #n — unique per meter+n, prevents per-call PDA overhead.
    pub fn call_nullifier(&self, call_index: u32) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update([DOMAIN_CALL]);
        h.update(&self.meter_id);
        h.update(&self.scope_hash);
        h.update(call_index.to_le_bytes());
        h.update(self.epoch.to_le_bytes());
        h.finalize().into()
    }
}

#[derive(Debug)]
pub struct ApiMeter {
    pub note: MeterNote,
    pub calls_used: u32,
    pub redeemed_nullifiers: HashSet<[u8; 32]>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum MeterError {
    Exhausted,
    WrongScope,
    DuplicateCall,
}

impl ApiMeter {
    pub fn new(note: MeterNote) -> Self {
        Self {
            note,
            calls_used: 0,
            redeemed_nullifiers: HashSet::new(),
        }
    }

    /// Burn one call from this meter. Returns the nullifier for the call.
    pub fn burn_call(&mut self, scope_hash: &[u8; 32]) -> Result<[u8; 32], MeterError> {
        if scope_hash != &self.note.scope_hash {
            return Err(MeterError::WrongScope);
        }
        if self.calls_used >= self.note.total_calls {
            return Err(MeterError::Exhausted);
        }
        let nullifier = self.note.call_nullifier(self.calls_used);
        if self.redeemed_nullifiers.contains(&nullifier) {
            return Err(MeterError::DuplicateCall);
        }
        self.redeemed_nullifiers.insert(nullifier);
        self.calls_used += 1;
        Ok(nullifier)
    }

    /// Remaining calls available.
    pub fn remaining(&self) -> u32 {
        self.note.total_calls.saturating_sub(self.calls_used)
    }

    /// Create a new MeterNote for a refill (fresh epoch, new meter_id derived from salt).
    pub fn refill(
        scope_hash: [u8; 32],
        new_calls: u32,
        new_epoch: u64,
        salt: [u8; 32],
    ) -> MeterNote {
        let mut h = Sha256::new();
        h.update([DOMAIN_METER, 0xFF]);
        h.update(&scope_hash);
        h.update(new_calls.to_le_bytes());
        h.update(new_epoch.to_le_bytes());
        h.update(&salt);
        let meter_id: [u8; 32] = h.finalize().into();
        MeterNote {
            meter_id,
            scope_hash,
            total_calls: new_calls,
            epoch: new_epoch,
        }
    }

    /// Pre-compute nullifiers for the first `count` calls (for batch submission).
    pub fn batch_nullifiers(&self, count: u32) -> Vec<[u8; 32]> {
        (0..count.min(self.note.total_calls))
            .map(|i| self.note.call_nullifier(i))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_note(total_calls: u32) -> MeterNote {
        MeterNote {
            meter_id: [0x11u8; 32],
            scope_hash: [0x22u8; 32],
            total_calls,
            epoch: 42,
        }
    }

    #[test]
    fn test_burn_call_ok() {
        let note = make_note(5);
        let mut meter = ApiMeter::new(note);
        let nullifier = meter.burn_call(&[0x22u8; 32]).expect("first burn ok");
        assert_ne!(nullifier, [0u8; 32]);
        assert_eq!(meter.calls_used, 1);
        assert_eq!(meter.remaining(), 4);
    }

    #[test]
    fn test_exhausted() {
        let note = make_note(2);
        let mut meter = ApiMeter::new(note);
        meter.burn_call(&[0x22u8; 32]).unwrap();
        meter.burn_call(&[0x22u8; 32]).unwrap();
        let result = meter.burn_call(&[0x22u8; 32]);
        assert_eq!(result, Err(MeterError::Exhausted));
    }

    #[test]
    fn test_wrong_scope() {
        let note = make_note(5);
        let mut meter = ApiMeter::new(note);
        let wrong_scope = [0xFFu8; 32];
        let result = meter.burn_call(&wrong_scope);
        assert_eq!(result, Err(MeterError::WrongScope));
    }

    #[test]
    fn test_remaining_count() {
        let note = make_note(10);
        let mut meter = ApiMeter::new(note);
        assert_eq!(meter.remaining(), 10);
        meter.burn_call(&[0x22u8; 32]).unwrap();
        assert_eq!(meter.remaining(), 9);
        for _ in 0..9 {
            meter.burn_call(&[0x22u8; 32]).unwrap();
        }
        assert_eq!(meter.remaining(), 0);
    }

    #[test]
    fn test_batch_nullifiers_deterministic() {
        let note = make_note(5);
        let meter = ApiMeter::new(note.clone());
        let batch1 = meter.batch_nullifiers(5);
        let meter2 = ApiMeter::new(note);
        let batch2 = meter2.batch_nullifiers(5);
        assert_eq!(batch1, batch2);
        assert_eq!(batch1.len(), 5);
        // All nullifiers must be distinct
        let unique: HashSet<_> = batch1.iter().collect();
        assert_eq!(unique.len(), 5);
    }

    #[test]
    fn test_refill_creates_new_meter() {
        let scope = [0x33u8; 32];
        let salt1 = [0xAAu8; 32];
        let salt2 = [0xBBu8; 32];
        let note1 = ApiMeter::refill(scope, 100, 1, salt1);
        let note2 = ApiMeter::refill(scope, 100, 1, salt2);
        // Different salts → different meter_ids
        assert_ne!(note1.meter_id, note2.meter_id);
        assert_eq!(note1.total_calls, 100);
        assert_eq!(note1.scope_hash, scope);
        // Same inputs → deterministic
        let note1b = ApiMeter::refill(scope, 100, 1, salt1);
        assert_eq!(note1.meter_id, note1b.meter_id);
    }
}
