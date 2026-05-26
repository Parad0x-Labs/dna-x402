use sha2::{Digest, Sha256};

pub const DOMAIN_MODULE_COMMIT: u8 = 0x10;
pub const DOMAIN_MODULE_RESULT: u8 = 0x11;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ModuleId(pub [u8; 32]);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModuleVersion(pub u32);

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct CapabilityBitmap(pub u64);

impl CapabilityBitmap {
    pub fn has(&self, bit: u8) -> bool {
        self.0 & (1u64 << bit) != 0
    }
    pub fn grant(&mut self, bit: u8) {
        self.0 |= 1u64 << bit;
    }
    pub fn revoke(&mut self, bit: u8) {
        self.0 &= !(1u64 << bit);
    }
}

pub const CAP_SPEND: u8 = 0;
pub const CAP_ROLLUP: u8 = 1;
pub const CAP_RELAY: u8 = 2;
pub const CAP_CHAFF: u8 = 3;
pub const CAP_ADMIN: u8 = 7;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModuleCommitment {
    pub module_id: ModuleId,
    pub version: ModuleVersion,
    pub code_hash: [u8; 32],
    pub abi_hash: [u8; 32],
    pub capabilities: CapabilityBitmap,
    pub paused: bool,
}

impl ModuleCommitment {
    pub fn commitment_hash(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update([DOMAIN_MODULE_COMMIT]);
        h.update(&self.module_id.0);
        h.update(self.version.0.to_le_bytes());
        h.update(&self.code_hash);
        h.update(&self.abi_hash);
        h.update(self.capabilities.0.to_le_bytes());
        h.update([self.paused as u8]);
        h.finalize().into()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModuleResult {
    pub module_id: ModuleId,
    pub input_hash: [u8; 32],
    pub output_hash: [u8; 32],
    pub receipt_hash: [u8; 32],
    pub signer: [u8; 32],
}

impl ModuleResult {
    pub fn result_hash(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update([DOMAIN_MODULE_RESULT]);
        h.update(&self.module_id.0);
        h.update(&self.input_hash);
        h.update(&self.output_hash);
        h.update(&self.receipt_hash);
        h.update(&self.signer);
        h.finalize().into()
    }

    pub fn verify_against(&self, commitment: &ModuleCommitment) -> bool {
        !commitment.paused && self.module_id == commitment.module_id
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ModuleError {
    UnknownModule,
    PausedModule,
    InsufficientCapability,
    ResultTampered,
    VersionMismatch,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_commitment(paused: bool) -> ModuleCommitment {
        let mut caps = CapabilityBitmap::default();
        caps.grant(CAP_SPEND);
        caps.grant(CAP_RELAY);
        ModuleCommitment {
            module_id: ModuleId([1u8; 32]),
            version: ModuleVersion(1),
            code_hash: [2u8; 32],
            abi_hash: [3u8; 32],
            capabilities: caps,
            paused,
        }
    }

    fn sample_result() -> ModuleResult {
        ModuleResult {
            module_id: ModuleId([1u8; 32]),
            input_hash: [4u8; 32],
            output_hash: [5u8; 32],
            receipt_hash: [6u8; 32],
            signer: [7u8; 32],
        }
    }

    #[test]
    fn test_capability_bitmap_grant_revoke() {
        let mut caps = CapabilityBitmap::default();
        caps.grant(CAP_SPEND);
        assert!(caps.has(CAP_SPEND));
        caps.revoke(CAP_SPEND);
        assert!(!caps.has(CAP_SPEND));
    }

    #[test]
    fn test_capability_has() {
        let mut caps = CapabilityBitmap::default();
        assert!(!caps.has(CAP_ADMIN));
        caps.grant(CAP_ADMIN);
        assert!(caps.has(CAP_ADMIN));
        assert!(!caps.has(CAP_ROLLUP));
    }

    #[test]
    fn test_commitment_hash_deterministic() {
        let c = sample_commitment(false);
        let h1 = c.commitment_hash();
        let h2 = c.commitment_hash();
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_commitment_hash_changes_on_pause() {
        let c_active = sample_commitment(false);
        let c_paused = sample_commitment(true);
        assert_ne!(c_active.commitment_hash(), c_paused.commitment_hash());
    }

    #[test]
    fn test_result_hash_deterministic() {
        let r = sample_result();
        let h1 = r.result_hash();
        let h2 = r.result_hash();
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_paused_module_rejected() {
        let commitment = sample_commitment(true);
        let result = sample_result();
        assert!(!result.verify_against(&commitment));
    }

    #[test]
    fn test_result_tamper_detected() {
        let mut result = sample_result();
        let hash_before = result.result_hash();
        result.output_hash = [99u8; 32];
        let hash_after = result.result_hash();
        assert_ne!(hash_before, hash_after);
    }

    #[test]
    fn test_module_id_equality() {
        let id1 = ModuleId([42u8; 32]);
        let id2 = ModuleId([42u8; 32]);
        let id3 = ModuleId([0u8; 32]);
        assert_eq!(id1, id2);
        assert_ne!(id1, id3);
    }
}
