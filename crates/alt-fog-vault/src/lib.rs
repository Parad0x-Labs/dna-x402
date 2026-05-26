use sha2::{Digest, Sha256};

pub const MAX_ALT_ACCOUNTS: usize = 256; // Solana ALT limit
pub const DOMAIN_VAULT: u8 = 0x40;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FogAccountKind {
    Receipt,
    Chaff,
    Maintenance,
    DecoyAta,
    DecoyProgram,
    OldScratch,
}

#[derive(Clone, Debug)]
pub struct FogAccount {
    pub pubkey: [u8; 32],
    pub kind: FogAccountKind,
    pub added_epoch: u64,
}

#[derive(Debug, Default)]
pub struct AltFogVault {
    pub accounts: Vec<FogAccount>,
    pub vault_seed: [u8; 32],
    pub epoch: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum VaultError {
    BudgetExceeded,
    DuplicateAccount,
}

impl AltFogVault {
    pub fn new(seed: [u8; 32], epoch: u64) -> Self {
        Self {
            vault_seed: seed,
            epoch,
            accounts: vec![],
        }
    }

    pub fn add(&mut self, account: FogAccount) -> Result<(), VaultError> {
        if self.accounts.len() >= MAX_ALT_ACCOUNTS {
            return Err(VaultError::BudgetExceeded);
        }
        if self.accounts.iter().any(|a| a.pubkey == account.pubkey) {
            return Err(VaultError::DuplicateAccount);
        }
        self.accounts.push(account);
        Ok(())
    }

    /// Deterministic candidate set from vault_seed (for testing/generation)
    pub fn generate_candidates(seed: &[u8; 32], count: usize, epoch: u64) -> Vec<[u8; 32]> {
        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            let mut h = Sha256::new();
            h.update([DOMAIN_VAULT]);
            h.update(seed);
            h.update(epoch.to_le_bytes());
            h.update((i as u32).to_le_bytes());
            out.push(h.finalize().into());
        }
        out
    }

    /// Extension plan: which accounts to add to an ALT
    pub fn extension_plan(&self, required_real: &[[u8; 32]]) -> Vec<[u8; 32]> {
        let mut plan: Vec<[u8; 32]> = required_real.to_vec();
        for fog in &self.accounts {
            if !plan.contains(&fog.pubkey) && plan.len() < MAX_ALT_ACCOUNTS {
                plan.push(fog.pubkey);
            }
        }
        plan
    }

    pub fn vault_commitment(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update([DOMAIN_VAULT]);
        h.update(&self.vault_seed);
        h.update(self.epoch.to_le_bytes());
        for a in &self.accounts {
            h.update(&a.pubkey);
        }
        h.finalize().into()
    }

    pub fn len(&self) -> usize {
        self.accounts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.accounts.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xAB;
        s
    }

    fn make_pubkey(b: u8) -> [u8; 32] {
        let mut p = [0u8; 32];
        p[0] = b;
        p
    }

    fn fog(b: u8) -> FogAccount {
        FogAccount {
            pubkey: make_pubkey(b),
            kind: FogAccountKind::Chaff,
            added_epoch: 0,
        }
    }

    #[test]
    fn test_add_account() {
        let mut vault = AltFogVault::new(seed(), 1);
        assert!(vault.is_empty());
        vault.add(fog(1)).unwrap();
        assert_eq!(vault.len(), 1);
    }

    #[test]
    fn test_duplicate_rejected() {
        let mut vault = AltFogVault::new(seed(), 1);
        vault.add(fog(5)).unwrap();
        let err = vault.add(fog(5)).unwrap_err();
        assert_eq!(err, VaultError::DuplicateAccount);
    }

    #[test]
    fn test_budget_exceeded() {
        let mut vault = AltFogVault::new(seed(), 1);
        // Fill to capacity
        for i in 0..MAX_ALT_ACCOUNTS {
            let mut pk = [0u8; 32];
            pk[0] = (i & 0xff) as u8;
            pk[1] = ((i >> 8) & 0xff) as u8;
            vault
                .add(FogAccount {
                    pubkey: pk,
                    kind: FogAccountKind::Chaff,
                    added_epoch: 0,
                })
                .unwrap();
        }
        assert_eq!(vault.len(), MAX_ALT_ACCOUNTS);
        let mut extra = [0xFFu8; 32];
        extra[1] = 0xFF;
        let err = vault
            .add(FogAccount {
                pubkey: extra,
                kind: FogAccountKind::OldScratch,
                added_epoch: 0,
            })
            .unwrap_err();
        assert_eq!(err, VaultError::BudgetExceeded);
    }

    #[test]
    fn test_generate_candidates_deterministic() {
        let s = seed();
        let c1 = AltFogVault::generate_candidates(&s, 10, 0);
        let c2 = AltFogVault::generate_candidates(&s, 10, 0);
        assert_eq!(c1, c2);
        assert_eq!(c1.len(), 10);
        // All distinct
        let unique: std::collections::HashSet<_> = c1.iter().collect();
        assert_eq!(unique.len(), 10);
    }

    #[test]
    fn test_extension_plan_includes_required() {
        let mut vault = AltFogVault::new(seed(), 1);
        vault.add(fog(10)).unwrap();
        vault.add(fog(11)).unwrap();

        let required = vec![make_pubkey(1), make_pubkey(2)];
        let plan = vault.extension_plan(&required);

        // Required accounts are at the front
        assert_eq!(plan[0], make_pubkey(1));
        assert_eq!(plan[1], make_pubkey(2));
        // Fog accounts appended
        assert!(plan.contains(&make_pubkey(10)));
        assert!(plan.contains(&make_pubkey(11)));
    }

    #[test]
    fn test_vault_commitment_changes_on_add() {
        let mut vault = AltFogVault::new(seed(), 1);
        let c1 = vault.vault_commitment();
        vault.add(fog(7)).unwrap();
        let c2 = vault.vault_commitment();
        assert_ne!(c1, c2);
    }
}
