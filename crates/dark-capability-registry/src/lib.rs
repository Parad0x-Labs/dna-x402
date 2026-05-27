use dark_module_abi::{ModuleCommitment, ModuleId, ModuleResult};
use sha2::{Digest, Sha256};

#[derive(Debug, PartialEq, Eq)]
pub enum RegistryError {
    UnknownModule,
    PausedModule,
    InsufficientCapability,
    AlreadyRegistered,
}

pub struct Registry {
    commitments: Vec<ModuleCommitment>,
}

impl Registry {
    pub fn new() -> Self {
        Self {
            commitments: Vec::new(),
        }
    }

    pub fn register(&mut self, commitment: ModuleCommitment) -> Result<(), RegistryError> {
        if self.find(&commitment.module_id).is_some() {
            return Err(RegistryError::AlreadyRegistered);
        }
        self.commitments.push(commitment);
        Ok(())
    }

    pub fn pause(&mut self, module_id: &ModuleId) -> Result<(), RegistryError> {
        match self
            .commitments
            .iter_mut()
            .find(|c| &c.module_id == module_id)
        {
            Some(c) => {
                c.paused = true;
                Ok(())
            }
            None => Err(RegistryError::UnknownModule),
        }
    }

    pub fn resume(&mut self, module_id: &ModuleId) -> Result<(), RegistryError> {
        match self
            .commitments
            .iter_mut()
            .find(|c| &c.module_id == module_id)
        {
            Some(c) => {
                c.paused = false;
                Ok(())
            }
            None => Err(RegistryError::UnknownModule),
        }
    }

    pub fn verify_result(
        &self,
        result: &ModuleResult,
        required_cap: u8,
    ) -> Result<(), RegistryError> {
        let commitment = self
            .find(&result.module_id)
            .ok_or(RegistryError::UnknownModule)?;
        if commitment.paused {
            return Err(RegistryError::PausedModule);
        }
        if !commitment.capabilities.has(required_cap) {
            return Err(RegistryError::InsufficientCapability);
        }
        Ok(())
    }

    /// SHA-256 of all commitment hashes concatenated (in registration order).
    pub fn registry_root(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        for c in &self.commitments {
            h.update(c.commitment_hash());
        }
        h.finalize().into()
    }

    pub fn find(&self, module_id: &ModuleId) -> Option<&ModuleCommitment> {
        self.commitments.iter().find(|c| &c.module_id == module_id)
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dark_module_abi::{
        CapabilityBitmap, ModuleId, ModuleResult, ModuleVersion, CAP_RELAY, CAP_SPEND,
    };

    fn make_commitment(id: u8, cap_bits: &[u8]) -> ModuleCommitment {
        let mut caps = CapabilityBitmap::default();
        for &b in cap_bits {
            caps.grant(b);
        }
        ModuleCommitment {
            module_id: ModuleId([id; 32]),
            version: ModuleVersion(1),
            code_hash: [id + 1; 32],
            abi_hash: [id + 2; 32],
            capabilities: caps,
            paused: false,
        }
    }

    fn make_result(id: u8) -> ModuleResult {
        ModuleResult {
            module_id: ModuleId([id; 32]),
            input_hash: [10u8; 32],
            output_hash: [11u8; 32],
            receipt_hash: [12u8; 32],
            signer: [13u8; 32],
        }
    }

    #[test]
    fn test_register_and_find() {
        let mut reg = Registry::new();
        let c = make_commitment(1, &[CAP_SPEND]);
        reg.register(c.clone()).unwrap();
        let found = reg.find(&ModuleId([1u8; 32])).unwrap();
        assert_eq!(found.module_id, c.module_id);
    }

    #[test]
    fn test_duplicate_rejected() {
        let mut reg = Registry::new();
        reg.register(make_commitment(1, &[CAP_SPEND])).unwrap();
        let err = reg.register(make_commitment(1, &[CAP_SPEND])).unwrap_err();
        assert_eq!(err, RegistryError::AlreadyRegistered);
    }

    #[test]
    fn test_pause_resume() {
        let mut reg = Registry::new();
        reg.register(make_commitment(2, &[CAP_SPEND])).unwrap();
        let id = ModuleId([2u8; 32]);
        reg.pause(&id).unwrap();
        assert!(reg.find(&id).unwrap().paused);
        reg.resume(&id).unwrap();
        assert!(!reg.find(&id).unwrap().paused);
    }

    #[test]
    fn test_paused_verify_rejected() {
        let mut reg = Registry::new();
        reg.register(make_commitment(3, &[CAP_SPEND])).unwrap();
        reg.pause(&ModuleId([3u8; 32])).unwrap();
        let result = make_result(3);
        let err = reg.verify_result(&result, CAP_SPEND).unwrap_err();
        assert_eq!(err, RegistryError::PausedModule);
    }

    #[test]
    fn test_cap_check() {
        let mut reg = Registry::new();
        // Only grant CAP_SPEND, not CAP_RELAY
        reg.register(make_commitment(4, &[CAP_SPEND])).unwrap();
        let result = make_result(4);
        // CAP_SPEND should pass
        reg.verify_result(&result, CAP_SPEND).unwrap();
        // CAP_RELAY should fail
        let err = reg.verify_result(&result, CAP_RELAY).unwrap_err();
        assert_eq!(err, RegistryError::InsufficientCapability);
    }

    #[test]
    fn test_registry_root_changes_on_register() {
        let mut reg = Registry::new();
        // Empty root
        let root0 = reg.registry_root();
        reg.register(make_commitment(5, &[CAP_SPEND])).unwrap();
        let root1 = reg.registry_root();
        assert_ne!(root0, root1);
        reg.register(make_commitment(6, &[CAP_RELAY])).unwrap();
        let root2 = reg.registry_root();
        assert_ne!(root1, root2);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_new_registry_find_returns_none() {
        let reg = Registry::new();
        assert!(reg.find(&ModuleId([99u8; 32])).is_none());
    }

    #[test]
    fn test_pause_unknown_module_rejected() {
        let mut reg = Registry::new();
        let err = reg.pause(&ModuleId([0xFFu8; 32])).unwrap_err();
        assert_eq!(err, RegistryError::UnknownModule);
    }

    #[test]
    fn test_resume_unknown_module_rejected() {
        let mut reg = Registry::new();
        let err = reg.resume(&ModuleId([0xFFu8; 32])).unwrap_err();
        assert_eq!(err, RegistryError::UnknownModule);
    }

    #[test]
    fn test_verify_unknown_module_rejected() {
        let reg = Registry::new();
        let result = make_result(7);
        let err = reg.verify_result(&result, CAP_SPEND).unwrap_err();
        assert_eq!(err, RegistryError::UnknownModule);
    }

    #[test]
    fn test_registry_root_deterministic() {
        let mut r1 = Registry::new();
        let mut r2 = Registry::new();
        r1.register(make_commitment(10, &[CAP_SPEND])).unwrap();
        r2.register(make_commitment(10, &[CAP_SPEND])).unwrap();
        assert_eq!(r1.registry_root(), r2.registry_root());
    }

    #[test]
    fn test_registry_root_order_sensitive() {
        let mut r1 = Registry::new();
        let mut r2 = Registry::new();
        r1.register(make_commitment(1, &[CAP_SPEND])).unwrap();
        r1.register(make_commitment(2, &[CAP_RELAY])).unwrap();
        r2.register(make_commitment(2, &[CAP_RELAY])).unwrap();
        r2.register(make_commitment(1, &[CAP_SPEND])).unwrap();
        // Different registration order → different root (hashes concatenated in order)
        assert_ne!(r1.registry_root(), r2.registry_root());
    }

    #[test]
    fn test_multiple_modules_findable() {
        let mut reg = Registry::new();
        for id in [20u8, 21, 22] {
            reg.register(make_commitment(id, &[CAP_SPEND])).unwrap();
        }
        for id in [20u8, 21, 22] {
            assert!(reg.find(&ModuleId([id; 32])).is_some());
        }
    }

    #[test]
    fn test_resumed_module_verifies() {
        let mut reg = Registry::new();
        reg.register(make_commitment(30, &[CAP_SPEND])).unwrap();
        let id = ModuleId([30u8; 32]);
        reg.pause(&id).unwrap();
        reg.resume(&id).unwrap();
        let result = make_result(30);
        assert!(reg.verify_result(&result, CAP_SPEND).is_ok());
    }

    #[test]
    fn test_registry_root_nonzero_after_register() {
        let mut reg = Registry::new();
        reg.register(make_commitment(40, &[CAP_SPEND])).unwrap();
        assert_ne!(reg.registry_root(), [0u8; 32]);
    }

    #[test]
    fn test_cap_relay_granted_and_verified() {
        let mut reg = Registry::new();
        reg.register(make_commitment(50, &[CAP_RELAY])).unwrap();
        let result = make_result(50);
        assert!(reg.verify_result(&result, CAP_RELAY).is_ok());
    }
}
