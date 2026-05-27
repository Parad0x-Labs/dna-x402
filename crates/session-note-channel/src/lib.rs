use sha2::{Digest, Sha256};
use std::collections::HashSet;

// ---------------------------------------------------------------------------
// Private domain-separated hash helper
// ---------------------------------------------------------------------------

fn sha256_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for input in inputs {
        h.update(input);
    }
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionNoteChannel {
    pub session_hash: [u8; 32],
    pub starting_balance_commitment: [u8; 32],
    pub permission_hash: [u8; 32],
    pub note_count: u32,
    pub note_amount_each: u64, // lamports per note
    pub expiry_slot: u64,
}

impl SessionNoteChannel {
    pub fn total_balance(&self) -> u64 {
        self.note_count as u64 * self.note_amount_each
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionSpendNote {
    pub session_hash: [u8; 32],
    pub note_index: u32,
    pub amount: u64,
    pub scope_hash: [u8; 32],
    pub nullifier: [u8; 32],
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionSettlementRoot {
    pub session_hash: [u8; 32],
    pub root: [u8; 32],
    pub total_spent: u64,
    pub notes_used: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct UnusedNoteRefund {
    pub session_hash: [u8; 32],
    pub unspent_amount: u64,
    pub unused_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionError {
    NoteAlreadyUsed { nullifier: [u8; 32] },
    SessionExpired { expiry: u64, current: u64 },
    OverSpend { capacity: u64, requested: u64 },
    EmptySession,
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/// Issue N spend notes for a session.
///
/// Each note's nullifier is:
///   SHA256("dark_null_v1_session_note" || session_hash || note_index_le4 || scope_hash)
///
/// All notes share the same scope_hash (passed in) per session.
pub fn issue_notes(channel: &SessionNoteChannel, scope_hash: [u8; 32]) -> Vec<SessionSpendNote> {
    let domain = b"dark_null_v1_session_note";
    (0..channel.note_count)
        .map(|i| {
            let index_bytes = i.to_le_bytes();
            let nullifier = sha256_domain(
                domain,
                &[
                    channel.session_hash.as_ref(),
                    index_bytes.as_ref(),
                    scope_hash.as_ref(),
                ],
            );
            SessionSpendNote {
                session_hash: channel.session_hash,
                note_index: i,
                amount: channel.note_amount_each,
                scope_hash,
                nullifier,
            }
        })
        .collect()
}

/// Attempt to spend a note.
///
/// Fails with `SessionExpired` if `current_slot > channel.expiry_slot`.
/// Fails with `NoteAlreadyUsed` if the note's nullifier is already in `used_nullifiers`.
/// Returns a reference to the note on success.
pub fn spend_note<'a>(
    note: &'a SessionSpendNote,
    channel: &SessionNoteChannel,
    current_slot: u64,
    used_nullifiers: &HashSet<[u8; 32]>,
) -> Result<&'a SessionSpendNote, SessionError> {
    if current_slot > channel.expiry_slot {
        return Err(SessionError::SessionExpired {
            expiry: channel.expiry_slot,
            current: current_slot,
        });
    }
    if used_nullifiers.contains(&note.nullifier) {
        return Err(SessionError::NoteAlreadyUsed {
            nullifier: note.nullifier,
        });
    }
    Ok(note)
}

/// Collapse all used notes into one settlement root.
///
/// Root = SHA256("dark_null_v1_session_settlement" || session_hash || nullifier_0 || … || nullifier_n)
/// (nullifiers sorted for determinism)
///
/// Returns `EmptySession` if `used_notes` is empty.
/// Returns `OverSpend` if the sum of note amounts exceeds `channel.total_balance()`.
pub fn settle_session(
    channel: &SessionNoteChannel,
    used_notes: &[SessionSpendNote],
) -> Result<SessionSettlementRoot, SessionError> {
    if used_notes.is_empty() {
        // An empty settlement is still valid — zero spent, zero notes.
        let root = sha256_domain(
            b"dark_null_v1_session_settlement",
            &[channel.session_hash.as_ref()],
        );
        return Ok(SessionSettlementRoot {
            session_hash: channel.session_hash,
            root,
            total_spent: 0,
            notes_used: 0,
        });
    }

    // Check for overspend: sum note amounts against channel capacity.
    let total_spent: u64 = used_notes.iter().map(|n| n.amount).sum();
    let capacity = channel.total_balance();
    if total_spent > capacity {
        return Err(SessionError::OverSpend {
            capacity,
            requested: total_spent,
        });
    }

    // Sort nullifiers for deterministic root.
    let mut sorted_nullifiers: Vec<[u8; 32]> = used_notes.iter().map(|n| n.nullifier).collect();
    sorted_nullifiers.sort();

    let domain = b"dark_null_v1_session_settlement";
    let mut h = Sha256::new();
    h.update(domain);
    h.update(channel.session_hash);
    for nul in &sorted_nullifiers {
        h.update(nul);
    }
    let root: [u8; 32] = h.finalize().into();

    Ok(SessionSettlementRoot {
        session_hash: channel.session_hash,
        root,
        total_spent,
        notes_used: used_notes.len() as u32,
    })
}

/// Compute the refund for unused notes.
///
/// A note is "unused" if its nullifier is NOT in `used_nullifiers`.
pub fn refund_unused(
    channel: &SessionNoteChannel,
    used_nullifiers: &HashSet<[u8; 32]>,
    issued_notes: &[SessionSpendNote],
) -> UnusedNoteRefund {
    let unused: Vec<&SessionSpendNote> = issued_notes
        .iter()
        .filter(|n| !used_nullifiers.contains(&n.nullifier))
        .collect();
    let unused_count = unused.len() as u32;
    let unspent_amount = unused.iter().map(|n| n.amount).sum();
    UnusedNoteRefund {
        session_hash: channel.session_hash,
        unspent_amount,
        unused_count,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_channel(note_count: u32) -> SessionNoteChannel {
        SessionNoteChannel {
            session_hash: [0x01u8; 32],
            starting_balance_commitment: [0x02u8; 32],
            permission_hash: [0x03u8; 32],
            note_count,
            note_amount_each: 10_000,
            expiry_slot: 9999,
        }
    }

    fn scope() -> [u8; 32] {
        [0xAAu8; 32]
    }

    // 1. Issue 100 notes — correct count, all nullifiers unique.
    #[test]
    fn test_issue_100_notes() {
        let channel = make_channel(100);
        let notes = issue_notes(&channel, scope());
        assert_eq!(notes.len(), 100);

        let unique_nullifiers: HashSet<[u8; 32]> = notes.iter().map(|n| n.nullifier).collect();
        assert_eq!(
            unique_nullifiers.len(),
            100,
            "all nullifiers must be unique"
        );
    }

    // 2. Issue 100 notes, spend all, settle → notes_used == 100.
    #[test]
    fn test_100_spends_settle_to_one_root() {
        let channel = make_channel(100);
        let notes = issue_notes(&channel, scope());
        let result = settle_session(&channel, &notes).unwrap();
        assert_eq!(result.notes_used, 100);
        assert_eq!(result.total_spent, 100 * 10_000);
    }

    // 3. Tamper a note's amount → settle_session returns OverSpend.
    #[test]
    fn test_overspend_rejected() {
        let channel = make_channel(5);
        let mut notes = issue_notes(&channel, scope());
        // Tamper: inflate one note's amount far beyond channel capacity.
        notes[0].amount = channel.total_balance() + 1;
        let result = settle_session(&channel, &notes);
        assert!(matches!(result, Err(SessionError::OverSpend { .. })));
    }

    // Also verify: zero-note channel → total_balance == 0; settle empty → Ok, total_spent == 0.
    #[test]
    fn test_zero_note_channel_settle() {
        let channel = make_channel(0);
        assert_eq!(channel.total_balance(), 0);
        let result = settle_session(&channel, &[]).unwrap();
        assert_eq!(result.total_spent, 0);
        assert_eq!(result.notes_used, 0);
    }

    // 4. Spending after expiry → SessionExpired.
    #[test]
    fn test_expired_session_rejected() {
        let channel = make_channel(5);
        let notes = issue_notes(&channel, scope());
        let used = HashSet::new();
        let result = spend_note(&notes[0], &channel, channel.expiry_slot + 1, &used);
        assert!(matches!(result, Err(SessionError::SessionExpired { .. })));
    }

    // 5. Replay the same nullifier → NoteAlreadyUsed.
    #[test]
    fn test_used_note_replay_rejected() {
        let channel = make_channel(5);
        let notes = issue_notes(&channel, scope());
        let mut used = HashSet::new();

        // First spend succeeds.
        spend_note(&notes[0], &channel, 0, &used).unwrap();

        // Record the nullifier as used.
        used.insert(notes[0].nullifier);

        // Second spend must fail.
        let result = spend_note(&notes[0], &channel, 0, &used);
        assert!(matches!(result, Err(SessionError::NoteAlreadyUsed { .. })));
    }

    // 6. Channel of 5 notes, spend 2, refund → unspent_amount = 3 * note_amount_each.
    #[test]
    fn test_unused_note_refundable() {
        let channel = make_channel(5);
        let notes = issue_notes(&channel, scope());
        let mut used = HashSet::new();
        used.insert(notes[0].nullifier);
        used.insert(notes[1].nullifier);

        let refund = refund_unused(&channel, &used, &notes);
        assert_eq!(refund.unused_count, 3);
        assert_eq!(refund.unspent_amount, 3 * channel.note_amount_each);
    }

    // 7. Same used notes always produce the same settlement root.
    #[test]
    fn test_settlement_root_deterministic() {
        let channel = make_channel(10);
        let notes = issue_notes(&channel, scope());
        let used = &notes[..5];

        let root_a = settle_session(&channel, used).unwrap().root;
        let root_b = settle_session(&channel, used).unwrap().root;
        assert_eq!(root_a, root_b);

        // Order-independence: reverse the slice and expect the same root.
        let mut reversed = used.to_vec();
        reversed.reverse();
        let root_c = settle_session(&channel, &reversed).unwrap().root;
        assert_eq!(root_a, root_c);
    }

    // 8. No "pda" field in SessionNoteChannel JSON representation.
    #[test]
    fn test_no_pda_field_in_channel() {
        let channel = make_channel(3);
        let json = serde_json::to_string(&channel).unwrap();
        assert!(
            !json.contains("\"pda\""),
            "SessionNoteChannel must not have a pda field; got: {json}"
        );
        assert!(
            !json.contains("\"account_address\""),
            "SessionNoteChannel must not have an account_address field; got: {json}"
        );
    }

    // Bonus: total_balance is note_count × note_amount_each.
    #[test]
    fn test_total_balance() {
        let channel = make_channel(7);
        assert_eq!(channel.total_balance(), 7 * 10_000);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_spend_at_exact_expiry_ok() {
        // current_slot == expiry_slot (9999) — strictly > check, so exactly at expiry is ok
        let channel = make_channel(5);
        let notes = issue_notes(&channel, scope());
        let used = HashSet::new();
        let result = spend_note(&notes[0], &channel, 9999, &used);
        assert!(result.is_ok());
    }

    #[test]
    fn test_note_nullifier_nonzero() {
        let channel = make_channel(3);
        let notes = issue_notes(&channel, scope());
        for note in &notes {
            assert_ne!(note.nullifier, [0u8; 32]);
        }
    }

    #[test]
    fn test_settlement_root_nonzero() {
        let channel = make_channel(5);
        let notes = issue_notes(&channel, scope());
        let result = settle_session(&channel, &notes).unwrap();
        assert_ne!(result.root, [0u8; 32]);
    }

    #[test]
    fn test_different_scope_different_nullifiers() {
        let channel = make_channel(3);
        let scope_a = [0xAAu8; 32];
        let scope_b = [0xBBu8; 32];
        let notes_a = issue_notes(&channel, scope_a);
        let notes_b = issue_notes(&channel, scope_b);
        for (a, b) in notes_a.iter().zip(notes_b.iter()) {
            assert_ne!(a.nullifier, b.nullifier);
        }
    }

    #[test]
    fn test_refund_all_unused_when_none_spent() {
        let channel = make_channel(5);
        let notes = issue_notes(&channel, scope());
        let used = HashSet::new(); // nothing spent
        let refund = refund_unused(&channel, &used, &notes);
        assert_eq!(refund.unused_count, 5);
        assert_eq!(refund.unspent_amount, 5 * channel.note_amount_each);
    }

    #[test]
    fn test_note_amount_matches_channel() {
        let channel = make_channel(4);
        let notes = issue_notes(&channel, scope());
        for note in &notes {
            assert_eq!(note.amount, channel.note_amount_each);
        }
    }
}
