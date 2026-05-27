use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrivateNft {
    pub token_id: [u8; 32],
    pub owner_hash: [u8; 32],
    pub metadata_hash: [u8; 32],
    pub edition: u32,
    pub mainnet_ready: bool,
    /// Stored nonce (used for transfer derivation)
    #[serde(skip)]
    pub(crate) nonce: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NftTransfer {
    pub from_hash: [u8; 32],
    pub to_hash: [u8; 32],
    pub nullifier: [u8; 32],
    pub new_token_id: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum NftError {
    ZeroOwnerSecret,
    EmptyMetadata,
    AlreadyTransferred,
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
    d.extend_from_slice(b"nft-owner-v1");
    d.extend_from_slice(owner_secret);
    sha256(&d)
}

fn compute_metadata_hash(metadata_bytes: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"nft-meta-v1");
    d.extend_from_slice(metadata_bytes);
    sha256(&d)
}

fn compute_token_id(
    owner_hash: &[u8; 32],
    metadata_hash: &[u8; 32],
    edition: u32,
    nonce: &[u8; 32],
) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"nft-token-v1");
    d.extend_from_slice(owner_hash);
    d.extend_from_slice(metadata_hash);
    d.extend_from_slice(&edition.to_le_bytes());
    d.extend_from_slice(nonce);
    sha256(&d)
}

fn compute_nullifier(token_id: &[u8; 32], owner_hash: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"nft-null-v1");
    d.extend_from_slice(token_id);
    d.extend_from_slice(owner_hash);
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn mint_nft(
    owner_secret: &[u8; 32],
    metadata_bytes: &[u8],
    edition: u32,
    nonce: &[u8; 32],
) -> Result<PrivateNft, NftError> {
    if owner_secret == &[0u8; 32] {
        return Err(NftError::ZeroOwnerSecret);
    }
    if metadata_bytes.is_empty() {
        return Err(NftError::EmptyMetadata);
    }

    let owner_hash = compute_owner_hash(owner_secret);
    let metadata_hash = compute_metadata_hash(metadata_bytes);
    let token_id = compute_token_id(&owner_hash, &metadata_hash, edition, nonce);

    Ok(PrivateNft {
        token_id,
        owner_hash,
        metadata_hash,
        edition,
        mainnet_ready: false,
        nonce: *nonce,
    })
}

pub fn transfer_nft(
    nft: &mut PrivateNft,
    owner_secret: &[u8; 32],
    new_owner_secret: &[u8; 32],
) -> Result<NftTransfer, NftError> {
    // AlreadyTransferred is signaled by edition == u32::MAX
    if nft.edition == u32::MAX {
        return Err(NftError::AlreadyTransferred);
    }

    let from_hash = compute_owner_hash(owner_secret);
    // Verify ownership: computed owner_hash must match stored owner_hash
    if from_hash != nft.owner_hash {
        return Err(NftError::AlreadyTransferred);
    }

    let nullifier = compute_nullifier(&nft.token_id, &from_hash);

    // new_owner_hash and new_token_id
    let new_owner_hash = compute_owner_hash(new_owner_secret);
    let new_nonce = sha256(nft.nonce.as_slice()); // SHA256(old_nonce)
    let new_nonce_arr: [u8; 32] = new_nonce;
    let new_token_id = compute_token_id(
        &new_owner_hash,
        &nft.metadata_hash,
        nft.edition,
        &new_nonce_arr,
    );

    let transfer = NftTransfer {
        from_hash,
        to_hash: new_owner_hash,
        nullifier,
        new_token_id,
        mainnet_ready: false,
    };

    // Update nft to new owner state
    nft.owner_hash = new_owner_hash;
    nft.token_id = new_token_id;
    nft.nonce = new_nonce_arr;
    // Mark as transferred by setting edition to u32::MAX
    nft.edition = u32::MAX;

    Ok(transfer)
}

pub fn nft_public_record(nft: &PrivateNft) -> String {
    serde_json::json!({
        "token_id": hex(&nft.token_id),
        "metadata_hash": hex(&nft.metadata_hash),
        "edition": nft.edition,
        "mainnet_ready": nft.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn owner_secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x11;
        s
    }
    fn new_owner_secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x22;
        s
    }
    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0xab;
        n
    }
    const META: &[u8] = b"ipfs://bafyreib";

    // Test 1: mint + transfer
    #[test]
    fn test_mint_and_transfer() {
        let mut nft = mint_nft(&owner_secret(), META, 1, &nonce()).unwrap();
        assert!(!nft.mainnet_ready);
        let transfer = transfer_nft(&mut nft, &owner_secret(), &new_owner_secret()).unwrap();
        assert!(!transfer.mainnet_ready);
        // After transfer, nft owner_hash updated
        let expected_new_owner = {
            let mut d = Vec::new();
            d.extend_from_slice(b"nft-owner-v1");
            d.extend_from_slice(&new_owner_secret());
            sha256_raw(&d)
        };
        assert_eq!(nft.owner_hash, expected_new_owner);
        assert_eq!(transfer.to_hash, expected_new_owner);
    }

    fn sha256_raw(data: &[u8]) -> [u8; 32] {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(data);
        h.finalize().into()
    }

    // Test 2: zero owner → rejected
    #[test]
    fn test_zero_owner_rejected() {
        let err = mint_nft(&[0u8; 32], META, 1, &nonce()).unwrap_err();
        assert_eq!(err, NftError::ZeroOwnerSecret);
    }

    // Test 3: empty metadata → rejected
    #[test]
    fn test_empty_metadata_rejected() {
        let err = mint_nft(&owner_secret(), b"", 1, &nonce()).unwrap_err();
        assert_eq!(err, NftError::EmptyMetadata);
    }

    // Test 4: public record hides owner_hash
    #[test]
    fn test_public_record_hides_owner() {
        let nft = mint_nft(&owner_secret(), META, 1, &nonce()).unwrap();
        let record = nft_public_record(&nft);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["token_id"].is_string());
        assert!(v["metadata_hash"].is_string());
        assert_eq!(v["edition"], 1u32);
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("owner_hash").is_none());
    }

    // Test 5: different owners, same metadata → different token_id
    #[test]
    fn test_different_owners_different_token_id() {
        let nft1 = mint_nft(&owner_secret(), META, 1, &nonce()).unwrap();
        let nft2 = mint_nft(&new_owner_secret(), META, 1, &nonce()).unwrap();
        assert_ne!(nft1.token_id, nft2.token_id);
        // metadata_hash should be same
        assert_eq!(nft1.metadata_hash, nft2.metadata_hash);
    }

    // Test 6: transfer nullifier is deterministic
    #[test]
    fn test_transfer_nullifier_deterministic() {
        let mut nft1 = mint_nft(&owner_secret(), META, 1, &nonce()).unwrap();
        let mut nft2 = mint_nft(&owner_secret(), META, 1, &nonce()).unwrap();

        let t1 = transfer_nft(&mut nft1, &owner_secret(), &new_owner_secret()).unwrap();
        let t2 = transfer_nft(&mut nft2, &owner_secret(), &new_owner_secret()).unwrap();

        assert_eq!(t1.nullifier, t2.nullifier);
        assert_eq!(t1.new_token_id, t2.new_token_id);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_token_id_nonzero() {
        let nft = mint_nft(&owner_secret(), META, 1, &nonce()).unwrap();
        assert_ne!(nft.token_id, [0u8; 32]);
    }

    #[test]
    fn test_owner_hash_nonzero() {
        let nft = mint_nft(&owner_secret(), META, 1, &nonce()).unwrap();
        assert_ne!(nft.owner_hash, [0u8; 32]);
    }

    #[test]
    fn test_metadata_hash_nonzero() {
        let nft = mint_nft(&owner_secret(), META, 1, &nonce()).unwrap();
        assert_ne!(nft.metadata_hash, [0u8; 32]);
    }

    #[test]
    fn test_edition_stored() {
        let nft = mint_nft(&owner_secret(), META, 7, &nonce()).unwrap();
        assert_eq!(nft.edition, 7);
    }

    #[test]
    fn test_nft_mainnet_ready_false() {
        let nft = mint_nft(&owner_secret(), META, 1, &nonce()).unwrap();
        assert!(!nft.mainnet_ready);
    }

    #[test]
    fn test_transfer_mainnet_ready_false() {
        let mut nft = mint_nft(&owner_secret(), META, 1, &nonce()).unwrap();
        let t = transfer_nft(&mut nft, &owner_secret(), &new_owner_secret()).unwrap();
        assert!(!t.mainnet_ready);
    }

    #[test]
    fn test_nullifier_nonzero() {
        let mut nft = mint_nft(&owner_secret(), META, 1, &nonce()).unwrap();
        let t = transfer_nft(&mut nft, &owner_secret(), &new_owner_secret()).unwrap();
        assert_ne!(t.nullifier, [0u8; 32]);
    }

    #[test]
    fn test_new_token_id_nonzero() {
        let mut nft = mint_nft(&owner_secret(), META, 1, &nonce()).unwrap();
        let t = transfer_nft(&mut nft, &owner_secret(), &new_owner_secret()).unwrap();
        assert_ne!(t.new_token_id, [0u8; 32]);
    }

    #[test]
    fn test_token_id_nonce_sensitive() {
        let mut n2 = [0u8; 32];
        n2[0] = 0xff;
        let nft1 = mint_nft(&owner_secret(), META, 1, &nonce()).unwrap();
        let nft2 = mint_nft(&owner_secret(), META, 1, &n2).unwrap();
        assert_ne!(nft1.token_id, nft2.token_id);
    }

    #[test]
    fn test_metadata_hash_deterministic() {
        let nft1 = mint_nft(&owner_secret(), META, 1, &nonce()).unwrap();
        let nft2 = mint_nft(&new_owner_secret(), META, 1, &nonce()).unwrap();
        assert_eq!(nft1.metadata_hash, nft2.metadata_hash);
    }
}
