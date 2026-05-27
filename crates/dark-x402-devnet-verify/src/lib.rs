// dark-x402-devnet-verify — NOT_PRODUCTION
// Verifies real Solana devnet payments for the x402 strict-mode flow.
// All receipts minted here have is_mock=false, mainnet_ready=false.
//
// Architecture:
//   PaymentVerifier trait  ←  DevnetPaymentVerifier (real RPC, blocking)
//                          ←  FixtureVerifier       (deterministic, for tests)
//   StrictX402Server       ←  wraps dark-x402-core logic + any PaymentVerifier

use dark_x402_core::*;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

// ─── VerifiedDevnetPayment ────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VerifiedDevnetPayment {
    pub signature: String,
    pub slot: u64,
    /// First account in the transaction (typically the fee-payer / signer).
    pub payer: Option<[u8; 32]>,
    pub pay_to: [u8; 32],
    pub amount_lamports: u64,
    pub network: String,
}

// ─── X402DevnetError ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum X402DevnetError {
    /// Caller passed a "MOCK_SIG_*" signature to strict mode.
    MockSigRejected,
    /// Signature string is not valid base58.
    SignatureInvalid,
    /// Transaction not found on the RPC node.
    TxNotFound,
    /// Transaction exists but failed on-chain.
    TxFailed(String),
    /// pay_to pubkey present in tx but balance did not increase enough.
    WrongPayTo { expected: [u8; 32], found: [u8; 32] },
    /// pay_to received fewer lamports than required.
    Underpayment { expected: u64, found: u64 },
    /// pay_to pubkey not found in any account key of the transaction.
    RecipientNotFound,
    /// RPC communication or parsing error.
    RpcError(String),
}

impl std::fmt::Display for X402DevnetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MockSigRejected => write!(f, "mock signature rejected in strict mode"),
            Self::SignatureInvalid => write!(f, "signature is not valid base58"),
            Self::TxNotFound => write!(f, "transaction not found on devnet"),
            Self::TxFailed(e) => write!(f, "transaction failed on-chain: {}", e),
            Self::WrongPayTo { expected, found } => {
                write!(
                    f,
                    "wrong pay_to: expected first 4 bytes {:?}, found {:?}",
                    &expected[..4],
                    &found[..4]
                )
            }
            Self::Underpayment { expected, found } => {
                write!(
                    f,
                    "underpayment: expected {} lamports, found {}",
                    expected, found
                )
            }
            Self::RecipientNotFound => {
                write!(f, "recipient pubkey not found in transaction account keys")
            }
            Self::RpcError(e) => write!(f, "RPC error: {}", e),
        }
    }
}

impl std::error::Error for X402DevnetError {}

// ─── PaymentVerifier trait ────────────────────────────────────────────────────

pub trait PaymentVerifier {
    /// Fetch and validate a devnet SOL transfer.
    ///
    /// - Rejects MOCK_SIG_* signatures immediately.
    /// - Confirms the tx exists and succeeded on-chain.
    /// - Confirms pay_to received >= expected_amount_lamports.
    /// - Returns slot, payer, amount, pay_to on success.
    fn verify_transfer(
        &self,
        signature: &str,
        expected_pay_to: &[u8; 32],
        expected_amount_lamports: u64,
    ) -> Result<VerifiedDevnetPayment, X402DevnetError>;
}

// ─── DevnetPaymentVerifier ────────────────────────────────────────────────────

/// Real Solana devnet verifier using blocking `solana-client` RPC.
///
/// Requires network access to `rpc_url` (defaults to devnet).
/// NOT suitable for unit tests — use `FixtureVerifier` instead.
pub struct DevnetPaymentVerifier {
    pub rpc_url: String,
}

impl DevnetPaymentVerifier {
    pub fn new(rpc_url: impl Into<String>) -> Self {
        Self {
            rpc_url: rpc_url.into(),
        }
    }

    pub fn devnet() -> Self {
        Self::new("https://api.devnet.solana.com")
    }
}

impl PaymentVerifier for DevnetPaymentVerifier {
    fn verify_transfer(
        &self,
        signature: &str,
        expected_pay_to: &[u8; 32],
        expected_amount_lamports: u64,
    ) -> Result<VerifiedDevnetPayment, X402DevnetError> {
        // Immediately reject mock sigs — fail-closed
        if signature.starts_with("MOCK_SIG_") {
            return Err(X402DevnetError::MockSigRejected);
        }

        use solana_client::rpc_client::RpcClient;
        use solana_sdk::commitment_config::CommitmentConfig;
        use solana_sdk::pubkey::Pubkey;
        use solana_sdk::signature::Signature;
        use solana_transaction_status::{EncodedTransaction, UiMessage, UiTransactionEncoding};
        use std::str::FromStr;

        let sig = Signature::from_str(signature).map_err(|_| X402DevnetError::SignatureInvalid)?;

        let client =
            RpcClient::new_with_commitment(self.rpc_url.clone(), CommitmentConfig::confirmed());

        let tx_result = client
            .get_transaction(&sig, UiTransactionEncoding::Json)
            .map_err(|_| X402DevnetError::TxNotFound)?;

        let slot = tx_result.slot;

        let meta = tx_result
            .transaction
            .meta
            .ok_or_else(|| X402DevnetError::RpcError("no transaction metadata".to_string()))?;

        // Check on-chain success
        if meta.err.is_some() {
            return Err(X402DevnetError::TxFailed(
                "transaction failed on-chain".to_string(),
            ));
        }

        // Extract account keys as base58 strings
        let account_keys: Vec<String> = match &tx_result.transaction.transaction {
            EncodedTransaction::Json(ui_tx) => match &ui_tx.message {
                UiMessage::Raw(raw) => raw.account_keys.clone(),
                UiMessage::Parsed(parsed) => parsed
                    .account_keys
                    .iter()
                    .map(|k| k.pubkey.clone())
                    .collect(),
            },
            _ => {
                return Err(X402DevnetError::RpcError(
                    "unexpected tx encoding — expected Json".to_string(),
                ))
            }
        };

        // Find the expected recipient by pubkey
        let expected_pubkey = Pubkey::new_from_array(*expected_pay_to);
        let expected_b58 = expected_pubkey.to_string();

        let idx = account_keys
            .iter()
            .position(|k| k == &expected_b58)
            .ok_or(X402DevnetError::RecipientNotFound)?;

        // Compute balance delta for the recipient
        let pre = meta.pre_balances.get(idx).copied().unwrap_or(0);
        let post = meta.post_balances.get(idx).copied().unwrap_or(0);

        if post <= pre {
            return Err(X402DevnetError::Underpayment {
                expected: expected_amount_lamports,
                found: 0,
            });
        }

        let delta = post - pre;
        if delta < expected_amount_lamports {
            return Err(X402DevnetError::Underpayment {
                expected: expected_amount_lamports,
                found: delta,
            });
        }

        // Extract payer (typically account_keys[0] — the fee payer)
        let payer_bytes = account_keys
            .first()
            .and_then(|k| Pubkey::from_str(k).ok())
            .map(|pk| pk.to_bytes());

        Ok(VerifiedDevnetPayment {
            signature: signature.to_string(),
            slot,
            payer: payer_bytes,
            pay_to: *expected_pay_to,
            amount_lamports: delta,
            network: "solana-devnet".to_string(),
        })
    }
}

// ─── FixtureVerifier (for tests) ──────────────────────────────────────────────

/// Deterministic fixture verifier for unit tests — no network required.
///
/// Returns a pre-configured `Ok(payment)` or `Err(e)`, but always rejects
/// MOCK_SIG_* signatures and validates pay_to / amount against the fixture.
pub struct FixtureVerifier {
    fixture: Result<VerifiedDevnetPayment, X402DevnetError>,
}

impl FixtureVerifier {
    pub fn ok(payment: VerifiedDevnetPayment) -> Self {
        Self {
            fixture: Ok(payment),
        }
    }

    pub fn err(e: X402DevnetError) -> Self {
        Self { fixture: Err(e) }
    }

    pub fn tx_not_found() -> Self {
        Self::err(X402DevnetError::TxNotFound)
    }

    pub fn tx_failed() -> Self {
        Self::err(X402DevnetError::TxFailed(
            "on-chain failure (fixture)".to_string(),
        ))
    }
}

impl PaymentVerifier for FixtureVerifier {
    fn verify_transfer(
        &self,
        signature: &str,
        expected_pay_to: &[u8; 32],
        expected_amount_lamports: u64,
    ) -> Result<VerifiedDevnetPayment, X402DevnetError> {
        // Always reject mock sigs, even with a "success" fixture
        if signature.starts_with("MOCK_SIG_") {
            return Err(X402DevnetError::MockSigRejected);
        }

        match &self.fixture {
            Err(e) => Err(e.clone()),
            Ok(payment) => {
                // Validate pay_to
                if payment.pay_to != *expected_pay_to {
                    return Err(X402DevnetError::WrongPayTo {
                        expected: *expected_pay_to,
                        found: payment.pay_to,
                    });
                }
                // Validate amount
                if payment.amount_lamports < expected_amount_lamports {
                    return Err(X402DevnetError::Underpayment {
                        expected: expected_amount_lamports,
                        found: payment.amount_lamports,
                    });
                }
                Ok(payment.clone())
            }
        }
    }
}

// ─── StrictX402Server ─────────────────────────────────────────────────────────

/// x402 server that requires real devnet payment verification.
///
/// Rejects:
/// - `proof.is_mock = true`
/// - Signatures with `MOCK_SIG_` prefix
/// - Txs that failed, underpaid, or paid wrong recipient
/// - Replays (same replay_key twice)
///
/// Mints `DarkX402Receipt` with `is_mock = false` only after verification.
pub struct StrictX402Server {
    pub resource_path: String,
    pub amount_lamports: u64,
    pub pay_to: [u8; 32],
    pub network: String,
    verifier: Box<dyn PaymentVerifier>,
    redeemed_replay_keys: HashSet<[u8; 32]>,
    current_slot: u64,
}

#[derive(Debug)]
pub enum StrictServerResponse {
    PaymentRequired(X402PaymentRequirement),
    ServicePayload {
        data: Vec<u8>,
        receipt: DarkX402Receipt,
        verified: VerifiedDevnetPayment,
    },
    VerificationError(X402DevnetError),
    X402Error(X402Error),
}

impl StrictX402Server {
    pub fn new(
        resource_path: &str,
        amount_lamports: u64,
        pay_to: [u8; 32],
        verifier: Box<dyn PaymentVerifier>,
    ) -> Self {
        Self {
            resource_path: resource_path.to_string(),
            amount_lamports,
            pay_to,
            network: "solana-devnet".to_string(),
            verifier,
            redeemed_replay_keys: HashSet::new(),
            current_slot: 1000,
        }
    }

    pub fn make_requirement(&self) -> X402PaymentRequirement {
        let mut nonce = [0u8; 8];
        nonce.copy_from_slice(&self.current_slot.to_le_bytes()[..8]);
        X402PaymentRequirement {
            scheme: "exact".to_string(),
            network: self.network.clone(),
            asset: "SOL".to_string(),
            amount_lamports: self.amount_lamports,
            pay_to: self.pay_to,
            resource: self.resource_path.clone(),
            expires_at_slot: self.current_slot + 100,
            nonce,
            facilitator_url: None,
        }
    }

    pub fn request_resource_strict(
        &mut self,
        proof: Option<&X402PaymentProof>,
    ) -> StrictServerResponse {
        match proof {
            None => StrictServerResponse::PaymentRequired(self.make_requirement()),
            Some(proof) => {
                // 1. Strict mode: reject any mock proof immediately
                if proof.is_mock {
                    return StrictServerResponse::VerificationError(
                        X402DevnetError::MockSigRejected,
                    );
                }

                let req = self.make_requirement();

                // 2. Check requirement hash early to avoid unnecessary RPC calls
                if proof.requirement_hash != req.requirement_hash() {
                    return StrictServerResponse::X402Error(X402Error::RequirementHashMismatch);
                }

                // 3. Check replay before RPC hit
                let replay_key = derive_replay_key(&req, &proof.payer_pubkey);
                if self.redeemed_replay_keys.contains(&replay_key) {
                    return StrictServerResponse::X402Error(X402Error::Replay);
                }

                // 4. Verify the real devnet tx — fail-closed
                let verified = match self.verifier.verify_transfer(
                    &proof.tx_signature,
                    &self.pay_to,
                    self.amount_lamports,
                ) {
                    Ok(v) => v,
                    Err(e) => return StrictServerResponse::VerificationError(e),
                };

                // 5. Mint receipt only after successful verification
                let payload = b"dark_null_strict_service_payload";
                match mint_receipt_note_after_payment(&req, proof, payload, self.current_slot) {
                    Ok(receipt) => {
                        self.redeemed_replay_keys.insert(replay_key);
                        StrictServerResponse::ServicePayload {
                            data: payload.to_vec(),
                            receipt,
                            verified,
                        }
                    }
                    Err(e) => StrictServerResponse::X402Error(e),
                }
            }
        }
    }

    pub fn advance_slot(&mut self, slots: u64) {
        self.current_slot += slots;
    }
}

// ─── Evidence schema ──────────────────────────────────────────────────────────

/// JSON schema written to `dist/frontier-final/evidence/x402_devnet_real.json`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct X402DevnetEvidenceJson {
    pub commit: String,
    pub network: String,
    pub rpc_url: String,
    pub tx_signature: String,
    pub verified_at_slot: u64,
    pub amount_lamports: u64,
    pub pay_to: String,             // base58 pubkey
    pub requirement_hash: String,   // hex
    pub payment_proof_hash: String, // hex
    pub receipt_id: String,         // hex
    pub receipt_nullifier: String,  // hex
    pub mock: bool,
    pub mainnet_ready: bool,
}

impl X402DevnetEvidenceJson {
    /// Returns `Err` if the evidence would be misleading or unsafe to publish.
    pub fn validate(&self) -> Result<(), String> {
        if self.mock {
            return Err("evidence.mock must be false — real devnet tx required".to_string());
        }
        if self.mainnet_ready {
            return Err("evidence.mainnet_ready must always be false".to_string());
        }
        if self.tx_signature.is_empty() {
            return Err("tx_signature must not be empty".to_string());
        }
        if self.tx_signature.starts_with("MOCK_SIG_") {
            return Err("tx_signature must not be a mock signature".to_string());
        }
        if self.verified_at_slot == 0 {
            return Err("verified_at_slot must be > 0".to_string());
        }
        if self.amount_lamports == 0 {
            return Err("amount_lamports must be > 0".to_string());
        }
        Ok(())
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

pub fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Build a real (non-mock) `X402PaymentProof` from a confirmed devnet signature.
pub fn build_real_proof(
    req: &X402PaymentRequirement,
    payer_pubkey: [u8; 32],
    real_signature: &str,
) -> X402PaymentProof {
    let requirement_hash = req.requirement_hash();
    let scope_hash = req.scope_hash();
    let mut phh = Sha256::new();
    phh.update(b"dark_null_v1_x402_payment_header");
    phh.update(requirement_hash);
    phh.update(payer_pubkey);
    let payment_header_hash: [u8; 32] = phh.finalize().into();
    X402PaymentProof {
        requirement_hash,
        payer_pubkey,
        tx_signature: real_signature.to_string(),
        payment_header_hash,
        receipt_scope_hash: scope_hash,
        is_mock: false, // real proof — not mock
    }
}

/// Assemble the evidence JSON from a completed real-payment cycle.
pub fn build_evidence_json(
    commit: &str,
    verified: &VerifiedDevnetPayment,
    proof: &X402PaymentProof,
    receipt: &DarkX402Receipt,
) -> X402DevnetEvidenceJson {
    use solana_sdk::pubkey::Pubkey;
    X402DevnetEvidenceJson {
        commit: commit.to_string(),
        network: verified.network.clone(),
        rpc_url: "https://api.devnet.solana.com".to_string(),
        tx_signature: verified.signature.clone(),
        verified_at_slot: verified.slot,
        amount_lamports: verified.amount_lamports,
        pay_to: Pubkey::new_from_array(verified.pay_to).to_string(),
        requirement_hash: hex_encode(&proof.requirement_hash),
        payment_proof_hash: hex_encode(&proof.proof_hash()),
        receipt_id: hex_encode(&receipt.receipt_id()),
        receipt_nullifier: hex_encode(&receipt.receipt_nullifier),
        mock: false,
        mainnet_ready: false,
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use dark_x402_server_mock::{build_mock_proof, MockX402Server, ServerResponse};

    // ── helpers ─────────────────────────────────────────────────────────────

    fn make_verified_payment(pay_to: [u8; 32], amount: u64) -> VerifiedDevnetPayment {
        VerifiedDevnetPayment {
            signature: "5xRealSigDevnetFixture111111111111111111111111111111111111111111111"
                .to_string(),
            slot: 9001,
            payer: Some([0xBB; 32]),
            pay_to,
            amount_lamports: amount,
            network: "solana-devnet".to_string(),
        }
    }

    fn make_strict_server(verifier: Box<dyn PaymentVerifier>) -> StrictX402Server {
        StrictX402Server::new(
            "https://api.darknull.example/resource",
            1_000_000,
            [0xAA; 32],
            verifier,
        )
    }

    // ── Test 1: mock mode (MockX402Server) still passes ──────────────────────

    #[test]
    fn test_mock_mode_still_passes() {
        let server = MockX402Server::new(
            "https://api.darknull.example/resource",
            1_000_000,
            [0xAA; 32],
        );
        let req = server.make_requirement();
        let payer = [0xBB; 32];
        let proof = build_mock_proof(&req, payer);
        let resp = server.request_resource(Some(&proof));
        assert!(
            matches!(resp, ServerResponse::ServicePayload { .. }),
            "MockX402Server must still accept valid mock proofs: {:?}",
            resp
        );
    }

    // ── Test 2: strict mode rejects MOCK_SIG_ prefix ────────────────────────

    #[test]
    fn test_strict_mode_rejects_mock_sig_prefix() {
        let verifier = FixtureVerifier::ok(make_verified_payment([0xAA; 32], 1_000_000));
        let mut server = make_strict_server(Box::new(verifier));
        let req = server.make_requirement();
        let payer = [0xBB; 32];
        // Build real proof (is_mock=false) but with a MOCK_SIG_ signature
        let mut proof = build_real_proof(&req, payer, "MOCK_SIG_should_be_rejected");
        proof.is_mock = false; // explicit — build_real_proof already sets false
        let resp = server.request_resource_strict(Some(&proof));
        assert!(
            matches!(
                resp,
                StrictServerResponse::VerificationError(X402DevnetError::MockSigRejected)
            ),
            "strict mode must reject MOCK_SIG_ prefix: {:?}",
            resp
        );
    }

    // ── Test 3: strict mode rejects is_mock=true ─────────────────────────────

    #[test]
    fn test_strict_mode_rejects_is_mock_true() {
        let verifier = FixtureVerifier::ok(make_verified_payment([0xAA; 32], 1_000_000));
        let mut server = make_strict_server(Box::new(verifier));
        let req = server.make_requirement();
        let payer = [0xBB; 32];
        // build_mock_proof sets is_mock=true
        let mock_proof = build_mock_proof(&req, payer);
        assert!(
            mock_proof.is_mock,
            "sanity: mock proof must have is_mock=true"
        );
        let resp = server.request_resource_strict(Some(&mock_proof));
        assert!(
            matches!(
                resp,
                StrictServerResponse::VerificationError(X402DevnetError::MockSigRejected)
            ),
            "strict mode must reject is_mock=true proofs: {:?}",
            resp
        );
    }

    // ── Test 4: strict mode rejects wrong pay_to ─────────────────────────────

    #[test]
    fn test_strict_mode_rejects_wrong_pay_to() {
        // Fixture payment has pay_to=[0xCC;32] but server expects [0xAA;32]
        let wrong_pay_to = [0xCC; 32];
        let verifier = FixtureVerifier::ok(make_verified_payment(wrong_pay_to, 1_000_000));
        let mut server = make_strict_server(Box::new(verifier));
        let req = server.make_requirement();
        let payer = [0xBB; 32];
        let proof = build_real_proof(
            &req,
            payer,
            "5xGoodSig11111111111111111111111111111111111111111111111111111111111111",
        );
        let resp = server.request_resource_strict(Some(&proof));
        assert!(
            matches!(
                resp,
                StrictServerResponse::VerificationError(X402DevnetError::WrongPayTo { .. })
            ),
            "strict mode must reject wrong pay_to: {:?}",
            resp
        );
    }

    // ── Test 5: strict mode rejects underpayment ─────────────────────────────

    #[test]
    fn test_strict_mode_rejects_underpayment() {
        // Only 500_000 lamports but server requires 1_000_000
        let verifier = FixtureVerifier::ok(make_verified_payment([0xAA; 32], 500_000));
        let mut server = make_strict_server(Box::new(verifier));
        let req = server.make_requirement();
        let payer = [0xBB; 32];
        let proof = build_real_proof(
            &req,
            payer,
            "5xGoodSig22222222222222222222222222222222222222222222222222222222222222",
        );
        let resp = server.request_resource_strict(Some(&proof));
        assert!(
            matches!(
                resp,
                StrictServerResponse::VerificationError(X402DevnetError::Underpayment { .. })
            ),
            "strict mode must reject underpayment: {:?}",
            resp
        );
    }

    // ── Test 6a: strict mode rejects tx not found ────────────────────────────

    #[test]
    fn test_strict_mode_rejects_tx_not_found() {
        let verifier = FixtureVerifier::tx_not_found();
        let mut server = make_strict_server(Box::new(verifier));
        let req = server.make_requirement();
        let payer = [0xBB; 32];
        let proof = build_real_proof(
            &req,
            payer,
            "5xGoodSig33333333333333333333333333333333333333333333333333333333333333",
        );
        let resp = server.request_resource_strict(Some(&proof));
        assert!(
            matches!(
                resp,
                StrictServerResponse::VerificationError(X402DevnetError::TxNotFound)
            ),
            "strict mode must reject TxNotFound: {:?}",
            resp
        );
    }

    // ── Test 6b: strict mode rejects failed tx ───────────────────────────────

    #[test]
    fn test_strict_mode_rejects_tx_failed() {
        let verifier = FixtureVerifier::tx_failed();
        let mut server = make_strict_server(Box::new(verifier));
        let req = server.make_requirement();
        let payer = [0xBB; 32];
        let proof = build_real_proof(
            &req,
            payer,
            "5xGoodSig44444444444444444444444444444444444444444444444444444444444444",
        );
        let resp = server.request_resource_strict(Some(&proof));
        assert!(
            matches!(
                resp,
                StrictServerResponse::VerificationError(X402DevnetError::TxFailed(_))
            ),
            "strict mode must reject TxFailed: {:?}",
            resp
        );
    }

    // ── Test 7: strict mode accepts fixture VerifiedDevnetPayment ────────────

    #[test]
    fn test_strict_mode_accepts_fixture_verified_payment() {
        let verifier = FixtureVerifier::ok(make_verified_payment([0xAA; 32], 1_000_000));
        let mut server = make_strict_server(Box::new(verifier));
        let req = server.make_requirement();
        let payer = [0xBB; 32];
        let proof = build_real_proof(
            &req,
            payer,
            "5xGoodSig55555555555555555555555555555555555555555555555555555555555555",
        );
        let resp = server.request_resource_strict(Some(&proof));
        if let StrictServerResponse::ServicePayload {
            receipt, verified, ..
        } = resp
        {
            assert!(!receipt.is_mock, "strict receipt must have is_mock=false");
            assert_eq!(verified.slot, 9001);
            assert_eq!(verified.amount_lamports, 1_000_000);
        } else {
            panic!("expected ServicePayload, got: {:?}", resp);
        }
    }

    // ── Test 8: evidence JSON validates schema ────────────────────────────────

    #[test]
    fn test_evidence_json_schema_validation() {
        let valid = X402DevnetEvidenceJson {
            commit: "66765c973f0b1a9ba0a3ee7bdee87d4f85b6d186".to_string(),
            network: "solana-devnet".to_string(),
            rpc_url: "https://api.devnet.solana.com".to_string(),
            tx_signature: "5xRealSigABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefg".to_string(),
            verified_at_slot: 9001,
            amount_lamports: 1_000_000,
            pay_to: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoe".to_string(),
            requirement_hash: "abcdef01234567890123456789012345678901234567890123456789abcdef01"
                .to_string(),
            payment_proof_hash: "12345678".to_string(),
            receipt_id: "deadbeef".to_string(),
            receipt_nullifier: "cafebabe".to_string(),
            mock: false,
            mainnet_ready: false,
        };
        assert!(
            valid.validate().is_ok(),
            "valid evidence must pass: {:?}",
            valid.validate()
        );

        // mock=true must fail
        let mut bad = valid.clone();
        bad.mock = true;
        assert!(bad.validate().is_err(), "mock=true must fail validation");

        // mainnet_ready=true must fail
        let mut bad2 = valid.clone();
        bad2.mainnet_ready = true;
        assert!(
            bad2.validate().is_err(),
            "mainnet_ready=true must fail validation"
        );

        // MOCK_SIG_ must fail
        let mut bad3 = valid.clone();
        bad3.tx_signature = "MOCK_SIG_fake123".to_string();
        assert!(
            bad3.validate().is_err(),
            "MOCK_SIG_ signature must fail validation"
        );

        // zero slot must fail
        let mut bad4 = valid.clone();
        bad4.verified_at_slot = 0;
        assert!(bad4.validate().is_err(), "slot=0 must fail validation");
    }

    // ── Test 9: no raw resource URL stored in receipt ────────────────────────

    #[test]
    fn test_no_raw_url_in_strict_receipt() {
        let verifier = FixtureVerifier::ok(make_verified_payment([0xAA; 32], 1_000_000));
        let mut server = make_strict_server(Box::new(verifier));
        let req = server.make_requirement();
        let payer = [0xBB; 32];
        let proof = build_real_proof(
            &req,
            payer,
            "5xGoodSig66666666666666666666666666666666666666666666666666666666666666",
        );
        let resp = server.request_resource_strict(Some(&proof));
        if let StrictServerResponse::ServicePayload { receipt, .. } = resp {
            let json = serde_json::to_string(&receipt).unwrap();
            assert!(
                !json.contains("api.darknull.example"),
                "raw resource URL must not appear in serialized receipt JSON: {}",
                json
            );
            // All hash fields are byte arrays — receipt has no String fields
            assert!(
                !json.contains("http"),
                "receipt JSON must not contain any URL: {}",
                json
            );
        } else {
            panic!("expected ServicePayload: {:?}", resp);
        }
    }

    // ── Extended tests ─────────────────────────────────────────────────────────

    #[test]
    fn test_fixture_mock_sig_rejected() {
        let verifier = FixtureVerifier::ok(make_verified_payment([0xAA; 32], 1_000_000));
        let result = verifier.verify_transfer("MOCK_SIG_anything", &[0xAA; 32], 1_000_000);
        assert!(matches!(result, Err(X402DevnetError::MockSigRejected)));
    }

    #[test]
    fn test_evidence_mainnet_ready_false() {
        let e = X402DevnetEvidenceJson {
            commit: "abc".to_string(),
            network: "solana-devnet".to_string(),
            rpc_url: "https://api.devnet.solana.com".to_string(),
            tx_signature: "5xRealSig111".to_string(),
            verified_at_slot: 1,
            amount_lamports: 1_000_000,
            pay_to: "AAAA".to_string(),
            requirement_hash: "aa".to_string(),
            payment_proof_hash: "bb".to_string(),
            receipt_id: "cc".to_string(),
            receipt_nullifier: "dd".to_string(),
            mock: false,
            mainnet_ready: false,
        };
        assert!(!e.mainnet_ready);
    }

    #[test]
    fn test_hex_encode_nonempty() {
        let h = hex_encode(&[0x01u8; 32]);
        assert!(!h.is_empty());
        assert_eq!(h.len(), 64);
    }

    #[test]
    fn test_verified_payment_slot_field() {
        let payment = make_verified_payment([0xAA; 32], 1_000_000);
        assert_eq!(payment.slot, 9001);
        assert_eq!(payment.amount_lamports, 1_000_000);
    }

    #[test]
    fn test_request_resource_no_proof_returns_requirement() {
        let verifier = FixtureVerifier::ok(make_verified_payment([0xAA; 32], 1_000_000));
        let mut server = make_strict_server(Box::new(verifier));
        let resp = server.request_resource_strict(None);
        assert!(
            matches!(resp, StrictServerResponse::PaymentRequired(_)),
            "no proof must return PaymentRequired: {:?}",
            resp
        );
    }

    // ── Test 10: replay rejected after first success ──────────────────────────

    #[test]
    fn test_strict_replay_rejected() {
        let verifier = FixtureVerifier::ok(make_verified_payment([0xAA; 32], 1_000_000));
        let mut server = make_strict_server(Box::new(verifier));
        let req = server.make_requirement();
        let payer = [0xBB; 32];
        let proof = build_real_proof(
            &req,
            payer,
            "5xGoodSig77777777777777777777777777777777777777777777777777777777777777",
        );

        // First request must succeed
        let resp1 = server.request_resource_strict(Some(&proof));
        assert!(
            matches!(resp1, StrictServerResponse::ServicePayload { .. }),
            "first strict request must succeed: {:?}",
            resp1
        );

        // Identical proof (same requirement hash, same payer) must be replayed
        let proof2 = build_real_proof(
            &req,
            payer,
            "5xGoodSig77777777777777777777777777777777777777777777777777777777777777",
        );
        let resp2 = server.request_resource_strict(Some(&proof2));
        assert!(
            matches!(resp2, StrictServerResponse::X402Error(X402Error::Replay)),
            "second strict request must be rejected as replay: {:?}",
            resp2
        );
    }
}
