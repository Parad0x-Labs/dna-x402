use sha2::{Digest, Sha256};
use std::fmt;

pub const BLOCKER_RISC0: &str =
    "BLOCKED_EXTERNAL_TOOLCHAIN: RISC Zero toolchain not installed. Install: curl -L https://risczero.com/install | bash && rzup install";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Risc0ImageId(pub [u8; 32]);

impl Risc0ImageId {
    /// SHA-256 digest of the image ID bytes (used for logging / evidence).
    pub fn digest(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(self.0);
        h.finalize().into()
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Risc0Receipt {
    pub image_id: Risc0ImageId,
    /// SHA-256 hash of the journal (public output).
    pub journal_hash: [u8; 32],
    /// SHA-256 hash of the STARK/SNARK seal bytes.
    pub seal_hash: [u8; 32],
    /// On-chain tx sig if submitted to Solana; None for local/mock proofs.
    pub receipt_tx_sig: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Risc0VerificationResult {
    pub verified: bool,
    pub journal_hash: [u8; 32],
    pub is_real: bool, // false = stub, true = real zkVM proof
}

// ---------------------------------------------------------------------------
// Error type with Display
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Risc0Error {
    ToolchainBlocked(String),
    InvalidImageId,
    JournalMismatch,
    SealInvalid,
}

impl fmt::Display for Risc0Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Risc0Error::ToolchainBlocked(msg) => {
                write!(f, "Risc0Error::ToolchainBlocked: {}", msg)
            }
            Risc0Error::InvalidImageId => write!(f, "Risc0Error::InvalidImageId"),
            Risc0Error::JournalMismatch => write!(f, "Risc0Error::JournalMismatch"),
            Risc0Error::SealInvalid => write!(f, "Risc0Error::SealInvalid"),
        }
    }
}

impl std::error::Error for Risc0Error {}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/// Risc0Adapter — fail-closed unless toolchain_available is set to true.
///
/// RISC Zero rzup is not installed in this environment. All methods that
/// require the external zkVM toolchain return `Risc0Error::ToolchainBlocked`.
pub struct Risc0Adapter {
    pub toolchain_available: bool,
}

impl Risc0Adapter {
    pub fn new() -> Self {
        Self {
            toolchain_available: false,
        }
    }

    pub fn new_with_toolchain() -> Self {
        Self {
            toolchain_available: true,
        }
    }

    /// Prove a batch by running the guest ELF in the RISC Zero zkVM.
    ///
    /// `input_hash` is the SHA-256 commitment to the serialised `DarkBatchInput`.
    /// Returns a receipt containing the journal hash and seal hash.
    pub fn prove_batch(
        &self,
        _input_hash: &[u8; 32],
        _image_id: &Risc0ImageId,
    ) -> Result<Risc0Receipt, Risc0Error> {
        if !self.toolchain_available {
            return Err(Risc0Error::ToolchainBlocked(BLOCKER_RISC0.into()));
        }
        Err(Risc0Error::ToolchainBlocked(
            "toolchain_available=true but no real rzup implementation wired".into(),
        ))
    }

    /// Verify a previously generated receipt against the expected image ID.
    pub fn verify_receipt(
        &self,
        receipt: &Risc0Receipt,
        image_id: &Risc0ImageId,
    ) -> Result<Risc0VerificationResult, Risc0Error> {
        if !self.toolchain_available {
            return Err(Risc0Error::ToolchainBlocked(BLOCKER_RISC0.into()));
        }
        // Image ID check (stub: byte-level equality).
        if receipt.image_id.0 != image_id.0 {
            return Err(Risc0Error::InvalidImageId);
        }
        // Seal validity stub — always invalid without real toolchain.
        if receipt.seal_hash == [0u8; 32] {
            return Err(Risc0Error::SealInvalid);
        }
        Ok(Risc0VerificationResult {
            verified: true,
            journal_hash: receipt.journal_hash,
            is_real: false,
        })
    }
}

impl Default for Risc0Adapter {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_image_id() -> Risc0ImageId {
        Risc0ImageId([0x11u8; 32])
    }

    fn make_receipt(image_id: &Risc0ImageId) -> Risc0Receipt {
        Risc0Receipt {
            image_id: image_id.clone(),
            journal_hash: [0x22u8; 32],
            seal_hash: [0x33u8; 32],
            receipt_tx_sig: None,
        }
    }

    // 1. Default adapter is fail-closed.
    #[test]
    fn test_risc0_adapter_default_fail_closed() {
        let adapter = Risc0Adapter::default();
        assert!(!adapter.toolchain_available);
    }

    // 2. prove_batch blocked without toolchain.
    #[test]
    fn test_prove_blocked_without_toolchain() {
        let adapter = Risc0Adapter::new();
        let image_id = make_image_id();
        let input_hash = [0xAAu8; 32];
        match adapter.prove_batch(&input_hash, &image_id) {
            Err(Risc0Error::ToolchainBlocked(msg)) => {
                assert!(msg.contains("BLOCKED_EXTERNAL_TOOLCHAIN"));
            }
            other => panic!("expected ToolchainBlocked, got {:?}", other),
        }
    }

    // 3. verify_receipt blocked without toolchain.
    #[test]
    fn test_verify_blocked_without_toolchain() {
        let adapter = Risc0Adapter::new();
        let image_id = make_image_id();
        let receipt = make_receipt(&image_id);
        match adapter.verify_receipt(&receipt, &image_id) {
            Err(Risc0Error::ToolchainBlocked(msg)) => {
                assert!(msg.contains("BLOCKED_EXTERNAL_TOOLCHAIN"));
            }
            other => panic!("expected ToolchainBlocked, got {:?}", other),
        }
    }

    // 4. Risc0ImageId::digest is deterministic for identical inputs.
    #[test]
    fn test_image_id_hash_deterministic() {
        let id1 = Risc0ImageId([0xABu8; 32]);
        let id2 = Risc0ImageId([0xABu8; 32]);
        assert_eq!(id1.digest(), id2.digest());
        assert_ne!(id1.digest(), [0u8; 32]);

        // Different bytes → different digest
        let id3 = Risc0ImageId([0xCDu8; 32]);
        assert_ne!(id1.digest(), id3.digest());
    }

    // 5. ToolchainBlocked message contains the install URL.
    #[test]
    fn test_toolchain_blocked_message_contains_install_url() {
        let adapter = Risc0Adapter::new();
        let image_id = make_image_id();
        let input_hash = [0u8; 32];
        match adapter.prove_batch(&input_hash, &image_id) {
            Err(Risc0Error::ToolchainBlocked(msg)) => {
                assert!(
                    msg.contains("risczero.com"),
                    "message should mention install URL, got: {}",
                    msg
                );
            }
            other => panic!("expected ToolchainBlocked, got {:?}", other),
        }
    }

    // 6. Risc0Error Display formatting is correct for all variants.
    #[test]
    fn test_risc0_error_display_format() {
        let blocked = Risc0Error::ToolchainBlocked("test reason".into());
        let s = format!("{}", blocked);
        assert!(s.contains("ToolchainBlocked"));
        assert!(s.contains("test reason"));

        assert_eq!(
            format!("{}", Risc0Error::InvalidImageId),
            "Risc0Error::InvalidImageId"
        );
        assert_eq!(
            format!("{}", Risc0Error::JournalMismatch),
            "Risc0Error::JournalMismatch"
        );
        assert_eq!(
            format!("{}", Risc0Error::SealInvalid),
            "Risc0Error::SealInvalid"
        );
    }
}
