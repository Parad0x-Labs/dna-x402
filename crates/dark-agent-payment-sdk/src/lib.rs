// dark-agent-payment-sdk — glue crate wiring agent capability with shielded x402 payment.
// Closes the loop between agent-shielded-capsule and the receipt commitment scheme.
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

use agent_shielded_capsule::{
    create_spend_proof, AgentCapability, CapsuleError, ShieldedSpendProof,
};

// ── Local payment types (self-contained, no external x402 stub dependency) ──

/// Plain x402 payment record — buyer_hash is SHA256 of buyer identity, never raw.
#[derive(Debug, Clone)]
pub struct PlainX402Payment {
    pub buyer_hash: [u8; 32],
    pub amount_lamports: u64,
    pub service_hash: [u8; 32],
    pub payment_tx_hash: [u8; 32],
    pub slot: u64,
}

/// Shielded receipt: commitment_hash hides buyer identity; receipt_hash is public anchor.
#[derive(Debug, Clone, PartialEq)]
pub struct ShieldedPaymentReceipt {
    /// SHA256("receipt-v1" || payment_tx_hash || commitment_hash)
    pub receipt_hash: [u8; 32],
    /// SHA256("commitment-v1" || buyer_hash || amount_le8 || nonce) — hides buyer
    pub commitment_hash: [u8; 32],
}

/// Error variants for shielded payment operations.
#[derive(Debug, Clone, PartialEq)]
pub enum ShieldedX402Error {
    InvalidPayment,
    NonceMismatch,
}

/// Issue a shielded receipt: commitment hides buyer behind nonce.
pub fn issue_shielded_receipt(
    payment: &PlainX402Payment,
    nonce: &[u8; 32],
) -> ShieldedPaymentReceipt {
    // commitment_hash = SHA256("commitment-v1" || buyer_hash || amount_le8 || nonce)
    let mut h = Sha256::new();
    h.update(b"commitment-v1");
    h.update(payment.buyer_hash);
    h.update(payment.amount_lamports.to_le_bytes());
    h.update(nonce);
    let commitment_hash: [u8; 32] = h.finalize().into();

    // receipt_hash = SHA256("receipt-v1" || payment_tx_hash || commitment_hash)
    let mut h = Sha256::new();
    h.update(b"receipt-v1");
    h.update(payment.payment_tx_hash);
    h.update(commitment_hash);
    let receipt_hash: [u8; 32] = h.finalize().into();

    ShieldedPaymentReceipt {
        receipt_hash,
        commitment_hash,
    }
}

// ── hex helper (no external hex crate) ─────────────────────────────────────

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Public types ────────────────────────────────────────────────────────────

/// A fully assembled agent payment: capability + shielded payment.
#[derive(Debug)]
pub struct AgentPaymentSession {
    /// SHA256("agent-session-v1" || capability_hash || receipt_hash)
    pub session_id: [u8; 32],
    pub capability: AgentCapability,
    pub spend_proof: ShieldedSpendProof,
    pub receipt: ShieldedPaymentReceipt,
    /// Always false — devnet design only.
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum AgentPaymentError {
    CapsuleError(CapsuleError),
    PaymentError(ShieldedX402Error),
    FeeCapExceeded { cap: u64, attempted: u64 },
    SessionAlreadyUsed,
}

pub struct AgentPaymentConfig {
    /// Lamports cap per single payment.
    pub max_single_payment: u64,
    pub allowed_scopes: Vec<String>,
}

// ── session_id computation (shared between new_session and verify_session) ─

fn compute_session_id(capability_hash: &[u8; 32], receipt_hash: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"agent-session-v1");
    h.update(capability_hash);
    h.update(receipt_hash);
    h.finalize().into()
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Build a new AgentPaymentSession.
///
/// Steps:
/// 1. Guard payment.amount_lamports <= capability.fee_cap_lamports.
/// 2. create_spend_proof from agent-shielded-capsule.
/// 3. issue_shielded_receipt from dark-private-x402.
/// 4. session_id = SHA256("agent-session-v1" || capability_hash || receipt_hash).
pub fn new_session(
    capability: AgentCapability,
    payment: PlainX402Payment,
    agent_secret: &[u8; 32],
    nonce: &[u8; 32],
) -> Result<AgentPaymentSession, AgentPaymentError> {
    // Step 1 — enforce fee cap before creating any proof.
    if payment.amount_lamports > capability.fee_cap_lamports {
        return Err(AgentPaymentError::FeeCapExceeded {
            cap: capability.fee_cap_lamports,
            attempted: payment.amount_lamports,
        });
    }

    // Step 2 — create spend proof (uses agent_secret as the recipient_hash input
    // so the proof is bound to this agent without exposing identity).
    let spend_proof = create_spend_proof(
        &capability,
        payment.amount_lamports,
        agent_secret, // treated as recipient_hash — never stored raw
        payment.slot,
        nonce,
    )
    .map_err(AgentPaymentError::CapsuleError)?;

    // Step 3 — issue shielded receipt.
    let receipt = issue_shielded_receipt(&payment, nonce);

    // Step 4 — derive stable session_id from the two public hashes.
    let session_id = compute_session_id(&capability.capability_hash, &receipt.receipt_hash);

    Ok(AgentPaymentSession {
        session_id,
        capability,
        spend_proof,
        receipt,
        mainnet_ready: false,
    })
}

/// Return a privacy-safe JSON evidence blob.
///
/// Emits: session_id (hex), receipt_hash (hex), scope_hash (hex), mainnet_ready.
/// Does NOT include raw agent_id, wallet address, or secret bytes.
pub fn session_evidence_json(session: &AgentPaymentSession) -> String {
    serde_json::json!({
        "session_id":     hex_encode(&session.session_id),
        "receipt_hash":   hex_encode(&session.receipt.receipt_hash),
        "scope_hash":     hex_encode(&session.capability.service_scope_hash),
        "mainnet_ready":  session.mainnet_ready,
    })
    .to_string()
}

/// Verify session integrity by recomputing session_id from the stored hashes.
pub fn verify_session(session: &AgentPaymentSession) -> bool {
    let expected = compute_session_id(
        &session.capability.capability_hash,
        &session.receipt.receipt_hash,
    );
    expected == session.session_id
}

/// Return true if `scope` is listed in `config.allowed_scopes`.
pub fn allowed_scope(config: &AgentPaymentConfig, scope: &str) -> bool {
    config.allowed_scopes.iter().any(|s| s == scope)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use agent_shielded_capsule::create_capability;

    // ── Helpers ───────────────────────────────────────────────────────────

    fn make_capability(fee_cap: u64) -> AgentCapability {
        create_capability(
            b"test-agent-id",
            b"solana-rpc",
            fee_cap,
            9999, // expiry_slot well in the future
            &[0x42; 32],
        )
    }

    fn make_payment(amount: u64) -> PlainX402Payment {
        PlainX402Payment {
            buyer_hash: [0xAA; 32],
            amount_lamports: amount,
            service_hash: [0xBB; 32],
            payment_tx_hash: [0xCC; 32],
            slot: 100, // within capability expiry
        }
    }

    const AGENT_SECRET: [u8; 32] = [0x55; 32];
    const NONCE: [u8; 32] = [0x77; 32];

    // ── Test 1: happy path ────────────────────────────────────────────────

    #[test]
    fn test_session_happy_path() {
        let cap = make_capability(1_000_000);
        let payment = make_payment(500_000);
        let result = new_session(cap, payment, &AGENT_SECRET, &NONCE);
        assert!(result.is_ok(), "expected Ok, got {:?}", result.err());
        let session = result.unwrap();
        assert!(!session.mainnet_ready, "mainnet_ready must always be false");
    }

    // ── Test 2: fee cap exceeded ──────────────────────────────────────────

    #[test]
    fn test_fee_cap_exceeded() {
        let cap = make_capability(500_000);
        let payment = make_payment(500_001); // one lamport over cap
        let result = new_session(cap, payment, &AGENT_SECRET, &NONCE);
        match result {
            Err(AgentPaymentError::FeeCapExceeded { cap, attempted }) => {
                assert_eq!(cap, 500_000);
                assert_eq!(attempted, 500_001);
            }
            other => panic!("expected FeeCapExceeded, got {:?}", other),
        }
    }

    // ── Test 3: session_id is deterministic ───────────────────────────────

    #[test]
    fn test_session_id_deterministic() {
        let cap_a = make_capability(1_000_000);
        let cap_b = make_capability(1_000_000);
        let payment_a = make_payment(100_000);
        let payment_b = make_payment(100_000);

        let session_a = new_session(cap_a, payment_a, &AGENT_SECRET, &NONCE).unwrap();
        let session_b = new_session(cap_b, payment_b, &AGENT_SECRET, &NONCE).unwrap();

        assert_eq!(
            session_a.session_id, session_b.session_id,
            "same inputs must yield the same session_id"
        );
    }

    // ── Test 4: evidence JSON hides agent_id ─────────────────────────────

    #[test]
    fn test_evidence_hides_agent_id() {
        let cap = make_capability(1_000_000);
        let payment = make_payment(100_000);
        let session = new_session(cap, payment, &AGENT_SECRET, &NONCE).unwrap();
        let json = session_evidence_json(&session);

        // Raw agent_id used in make_capability is b"test-agent-id"
        let raw_agent_id = b"test-agent-id";
        assert!(
            !json.contains("test-agent-id"),
            "JSON must not contain raw agent_id string"
        );
        // Also check hex encoding of raw bytes is absent
        let hex_id = hex_encode(raw_agent_id);
        assert!(
            !json.contains(&hex_id),
            "JSON must not contain hex-encoded raw agent_id"
        );
        // Confirm the expected keys are present
        assert!(json.contains("session_id"));
        assert!(json.contains("receipt_hash"));
        assert!(json.contains("scope_hash"));
        assert!(json.contains("mainnet_ready"));
    }

    // ── Test 5: verify_session passes for a fresh session ─────────────────

    #[test]
    fn test_verify_session_passes() {
        let cap = make_capability(1_000_000);
        let payment = make_payment(200_000);
        let session = new_session(cap, payment, &AGENT_SECRET, &NONCE).unwrap();
        assert!(
            verify_session(&session),
            "verify_session must return true for untampered session"
        );
    }

    // ── Test 6: verify_session fails after session_id mutation ────────────

    #[test]
    fn test_verify_tampered_session_fails() {
        let cap = make_capability(1_000_000);
        let payment = make_payment(200_000);
        let mut session = new_session(cap, payment, &AGENT_SECRET, &NONCE).unwrap();

        // Flip every byte of session_id to simulate tampering.
        for byte in session.session_id.iter_mut() {
            *byte ^= 0xFF;
        }

        assert!(
            !verify_session(&session),
            "verify_session must return false after session_id is tampered"
        );
    }
}
