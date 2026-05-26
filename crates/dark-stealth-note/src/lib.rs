use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StealthNote {
    pub note_id: [u8; 32],
    pub stealth_addr: [u8; 32],
    pub encrypted_amount: [u8; 32],
    pub sender_ephem_pubkey: [u8; 32],
    pub scope_hash: [u8; 32],
    /// Stored so the scanner can recompute stealth_addr without spend_secret.
    pub receiver_spend_pubkey: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSpend {
    pub nullifier: [u8; 32],
    pub note_id: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoteError {
    ZeroSecret,
    ZeroEphemeral,
    EmptyScope,
    AlreadySpent,
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fn h(tag: &[u8], a: &[u8]) -> [u8; 32] {
    let mut d = Sha256::new();
    d.update(tag);
    d.update(a);
    d.finalize().into()
}

fn h2(tag: &[u8], a: &[u8], b: &[u8]) -> [u8; 32] {
    let mut d = Sha256::new();
    d.update(tag);
    d.update(a);
    d.update(b);
    d.finalize().into()
}

fn h3(tag: &[u8], a: &[u8], b: &[u8], c: &[u8]) -> [u8; 32] {
    let mut d = Sha256::new();
    d.update(tag);
    d.update(a);
    d.update(b);
    d.update(c);
    d.finalize().into()
}

fn is_zero(b: &[u8; 32]) -> bool {
    b == &[0u8; 32]
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Create a `StealthNote` combining stealth-address derivation with encrypted amount.
pub fn create_note(
    scan_secret: &[u8; 32],
    spend_secret: &[u8; 32],
    ephem_secret: &[u8; 32],
    scope_bytes: &[u8],
    amount: u64,
) -> Result<StealthNote, NoteError> {
    if is_zero(scan_secret) {
        return Err(NoteError::ZeroSecret);
    }
    if is_zero(ephem_secret) {
        return Err(NoteError::ZeroEphemeral);
    }
    if scope_bytes.is_empty() {
        return Err(NoteError::EmptyScope);
    }

    // Derive public keys
    let scan_pubkey  = h(b"sn-scan-pubkey-v1",  scan_secret);
    let spend_pubkey = h(b"sn-spend-pubkey-v1", spend_secret);
    let ephem_pubkey = h(b"sn-ephem-pubkey-v1", ephem_secret);

    // Shared secret & stealth address
    let shared_secret = h2(b"sn-shared-v1", &ephem_pubkey, &scan_pubkey);
    let stealth_addr  = h2(b"sn-addr-v1",   &shared_secret, &spend_pubkey);

    // Scope
    let scope_hash = h(b"sn-scope-v1", scope_bytes);

    // Encrypt amount: enc_key XOR amount_buf (u64 LE, zero-padded to 32 bytes)
    let enc_key = h(b"sn-enc-key-v1", &shared_secret);
    let mut amount_buf = [0u8; 32];
    amount_buf[..8].copy_from_slice(&amount.to_le_bytes());
    let mut encrypted_amount = [0u8; 32];
    for i in 0..32 {
        encrypted_amount[i] = enc_key[i] ^ amount_buf[i];
    }

    // Note ID
    let note_id = h3(b"sn-note-v1", &stealth_addr, &scope_hash, &encrypted_amount);

    Ok(StealthNote {
        note_id,
        stealth_addr,
        encrypted_amount,
        sender_ephem_pubkey: ephem_pubkey,
        scope_hash,
        receiver_spend_pubkey: spend_pubkey,
        mainnet_ready: false,
    })
}

/// Return `true` if the note belongs to the owner of `scan_secret`.
///
/// Recomputes `shared_secret` from `ephem_pubkey` and `scan_secret`, then
/// recomputes `stealth_addr` using the note's stored `receiver_spend_pubkey`.
pub fn scan_note(note: &StealthNote, scan_secret: &[u8; 32], ephem_pubkey: &[u8; 32]) -> bool {
    let scan_pubkey   = h(b"sn-scan-pubkey-v1", scan_secret);
    let shared_secret = h2(b"sn-shared-v1", ephem_pubkey, &scan_pubkey);
    let stealth_addr  = h2(b"sn-addr-v1",   &shared_secret, &note.receiver_spend_pubkey);
    stealth_addr == note.stealth_addr
}

/// Produce a `NoteSpend` (nullifier) for the given note.
pub fn spend_note(note: &StealthNote, spend_secret: &[u8; 32]) -> Result<NoteSpend, NoteError> {
    let spend_secret_hash = h(b"sn-spend-secret-v1", spend_secret);
    let nullifier = h2(b"sn-null-v1", &note.note_id, &spend_secret_hash);

    Ok(NoteSpend {
        nullifier,
        note_id: note.note_id,
        mainnet_ready: false,
    })
}

/// Return a JSON public record containing only `note_id`, `stealth_addr`,
/// `scope_hash`, and `mainnet_ready`.  Does NOT expose `encrypted_amount`
/// or `sender_ephem_pubkey`.
pub fn note_public_record(note: &StealthNote) -> String {
    serde_json::json!({
        "note_id":      hex_encode(&note.note_id),
        "stealth_addr": hex_encode(&note.stealth_addr),
        "scope_hash":   hex_encode(&note.scope_hash),
        "mainnet_ready": note.mainnet_ready,
    })
    .to_string()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn scan_secret() -> [u8; 32] {
        let mut b = [0u8; 32]; b[0] = 1; b
    }
    fn spend_secret() -> [u8; 32] {
        let mut b = [0u8; 32]; b[0] = 2; b
    }
    fn ephem_secret() -> [u8; 32] {
        let mut b = [0u8; 32]; b[0] = 3; b
    }
    fn scope() -> &'static [u8] { b"dark-x402-mainnet" }

    #[test]
    fn test_create_scan_spend_roundtrip() {
        let note = create_note(&scan_secret(), &spend_secret(), &ephem_secret(), scope(), 1_000_000)
            .expect("create_note failed");

        assert!(!note.mainnet_ready, "mainnet_ready must be false");

        let scanned = scan_note(&note, &scan_secret(), &note.sender_ephem_pubkey);
        assert!(scanned, "scan_note should return true for correct scan_secret");

        let spend = spend_note(&note, &spend_secret()).expect("spend_note failed");
        assert!(!spend.mainnet_ready, "mainnet_ready must be false");
        assert_eq!(spend.note_id, note.note_id);
        assert_ne!(spend.nullifier, [0u8; 32], "nullifier must not be zero");
    }

    #[test]
    fn test_scan_wrong_secret_fails() {
        let note = create_note(&scan_secret(), &spend_secret(), &ephem_secret(), scope(), 42)
            .expect("create_note failed");

        let mut wrong = scan_secret();
        wrong[31] ^= 0xff;

        let scanned = scan_note(&note, &wrong, &note.sender_ephem_pubkey);
        assert!(!scanned, "scan_note must return false for wrong scan_secret");
    }

    #[test]
    fn test_different_scopes_different_note_ids() {
        let note_a = create_note(&scan_secret(), &spend_secret(), &ephem_secret(), b"scope-a", 100)
            .expect("note a");
        let note_b = create_note(&scan_secret(), &spend_secret(), &ephem_secret(), b"scope-b", 100)
            .expect("note b");

        assert_ne!(note_a.note_id, note_b.note_id,
            "different scopes must produce different note_ids");
    }

    #[test]
    fn test_zero_scan_secret_rejected() {
        let err = create_note(&[0u8; 32], &spend_secret(), &ephem_secret(), scope(), 0)
            .expect_err("should reject zero scan_secret");
        assert_eq!(err, NoteError::ZeroSecret);
    }

    #[test]
    fn test_empty_scope_rejected() {
        let err = create_note(&scan_secret(), &spend_secret(), &ephem_secret(), b"", 0)
            .expect_err("should reject empty scope");
        assert_eq!(err, NoteError::EmptyScope);
    }

    #[test]
    fn test_public_record_hides_encrypted_amount() {
        let note = create_note(&scan_secret(), &spend_secret(), &ephem_secret(), scope(), 9999)
            .expect("create_note failed");

        let json = note_public_record(&note);
        let enc_amt_hex = hex_encode(&note.encrypted_amount);

        assert!(
            !json.contains(&enc_amt_hex),
            "public record must not contain encrypted_amount hex; got: {json}"
        );
    }
}
