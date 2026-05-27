use sha2::{Digest, Sha256};

pub const DOMAIN_SESSION: u8 = 0x20;
pub const DOMAIN_NET_SETTLE: u8 = 0x21;
pub const DOMAIN_OBLIGATION: u8 = 0x22;

#[derive(Clone, Debug)]
pub struct SessionNote {
    pub scope_hash: [u8; 32],
    pub amount_lamports: u64,
    pub service_hash: [u8; 32],
    pub nullifier: [u8; 32],
}

impl SessionNote {
    pub fn note_hash(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update([DOMAIN_SESSION]);
        h.update(&self.scope_hash);
        h.update(self.amount_lamports.to_le_bytes());
        h.update(&self.service_hash);
        h.update(&self.nullifier);
        h.finalize().into()
    }
}

#[derive(Clone, Debug)]
pub struct ServiceObligation {
    pub service_hash: [u8; 32],
    pub expected_fulfillment_hash: [u8; 32],
    pub amount_lamports: u64,
}

#[derive(Clone, Debug)]
pub struct Session {
    pub session_id: [u8; 32],
    pub starting_balance_commitment: [u8; 32],
    pub macaroon_hash: [u8; 32],
    pub notes: Vec<SessionNote>,
    pub obligations: Vec<ServiceObligation>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SessionError {
    ExceedsMacaroonLimit,
    ScopeViolation,
    EmptySession,
    DuplicateNullifier,
}

impl Session {
    pub fn new(session_id: [u8; 32], starting_balance: [u8; 32], macaroon_hash: [u8; 32]) -> Self {
        Self {
            session_id,
            starting_balance_commitment: starting_balance,
            macaroon_hash,
            notes: vec![],
            obligations: vec![],
        }
    }

    pub fn add_note(&mut self, note: SessionNote) -> Result<(), SessionError> {
        // Reject duplicate nullifiers
        if self.notes.iter().any(|n| n.nullifier == note.nullifier) {
            return Err(SessionError::DuplicateNullifier);
        }
        self.notes.push(note);
        Ok(())
    }

    pub fn total_spent(&self) -> u64 {
        self.notes.iter().map(|n| n.amount_lamports).sum()
    }

    /// Net settlement hash — one hash represents all N spends.
    pub fn net_settlement_hash(&self) -> Result<[u8; 32], SessionError> {
        if self.notes.is_empty() {
            return Err(SessionError::EmptySession);
        }
        let mut h = Sha256::new();
        h.update([DOMAIN_NET_SETTLE]);
        h.update(&self.session_id);
        h.update(&self.macaroon_hash);
        h.update(self.total_spent().to_le_bytes());
        h.update((self.notes.len() as u32).to_le_bytes());
        for note in &self.notes {
            h.update(note.note_hash());
        }
        Ok(h.finalize().into())
    }

    pub fn ending_balance_commitment(&self, new_balance: u64) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update([DOMAIN_SESSION]);
        h.update(&self.session_id);
        h.update(&self.starting_balance_commitment);
        h.update(new_balance.to_le_bytes());
        h.finalize().into()
    }

    pub fn dispute_hash(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update([DOMAIN_NET_SETTLE, 0xFF]);
        h.update(&self.session_id);
        h.update(self.total_spent().to_le_bytes());
        for o in &self.obligations {
            h.update(&o.service_hash);
            h.update(&o.expected_fulfillment_hash);
        }
        h.finalize().into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_note(amount: u64, nullifier: u8) -> SessionNote {
        SessionNote {
            scope_hash: [0xAA; 32],
            amount_lamports: amount,
            service_hash: [0xBB; 32],
            nullifier: [nullifier; 32],
        }
    }

    fn make_session() -> Session {
        Session::new([0x01; 32], [0x02; 32], [0x03; 32])
    }

    #[test]
    fn test_empty_session_error() {
        let s = make_session();
        assert_eq!(s.net_settlement_hash(), Err(SessionError::EmptySession));
    }

    #[test]
    fn test_add_notes_and_total() {
        let mut s = make_session();
        s.add_note(make_note(1_000, 1)).unwrap();
        s.add_note(make_note(2_000, 2)).unwrap();
        assert_eq!(s.total_spent(), 3_000);
        assert_eq!(s.notes.len(), 2);
    }

    #[test]
    fn test_net_settlement_deterministic() {
        let mut s = make_session();
        s.add_note(make_note(500, 1)).unwrap();
        let h1 = s.net_settlement_hash().unwrap();
        let h2 = s.net_settlement_hash().unwrap();
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_net_settlement_changes_with_note() {
        let mut s1 = make_session();
        s1.add_note(make_note(500, 1)).unwrap();
        let h1 = s1.net_settlement_hash().unwrap();

        let mut s2 = make_session();
        s2.add_note(make_note(500, 1)).unwrap();
        s2.add_note(make_note(100, 2)).unwrap();
        let h2 = s2.net_settlement_hash().unwrap();

        assert_ne!(h1, h2);
    }

    #[test]
    fn test_duplicate_nullifier_rejected() {
        let mut s = make_session();
        s.add_note(make_note(100, 5)).unwrap();
        let err = s.add_note(make_note(200, 5)).unwrap_err();
        assert_eq!(err, SessionError::DuplicateNullifier);
    }

    #[test]
    fn test_ending_balance_commitment() {
        let s = make_session();
        let ebc1 = s.ending_balance_commitment(1_000_000);
        let ebc2 = s.ending_balance_commitment(1_000_000);
        let ebc3 = s.ending_balance_commitment(999_999);
        assert_eq!(ebc1, ebc2);
        assert_ne!(ebc1, ebc3);
    }

    #[test]
    fn test_dispute_hash_distinct_from_settlement() {
        let mut s = make_session();
        s.add_note(make_note(500, 1)).unwrap();
        let settlement = s.net_settlement_hash().unwrap();
        let dispute = s.dispute_hash();
        assert_ne!(settlement, dispute);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_note_hash_nonzero() {
        let note = make_note(500, 1);
        assert_ne!(note.note_hash(), [0u8; 32]);
    }

    #[test]
    fn test_net_settlement_nonzero() {
        let mut s = make_session();
        s.add_note(make_note(500, 1)).unwrap();
        assert_ne!(s.net_settlement_hash().unwrap(), [0u8; 32]);
    }

    #[test]
    fn test_session_id_stored() {
        let id = [0xAAu8; 32];
        let s = Session::new(id, [0u8; 32], [0u8; 32]);
        assert_eq!(s.session_id, id);
    }

    #[test]
    fn test_note_hash_amount_sensitive() {
        let n1 = make_note(100, 1);
        let n2 = make_note(200, 1);
        assert_ne!(n1.note_hash(), n2.note_hash());
    }

    #[test]
    fn test_note_hash_nullifier_sensitive() {
        let n1 = make_note(100, 1);
        let n2 = make_note(100, 2);
        assert_ne!(n1.note_hash(), n2.note_hash());
    }

    #[test]
    fn test_ending_balance_nonzero() {
        let s = make_session();
        let ebc = s.ending_balance_commitment(1_000_000);
        assert_ne!(ebc, [0u8; 32]);
    }

    #[test]
    fn test_dispute_hash_nonzero() {
        let s = make_session();
        assert_ne!(s.dispute_hash(), [0u8; 32]);
    }

    #[test]
    fn test_total_spent_empty() {
        let s = make_session();
        assert_eq!(s.total_spent(), 0);
    }

    #[test]
    fn test_note_count_after_add() {
        let mut s = make_session();
        s.add_note(make_note(100, 1)).unwrap();
        s.add_note(make_note(200, 2)).unwrap();
        s.add_note(make_note(300, 3)).unwrap();
        assert_eq!(s.notes.len(), 3);
    }
}
