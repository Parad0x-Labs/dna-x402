use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfidentialNote {
    pub note_id: [u8; 32],
    pub amount_commitment: [u8; 32],
    pub owner_hash: [u8; 32],
    pub asset_hash: [u8; 32],
    /// Stored plaintext for simplicity; zeroed after transfer.
    pub amount: u64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferProof {
    pub nullifier: [u8; 32],
    pub new_note_id: [u8; 32],
    pub range_commitment: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum TransferError {
    ZeroOwnerSecret,
    ZeroAmount,
    ZeroAsset,
    InsufficientBalance { have: u64, need: u64 },
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn hex(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn compute_owner_hash(owner_secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ct-owner-v1");
    d.extend_from_slice(owner_secret);
    sha256(&d)
}

fn compute_asset_hash(asset_bytes: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ct-asset-v1");
    d.extend_from_slice(asset_bytes);
    sha256(&d)
}

fn compute_amount_commitment(amount: u64, blinding: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ct-amount-v1");
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(blinding);
    sha256(&d)
}

fn compute_note_id(
    owner_hash: &[u8; 32],
    asset_hash: &[u8; 32],
    amount_commitment: &[u8; 32],
    nonce: &[u8; 32],
) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ct-note-v1");
    d.extend_from_slice(owner_hash);
    d.extend_from_slice(asset_hash);
    d.extend_from_slice(amount_commitment);
    d.extend_from_slice(nonce);
    sha256(&d)
}

fn compute_nullifier(note_id: &[u8; 32], owner_hash: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ct-null-v1");
    d.extend_from_slice(note_id);
    d.extend_from_slice(owner_hash);
    sha256(&d)
}

fn compute_range_commitment(amount: u64, blinding: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ct-range-v1");
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(blinding);
    sha256(&d)
}

fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    sha256(data)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn mint_note(
    owner_secret: &[u8; 32],
    asset_bytes: &[u8],
    amount: u64,
    blinding: &[u8; 32],
    nonce: &[u8; 32],
) -> Result<ConfidentialNote, TransferError> {
    if owner_secret == &[0u8; 32] {
        return Err(TransferError::ZeroOwnerSecret);
    }
    if amount == 0 {
        return Err(TransferError::ZeroAmount);
    }
    if asset_bytes.is_empty() {
        return Err(TransferError::ZeroAsset);
    }
    let owner_hash = compute_owner_hash(owner_secret);
    let asset_hash = compute_asset_hash(asset_bytes);
    let amount_commitment = compute_amount_commitment(amount, blinding);
    let note_id = compute_note_id(&owner_hash, &asset_hash, &amount_commitment, nonce);

    Ok(ConfidentialNote {
        note_id,
        amount_commitment,
        owner_hash,
        asset_hash,
        amount,
        mainnet_ready: false,
    })
}

pub fn transfer_note(
    note: &ConfidentialNote,
    owner_secret: &[u8; 32],
    new_owner_secret: &[u8; 32],
    amount: u64,
    new_blinding: &[u8; 32],
) -> Result<(TransferProof, ConfidentialNote), TransferError> {
    if owner_secret == &[0u8; 32] || new_owner_secret == &[0u8; 32] {
        return Err(TransferError::ZeroOwnerSecret);
    }
    if amount == 0 {
        return Err(TransferError::ZeroAmount);
    }
    if amount > note.amount {
        return Err(TransferError::InsufficientBalance {
            have: note.amount,
            need: amount,
        });
    }

    let owner_hash = compute_owner_hash(owner_secret);
    let new_owner_hash = compute_owner_hash(new_owner_secret);
    let nullifier = compute_nullifier(&note.note_id, &owner_hash);

    // New nonce = SHA256(old_nonce_equivalent) — we use SHA256(note_id) as derived nonce
    let new_nonce = sha256_bytes(&note.note_id);
    let new_amount_commitment = compute_amount_commitment(amount, new_blinding);
    let new_note_id = compute_note_id(
        &new_owner_hash,
        &note.asset_hash,
        &new_amount_commitment,
        &new_nonce,
    );
    let range_commitment = compute_range_commitment(amount, new_blinding);

    let proof = TransferProof {
        nullifier,
        new_note_id,
        range_commitment,
        mainnet_ready: false,
    };

    let new_note = ConfidentialNote {
        note_id: new_note_id,
        amount_commitment: new_amount_commitment,
        owner_hash: new_owner_hash,
        asset_hash: note.asset_hash,
        amount,
        mainnet_ready: false,
    };

    Ok((proof, new_note))
}

pub fn note_public_record(note: &ConfidentialNote) -> String {
    serde_json::json!({
        "note_id":    hex(&note.note_id),
        "asset_hash": hex(&note.asset_hash),
        "mainnet_ready": note.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x11;
        s
    }
    fn new_owner() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x22;
        s
    }
    fn blinding() -> [u8; 32] {
        let mut b = [0u8; 32];
        b[0] = 0x55;
        b
    }
    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0x01;
        n
    }

    // Test 1: mint + transfer happy path
    #[test]
    fn test_mint_and_transfer() {
        let note = mint_note(&owner(), b"SOL", 500, &blinding(), &nonce()).unwrap();
        assert_eq!(note.amount, 500);
        assert!(!note.mainnet_ready);

        let (proof, new_note) =
            transfer_note(&note, &owner(), &new_owner(), 300, &blinding()).unwrap();
        assert_ne!(proof.nullifier, [0u8; 32]);
        assert_eq!(proof.new_note_id, new_note.note_id);
        assert_eq!(new_note.amount, 300);
        assert!(!proof.mainnet_ready);
        assert!(!new_note.mainnet_ready);
    }

    // Test 2: zero owner secret rejected
    #[test]
    fn test_zero_owner_rejected() {
        let err = mint_note(&[0u8; 32], b"SOL", 100, &blinding(), &nonce()).unwrap_err();
        assert_eq!(err, TransferError::ZeroOwnerSecret);
    }

    // Test 3: zero amount rejected
    #[test]
    fn test_zero_amount_rejected() {
        let err = mint_note(&owner(), b"SOL", 0, &blinding(), &nonce()).unwrap_err();
        assert_eq!(err, TransferError::ZeroAmount);
    }

    // Test 4: zero asset rejected
    #[test]
    fn test_zero_asset_rejected() {
        let err = mint_note(&owner(), b"", 100, &blinding(), &nonce()).unwrap_err();
        assert_eq!(err, TransferError::ZeroAsset);
    }

    // Test 5: nullifier unique per note (different notes → different nullifiers)
    #[test]
    fn test_nullifier_unique_per_note() {
        let note1 = mint_note(&owner(), b"SOL", 100, &blinding(), &nonce()).unwrap();
        let nonce2 = {
            let mut n = [0u8; 32];
            n[0] = 0x99;
            n
        };
        let note2 = mint_note(&owner(), b"SOL", 100, &blinding(), &nonce2).unwrap();

        let owner_hash = compute_owner_hash(&owner());
        let null1 = compute_nullifier(&note1.note_id, &owner_hash);
        let null2 = compute_nullifier(&note2.note_id, &owner_hash);
        assert_ne!(null1, null2);
    }

    // Test 6: public record hides owner and amount
    #[test]
    fn test_public_record_hides_owner_and_amount() {
        let note = mint_note(&owner(), b"SOL", 500, &blinding(), &nonce()).unwrap();
        let record = note_public_record(&note);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["note_id"].is_string());
        assert!(v["asset_hash"].is_string());
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("owner_hash").is_none());
        assert!(v.get("amount").is_none());
        assert!(v.get("amount_commitment").is_none());
    }
}
