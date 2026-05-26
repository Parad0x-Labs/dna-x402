// dark-note-ledger — client-side note ledger for the shielded pool
// Tracks the user's note portfolio: unspent commitments, spent nullifiers,
// and balance estimation.  Complements dark-shielded-pool-core.
//
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use dark_shielded_pool_core::{Note, PoolError};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A single entry in the ledger, representing one shielded note.
#[derive(Debug, Clone)]
pub struct LedgerEntry {
    pub note_commitment: [u8; 32],
    pub value: u64,
    pub spent: bool,
    pub nullifier: Option<[u8; 32]>,
}

/// The client-side note portfolio.
pub struct NoteLedger {
    pub entries: Vec<LedgerEntry>,
    pub total_unspent: u64,
    /// Always false — ledger is for devnet/testnet only.
    pub mainnet_ready: bool,
}

/// Errors that can occur while operating the ledger.
#[derive(Debug, PartialEq)]
pub enum LedgerError {
    /// Attempted to track a note whose commitment is already in the ledger.
    NoteAlreadyTracked,
    /// Commitment not found, or note already spent (double-spend guard).
    NoteNotFound,
    /// Propagated from the underlying pool primitive.
    PoolError(PoolError),
}

impl From<PoolError> for LedgerError {
    fn from(e: PoolError) -> Self {
        LedgerError::PoolError(e)
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a new, empty `NoteLedger`.  `mainnet_ready` is always `false`.
pub fn new_ledger() -> NoteLedger {
    NoteLedger {
        entries: Vec::new(),
        total_unspent: 0,
        mainnet_ready: false,
    }
}

/// Begin tracking a note.
///
/// Returns `NoteAlreadyTracked` if the note's commitment is already present.
/// On success, appends a new unspent entry and increments `total_unspent`.
pub fn track_note(ledger: &mut NoteLedger, note: &Note) -> Result<(), LedgerError> {
    if ledger
        .entries
        .iter()
        .any(|e| e.note_commitment == note.commitment)
    {
        return Err(LedgerError::NoteAlreadyTracked);
    }

    ledger.entries.push(LedgerEntry {
        note_commitment: note.commitment,
        value: note.value,
        spent: false,
        nullifier: None,
    });
    ledger.total_unspent = ledger.total_unspent.saturating_add(note.value);
    Ok(())
}

/// Mark a tracked note as spent.
///
/// Returns `NoteNotFound` if the commitment does not exist or the note has
/// already been marked spent (double-spend guard).
/// On success, sets `spent = true`, stores the nullifier, and decrements
/// `total_unspent`.
pub fn mark_spent(
    ledger: &mut NoteLedger,
    commitment: &[u8; 32],
    nullifier: [u8; 32],
) -> Result<(), LedgerError> {
    let entry = ledger
        .entries
        .iter_mut()
        .find(|e| &e.note_commitment == commitment)
        .ok_or(LedgerError::NoteNotFound)?;

    if entry.spent {
        // Double-spend guard: treat an already-spent note as "not found".
        return Err(LedgerError::NoteNotFound);
    }

    entry.spent = true;
    entry.nullifier = Some(nullifier);
    ledger.total_unspent = ledger.total_unspent.saturating_sub(entry.value);
    Ok(())
}

/// Return references to all entries that have not yet been spent.
pub fn unspent_notes(ledger: &NoteLedger) -> Vec<&LedgerEntry> {
    ledger.entries.iter().filter(|e| !e.spent).collect()
}

/// Serialize a high-level summary of the ledger to JSON.
///
/// Raw note values and nullifiers are NEVER included in the output.
pub fn ledger_summary_json(ledger: &NoteLedger) -> String {
    let unspent_count = ledger.entries.iter().filter(|e| !e.spent).count();

    serde_json::json!({
        "entry_count": ledger.entries.len(),
        "unspent_count": unspent_count,
        "total_unspent": ledger.total_unspent,
        "mainnet_ready": ledger.mainnet_ready,
    })
    .to_string()
}

/// Return the set of nullifiers for all spent entries.
///
/// Unspent entries (whose `nullifier` field is `None`) are excluded.
pub fn portfolio_nullifier_set(ledger: &NoteLedger) -> Vec<[u8; 32]> {
    ledger.entries.iter().filter_map(|e| e.nullifier).collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use dark_shielded_pool_core::create_note;

    fn make_note(value: u64, seed: u8) -> Note {
        let randomness = [seed; 32];
        let recipient = [seed.wrapping_add(1); 32];
        create_note(value, &randomness, &recipient, 0)
    }

    fn dummy_nullifier(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    // 1. Track a note, mark it spent; total_unspent reaches zero.
    #[test]
    fn test_track_and_spend_note() {
        let mut ledger = new_ledger();
        let note = make_note(1_000_000, 0x01);

        track_note(&mut ledger, &note).expect("track should succeed");
        assert_eq!(ledger.total_unspent, 1_000_000);

        mark_spent(&mut ledger, &note.commitment, dummy_nullifier(0xAA))
            .expect("mark_spent should succeed");
        assert_eq!(
            ledger.total_unspent, 0,
            "total_unspent must be zero after spending sole note"
        );

        assert!(!ledger.mainnet_ready, "mainnet_ready must remain false");
    }

    // 2. Tracking the same commitment twice → NoteAlreadyTracked.
    #[test]
    fn test_double_track_rejected() {
        let mut ledger = new_ledger();
        let note = make_note(500_000, 0x02);

        track_note(&mut ledger, &note).unwrap();
        let result = track_note(&mut ledger, &note);
        assert_eq!(result, Err(LedgerError::NoteAlreadyTracked));
    }

    // 3. Track 3 notes, spend 1; unspent_count = 2.
    #[test]
    fn test_unspent_count_correct() {
        let mut ledger = new_ledger();

        let note_a = make_note(100_000, 0xA0);
        let note_b = make_note(200_000, 0xB0);
        let note_c = make_note(300_000, 0xC0);

        track_note(&mut ledger, &note_a).unwrap();
        track_note(&mut ledger, &note_b).unwrap();
        track_note(&mut ledger, &note_c).unwrap();

        mark_spent(&mut ledger, &note_b.commitment, dummy_nullifier(0x01)).unwrap();

        let unspent = unspent_notes(&ledger);
        assert_eq!(unspent.len(), 2, "two of three notes should remain unspent");
        assert_eq!(
            ledger.total_unspent, 400_000,
            "total_unspent should reflect the two remaining notes"
        );
    }

    // 4. ledger_summary_json must not contain any of the individual raw note values
    //    as their exact decimal strings.
    #[test]
    fn test_ledger_summary_hides_values() {
        let mut ledger = new_ledger();

        // Use values that are unlikely to appear coincidentally in a JSON
        // summary (e.g. as counts or metadata).
        let unique_value_a: u64 = 9_876_543_210;
        let unique_value_b: u64 = 1_234_567_890;

        let note_a = make_note(unique_value_a, 0xD0);
        let note_b = make_note(unique_value_b, 0xD1);

        track_note(&mut ledger, &note_a).unwrap();
        track_note(&mut ledger, &note_b).unwrap();

        let json = ledger_summary_json(&ledger);

        // The summary only exposes total_unspent, entry_count, unspent_count, and
        // mainnet_ready.  The individual per-note values must not be leaked.
        assert!(
            !json.contains(&unique_value_a.to_string()),
            "JSON must not contain the raw decimal value of note_a"
        );
        assert!(
            !json.contains(&unique_value_b.to_string()),
            "JSON must not contain the raw decimal value of note_b"
        );
    }

    // 5. portfolio_nullifier_set only returns nullifiers from spent entries.
    #[test]
    fn test_nullifier_set_excludes_unspent() {
        let mut ledger = new_ledger();

        let note_a = make_note(111_000, 0xE0);
        let note_b = make_note(222_000, 0xE1);

        track_note(&mut ledger, &note_a).unwrap();
        track_note(&mut ledger, &note_b).unwrap();

        let nullifier_a = dummy_nullifier(0xFA);
        mark_spent(&mut ledger, &note_a.commitment, nullifier_a).unwrap();

        let set = portfolio_nullifier_set(&ledger);
        assert_eq!(set.len(), 1, "only one nullifier expected (one spent note)");
        assert_eq!(
            set[0], nullifier_a,
            "returned nullifier must match the one stored"
        );

        // note_b is unspent — its nullifier is None and must not appear.
        assert!(
            !set.contains(&dummy_nullifier(0x00)),
            "unspent note must not contribute a nullifier"
        );
    }
}
