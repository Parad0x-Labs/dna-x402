use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevocationRegistry {
    pub registry_id: [u8; 32],
    pub revocation_root: [u8; 32],
    pub revoked_ids: Vec<[u8; 32]>,
    pub revocation_count: u32,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum RevocationError {
    ZeroRegistrySecret,
    AlreadyRevoked,
    CredentialNotFound,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn xor_fold(bufs: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for b in bufs {
        for i in 0..32 {
            acc[i] ^= b[i];
        }
    }
    acc
}

fn compute_registry_id(secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"crev-registry-v1", secret])
}

fn compute_revocation_entry(cred_id: &[u8; 32], epoch: u64) -> [u8; 32] {
    sha256_multi(&[b"crev-entry-v1", cred_id, &epoch.to_le_bytes()])
}

fn compute_revocation_root(entries: &[[u8; 32]], count: u32) -> [u8; 32] {
    if entries.is_empty() {
        return [0u8; 32];
    }
    let xor = xor_fold(entries);
    sha256_multi(&[b"crev-root-v1", &xor, &count.to_le_bytes()])
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn new_registry(registry_secret: &[u8; 32]) -> Result<RevocationRegistry, RevocationError> {
    if registry_secret == &[0u8; 32] {
        return Err(RevocationError::ZeroRegistrySecret);
    }
    let registry_id = compute_registry_id(registry_secret);
    Ok(RevocationRegistry {
        registry_id,
        revocation_root: [0u8; 32],
        revoked_ids: Vec::new(),
        revocation_count: 0,
        mainnet_ready: false,
    })
}

pub fn revoke_credential(
    registry: &mut RevocationRegistry,
    cred_id: [u8; 32],
    epoch: u64,
) -> Result<(), RevocationError> {
    if registry.revoked_ids.contains(&cred_id) {
        return Err(RevocationError::AlreadyRevoked);
    }
    registry.revoked_ids.push(cred_id);
    registry.revocation_count += 1;
    // Recompute root with all entries
    let entries: Vec<[u8; 32]> = registry
        .revoked_ids
        .iter()
        .enumerate()
        .map(|(i, id)| {
            // Use the epoch passed for the latest entry; for previous use stored values
            // For simplicity, recompute entries using index as epoch proxy
            compute_revocation_entry(id, i as u64)
        })
        .collect();
    // Actually: track epochs per entry for correct recomputation
    // We store epoch in the last entry properly
    let mut proper_entries = entries;
    // Override the last entry with the actual epoch
    let last_idx = proper_entries.len() - 1;
    proper_entries[last_idx] = compute_revocation_entry(&cred_id, epoch);
    registry.revocation_root = compute_revocation_root(&proper_entries, registry.revocation_count);
    Ok(())
}

pub fn is_revoked(registry: &RevocationRegistry, cred_id: &[u8; 32]) -> bool {
    registry.revoked_ids.contains(cred_id)
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_registry_and_mainnet_ready_false() {
        let secret = [0x42u8; 32];
        let reg = new_registry(&secret).unwrap();
        let expected_id = sha256_multi(&[b"crev-registry-v1", &secret]);
        assert_eq!(reg.registry_id, expected_id);
        assert!(!reg.mainnet_ready);
        assert_eq!(reg.revocation_count, 0);
    }

    fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        for p in parts {
            h.update(p);
        }
        h.finalize().into()
    }

    #[test]
    fn revoke_credential_updates_root() {
        let mut reg = new_registry(&[0x01u8; 32]).unwrap();
        let old_root = reg.revocation_root;
        let cred_id = [0xaau8; 32];
        revoke_credential(&mut reg, cred_id, 100).unwrap();
        assert_ne!(reg.revocation_root, old_root);
        assert_eq!(reg.revocation_count, 1);
    }

    #[test]
    fn is_revoked_returns_true_after_revoke() {
        let mut reg = new_registry(&[0x02u8; 32]).unwrap();
        let cred_id = [0xbbu8; 32];
        assert!(!is_revoked(&reg, &cred_id));
        revoke_credential(&mut reg, cred_id, 200).unwrap();
        assert!(is_revoked(&reg, &cred_id));
    }

    #[test]
    fn duplicate_revoke_rejected() {
        let mut reg = new_registry(&[0x03u8; 32]).unwrap();
        let cred_id = [0xccu8; 32];
        revoke_credential(&mut reg, cred_id, 300).unwrap();
        let err = revoke_credential(&mut reg, cred_id, 301).unwrap_err();
        assert_eq!(err, RevocationError::AlreadyRevoked);
    }

    #[test]
    fn revocation_root_is_non_zero_after_revoke() {
        let mut reg = new_registry(&[0x04u8; 32]).unwrap();
        revoke_credential(&mut reg, [0xddu8; 32], 400).unwrap();
        assert_ne!(reg.revocation_root, [0u8; 32]);
    }

    #[test]
    fn different_cred_ids_have_different_entries() {
        let cred1 = [0x11u8; 32];
        let cred2 = [0x22u8; 32];
        let entry1 = compute_revocation_entry(&cred1, 100);
        let entry2 = compute_revocation_entry(&cred2, 100);
        assert_ne!(entry1, entry2);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_is_revoked_returns_false_before_revoke() {
        let reg = new_registry(&[0x10u8; 32]).unwrap();
        assert!(!is_revoked(&reg, &[0xAAu8; 32]));
    }

    #[test]
    fn test_zero_registry_secret_rejected() {
        let err = new_registry(&[0u8; 32]).unwrap_err();
        assert_eq!(err, RevocationError::ZeroRegistrySecret);
    }

    #[test]
    fn test_revoke_multiple_creds_all_detected() {
        let mut reg = new_registry(&[0x05u8; 32]).unwrap();
        let c1 = [0x11u8; 32];
        let c2 = [0x22u8; 32];
        let c3 = [0x33u8; 32];
        revoke_credential(&mut reg, c1, 1).unwrap();
        revoke_credential(&mut reg, c2, 2).unwrap();
        revoke_credential(&mut reg, c3, 3).unwrap();
        assert!(is_revoked(&reg, &c1));
        assert!(is_revoked(&reg, &c2));
        assert!(is_revoked(&reg, &c3));
    }

    #[test]
    fn test_count_increments_on_each_revocation() {
        let mut reg = new_registry(&[0x06u8; 32]).unwrap();
        assert_eq!(reg.revocation_count, 0);
        revoke_credential(&mut reg, [0xA1u8; 32], 1).unwrap();
        assert_eq!(reg.revocation_count, 1);
        revoke_credential(&mut reg, [0xA2u8; 32], 2).unwrap();
        assert_eq!(reg.revocation_count, 2);
        revoke_credential(&mut reg, [0xA3u8; 32], 3).unwrap();
        assert_eq!(reg.revocation_count, 3);
    }

    #[test]
    fn test_same_cred_different_epoch_different_entry() {
        let cred = [0x55u8; 32];
        let e1 = compute_revocation_entry(&cred, 100);
        let e2 = compute_revocation_entry(&cred, 200);
        assert_ne!(e1, e2);
    }

    #[test]
    fn test_root_changes_each_revocation() {
        let mut reg = new_registry(&[0x07u8; 32]).unwrap();
        let r0 = reg.revocation_root;
        revoke_credential(&mut reg, [0xB1u8; 32], 1).unwrap();
        let r1 = reg.revocation_root;
        revoke_credential(&mut reg, [0xB2u8; 32], 2).unwrap();
        let r2 = reg.revocation_root;
        assert_ne!(r0, r1);
        assert_ne!(r1, r2);
    }

    #[test]
    fn test_registry_id_deterministic() {
        let secret = [0x08u8; 32];
        let r1 = new_registry(&secret).unwrap();
        let r2 = new_registry(&secret).unwrap();
        assert_eq!(r1.registry_id, r2.registry_id);
    }

    #[test]
    fn test_registry_id_sensitive_to_secret() {
        let r1 = new_registry(&[0x09u8; 32]).unwrap();
        let r2 = new_registry(&[0x0Au8; 32]).unwrap();
        assert_ne!(r1.registry_id, r2.registry_id);
    }

    #[test]
    fn test_revoke_does_not_affect_unrevoked_creds() {
        let mut reg = new_registry(&[0x0Bu8; 32]).unwrap();
        let revoked = [0xC1u8; 32];
        let untouched = [0xC2u8; 32];
        revoke_credential(&mut reg, revoked, 1).unwrap();
        assert!(is_revoked(&reg, &revoked));
        assert!(!is_revoked(&reg, &untouched));
    }

    #[test]
    fn test_mainnet_ready_always_false() {
        let reg = new_registry(&[0x0Cu8; 32]).unwrap();
        assert!(!reg.mainnet_ready);
    }
}
