use sha2::{Digest, Sha256};

pub const BLOCKER_EXTERNAL_TOOLCHAIN: &str =
    "BLOCKED_EXTERNAL_TOOLCHAIN: Bonsol CLI not installed. Install: npm i -g @bonsol/cli (if available) or see https://github.com/anagrambuild/bonsol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BonsolProgramId(pub [u8; 32]);

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExecutionRequest {
    pub program_id: BonsolProgramId,
    pub input_hash: [u8; 32],
    pub tip_lamports: u64,
    pub requester_pubkey: [u8; 32],
    pub nonce: [u8; 8],
}

impl ExecutionRequest {
    pub fn request_hash(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"dark_null_v1_bonsol_request");
        h.update(&self.program_id.0);
        h.update(self.input_hash);
        h.update(self.tip_lamports.to_le_bytes());
        h.update(self.requester_pubkey);
        h.update(self.nonce);
        h.finalize().into()
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExecutionReceipt {
    pub request_hash: [u8; 32],
    pub output_hash: [u8; 32],
    pub prover_pubkey: [u8; 32],
    pub execution_tx_sig: Option<String>, // None if no real tx
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VerifiedExecutionDigest {
    pub receipt_hash: [u8; 32],
    pub output_hash: [u8; 32],
    pub is_real: bool, // false = mock/stub
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BonsolError {
    ToolchainBlocked(String),
    NoPendingExecution,
    InvalidReceipt,
    OutputMismatch,
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/// BonsolAdapter — fail-closed unless toolchain_available is set to true.
///
/// No real Bonsol CLI or prover network is available in this environment.
/// All methods that require the external toolchain return `BonsolError::ToolchainBlocked`.
pub struct BonsolAdapter {
    pub toolchain_available: bool,
}

impl BonsolAdapter {
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

    /// Submit an execution request to the Bonsol prover network.
    /// Returns the request hash on success.
    pub fn submit_execution_request(
        &self,
        _request: &ExecutionRequest,
    ) -> Result<[u8; 32], BonsolError> {
        if !self.toolchain_available {
            return Err(BonsolError::ToolchainBlocked(
                BLOCKER_EXTERNAL_TOOLCHAIN.into(),
            ));
        }
        Err(BonsolError::ToolchainBlocked(
            "toolchain_available=true but no real implementation wired".into(),
        ))
    }

    /// Poll or await an execution receipt for a previously submitted request.
    pub fn await_execution_receipt(
        &self,
        _request_hash: &[u8; 32],
    ) -> Result<ExecutionReceipt, BonsolError> {
        if !self.toolchain_available {
            return Err(BonsolError::ToolchainBlocked(
                BLOCKER_EXTERNAL_TOOLCHAIN.into(),
            ));
        }
        Err(BonsolError::NoPendingExecution)
    }

    /// Verify that a receipt's output matches the expected output hash.
    pub fn verify_receipt(
        &self,
        receipt: &ExecutionReceipt,
        expected_output_hash: &[u8; 32],
    ) -> Result<VerifiedExecutionDigest, BonsolError> {
        if !self.toolchain_available {
            return Err(BonsolError::ToolchainBlocked(
                BLOCKER_EXTERNAL_TOOLCHAIN.into(),
            ));
        }
        if receipt.output_hash != *expected_output_hash {
            return Err(BonsolError::OutputMismatch);
        }
        let mut h = Sha256::new();
        h.update(b"dark_null_v1_bonsol_receipt");
        h.update(receipt.request_hash);
        h.update(receipt.output_hash);
        Ok(VerifiedExecutionDigest {
            receipt_hash: h.finalize().into(),
            output_hash: receipt.output_hash,
            is_real: false,
        })
    }
}

impl Default for BonsolAdapter {
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

    fn make_request() -> ExecutionRequest {
        ExecutionRequest {
            program_id: BonsolProgramId([0xAAu8; 32]),
            input_hash: [0xBBu8; 32],
            tip_lamports: 5000,
            requester_pubkey: [0xCCu8; 32],
            nonce: [1u8; 8],
        }
    }

    fn make_receipt(req: &ExecutionRequest) -> ExecutionReceipt {
        ExecutionReceipt {
            request_hash: req.request_hash(),
            output_hash: [0xDDu8; 32],
            prover_pubkey: [0xEEu8; 32],
            execution_tx_sig: None,
        }
    }

    // 1. Default adapter is fail-closed.
    #[test]
    fn test_adapter_default_is_fail_closed() {
        let adapter = BonsolAdapter::default();
        assert!(!adapter.toolchain_available);
    }

    // 2. submit_execution_request blocked without toolchain.
    #[test]
    fn test_submit_blocked_without_toolchain() {
        let adapter = BonsolAdapter::new();
        let req = make_request();
        match adapter.submit_execution_request(&req) {
            Err(BonsolError::ToolchainBlocked(msg)) => {
                assert!(msg.contains("BLOCKED_EXTERNAL_TOOLCHAIN"));
            }
            other => panic!("expected ToolchainBlocked, got {:?}", other),
        }
    }

    // 3. await_execution_receipt blocked without toolchain.
    #[test]
    fn test_await_blocked_without_toolchain() {
        let adapter = BonsolAdapter::new();
        let dummy_hash = [0u8; 32];
        match adapter.await_execution_receipt(&dummy_hash) {
            Err(BonsolError::ToolchainBlocked(msg)) => {
                assert!(msg.contains("BLOCKED_EXTERNAL_TOOLCHAIN"));
            }
            other => panic!("expected ToolchainBlocked, got {:?}", other),
        }
    }

    // 4. verify_receipt blocked without toolchain.
    #[test]
    fn test_verify_blocked_without_toolchain() {
        let adapter = BonsolAdapter::new();
        let req = make_request();
        let receipt = make_receipt(&req);
        let expected = [0xDDu8; 32];
        match adapter.verify_receipt(&receipt, &expected) {
            Err(BonsolError::ToolchainBlocked(msg)) => {
                assert!(msg.contains("BLOCKED_EXTERNAL_TOOLCHAIN"));
            }
            other => panic!("expected ToolchainBlocked, got {:?}", other),
        }
    }

    // 5. request_hash is deterministic for identical inputs.
    #[test]
    fn test_request_hash_deterministic() {
        let req = make_request();
        let h1 = req.request_hash();
        let h2 = req.request_hash();
        assert_eq!(h1, h2);
        assert_ne!(h1, [0u8; 32]);

        // Different nonce → different hash
        let mut req2 = make_request();
        req2.nonce = [2u8; 8];
        assert_ne!(req.request_hash(), req2.request_hash());
    }

    // 6. OutputMismatch returned when toolchain=true but output hashes differ.
    #[test]
    fn test_output_mismatch_rejected_when_toolchain_available() {
        let adapter = BonsolAdapter::new_with_toolchain();
        let req = make_request();
        let receipt = make_receipt(&req); // output_hash = [0xDD; 32]
        let wrong_expected = [0x00u8; 32]; // intentionally wrong
        match adapter.verify_receipt(&receipt, &wrong_expected) {
            Err(BonsolError::OutputMismatch) => {}
            other => panic!("expected OutputMismatch, got {:?}", other),
        }
    }
}
