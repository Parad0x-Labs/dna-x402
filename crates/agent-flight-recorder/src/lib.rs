use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Private helper
// ---------------------------------------------------------------------------

fn sha256_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for input in inputs {
        h.update(input);
    }
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// One recorded AI agent action.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FlightReceipt {
    pub agent_id_hash: [u8; 32],
    pub model_output_hash: [u8; 32],
    pub permission_hash: [u8; 32],
    pub risk_policy_hash: [u8; 32],
    pub spend_receipt_hash: [u8; 32],
    pub timestamp_slot: u64,
    pub previous_flight_hash: [u8; 32], // [0;32] for first in chain
    pub kill_switch_state_hash: [u8; 32],
}

impl FlightReceipt {
    /// SHA256("dark_null_v1_flight_receipt" || all fields in order)
    pub fn compute_hash(&self) -> [u8; 32] {
        sha256_domain(
            b"dark_null_v1_flight_receipt",
            &[
                &self.agent_id_hash,
                &self.model_output_hash,
                &self.permission_hash,
                &self.risk_policy_hash,
                &self.spend_receipt_hash,
                &self.timestamp_slot.to_le_bytes(),
                &self.previous_flight_hash,
                &self.kill_switch_state_hash,
            ],
        )
    }
}

/// A sequence of linked flight receipts.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FlightChain {
    pub receipts: Vec<FlightReceipt>,
}

/// Public view of a flight receipt — hides strategy.
/// Contains only: agent_id_hash, timestamp_slot, kill_switch_state_hash.
/// Everything else is redacted.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RedactedFlightView {
    pub agent_id_hash: [u8; 32],
    pub timestamp_slot: u64,
    pub kill_switch_state_hash: [u8; 32],
    pub flight_hash: [u8; 32], // hash of the original receipt (for verification)
}

/// Private reveal that proves the full action for a given chain root.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PrivateFlightReveal {
    pub chain_root: [u8; 32],
    pub receipts: Vec<FlightReceipt>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlightError {
    ChainBroken { at_index: usize },
    WrongPermission { expected: [u8; 32], found: [u8; 32] },
    EmptyChain,
    RevealMismatch,
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/// Compute the hash of a complete FlightChain (the root of all receipts).
/// SHA256("dark_null_v1_flight_chain" || hash_of_receipt_0 || hash_of_receipt_1 || ...)
pub fn chain_root(chain: &FlightChain) -> [u8; 32] {
    let hashes: Vec<[u8; 32]> = chain.receipts.iter().map(|r| r.compute_hash()).collect();
    let refs: Vec<&[u8]> = hashes.iter().map(|h| h.as_ref()).collect();
    sha256_domain(b"dark_null_v1_flight_chain", &refs)
}

/// Verify that each receipt's previous_flight_hash links correctly to the prior receipt.
/// First receipt must have previous_flight_hash = [0;32].
pub fn chain_valid(chain: &FlightChain) -> Result<(), FlightError> {
    if chain.receipts.is_empty() {
        return Err(FlightError::EmptyChain);
    }

    // First receipt must start with zero hash
    if chain.receipts[0].previous_flight_hash != [0u8; 32] {
        return Err(FlightError::ChainBroken { at_index: 0 });
    }

    // Each subsequent receipt's previous_flight_hash must equal the hash of the prior receipt
    for i in 1..chain.receipts.len() {
        let expected_prev = chain.receipts[i - 1].compute_hash();
        if chain.receipts[i].previous_flight_hash != expected_prev {
            return Err(FlightError::ChainBroken { at_index: i });
        }
    }

    Ok(())
}

/// Redact a receipt to its public view.
pub fn redact(receipt: &FlightReceipt) -> RedactedFlightView {
    RedactedFlightView {
        agent_id_hash: receipt.agent_id_hash,
        timestamp_slot: receipt.timestamp_slot,
        kill_switch_state_hash: receipt.kill_switch_state_hash,
        flight_hash: receipt.compute_hash(),
    }
}

/// Verify that a private reveal matches the expected chain root.
/// Re-computes chain_root from reveal.receipts and compares to reveal.chain_root.
pub fn verify_private_reveal(reveal: &PrivateFlightReveal) -> Result<(), FlightError> {
    let recomputed_chain = FlightChain {
        receipts: reveal.receipts.clone(),
    };
    let recomputed_root = chain_root(&recomputed_chain);
    if recomputed_root != reveal.chain_root {
        return Err(FlightError::RevealMismatch);
    }
    Ok(())
}

/// Verify all receipts in a chain used the same permission_hash.
/// Returns Err(WrongPermission) if any receipt has a different permission_hash.
pub fn verify_chain_permission(
    chain: &FlightChain,
    expected_permission_hash: &[u8; 32],
) -> Result<(), FlightError> {
    for receipt in &chain.receipts {
        if &receipt.permission_hash != expected_permission_hash {
            return Err(FlightError::WrongPermission {
                expected: *expected_permission_hash,
                found: receipt.permission_hash,
            });
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_receipt(slot: u64, prev: [u8; 32], perm: [u8; 32]) -> FlightReceipt {
        FlightReceipt {
            agent_id_hash: [0xABu8; 32],
            model_output_hash: [0x01u8; 32],
            permission_hash: perm,
            risk_policy_hash: [0x02u8; 32],
            spend_receipt_hash: [0x03u8; 32],
            timestamp_slot: slot,
            previous_flight_hash: prev,
            kill_switch_state_hash: [0x04u8; 32],
        }
    }

    fn make_chain(n: usize, perm: [u8; 32]) -> FlightChain {
        let mut receipts = vec![];
        let mut prev = [0u8; 32];
        for i in 0..n {
            let r = make_receipt(1000 + i as u64, prev, perm);
            prev = r.compute_hash();
            receipts.push(r);
        }
        FlightChain { receipts }
    }

    #[test]
    fn test_chain_valid_for_correct_chain() {
        let perm = [0xCCu8; 32];
        let chain = make_chain(3, perm);
        assert!(chain_valid(&chain).is_ok());
    }

    #[test]
    fn test_chain_broken_by_tamper() {
        let perm = [0xCCu8; 32];
        let mut chain = make_chain(3, perm);
        // Tamper the middle receipt's model_output_hash
        chain.receipts[1].model_output_hash = [0xFFu8; 32];
        let result = chain_valid(&chain);
        // Index 2 will fail because receipt[1]'s hash changed, breaking the link to receipt[2]
        assert!(matches!(
            result,
            Err(FlightError::ChainBroken { at_index: 2 })
        ));
    }

    #[test]
    fn test_wrong_permission_rejected() {
        let perm = [0xCCu8; 32];
        let mut chain = make_chain(3, perm);
        // Give one receipt a different permission_hash (rebuild chain so it's still structurally valid)
        chain.receipts[1].permission_hash = [0xDDu8; 32];
        let result = verify_chain_permission(&chain, &perm);
        assert!(matches!(result, Err(FlightError::WrongPermission { .. })));
    }

    #[test]
    fn test_model_output_hash_bound() {
        let perm = [0xCCu8; 32];
        let r1 = make_receipt(1000, [0u8; 32], perm);
        let mut r2 = make_receipt(1000, [0u8; 32], perm);
        r2.model_output_hash = [0xFFu8; 32];
        assert_ne!(r1.compute_hash(), r2.compute_hash());
    }

    #[test]
    fn test_kill_switch_state_bound() {
        let perm = [0xCCu8; 32];
        let r1 = make_receipt(1000, [0u8; 32], perm);
        let mut r2 = make_receipt(1000, [0u8; 32], perm);
        r2.kill_switch_state_hash = [0xEEu8; 32];
        assert_ne!(r1.compute_hash(), r2.compute_hash());
    }

    #[test]
    fn test_redacted_view_hides_strategy() {
        let perm = [0xCCu8; 32];
        let receipt = make_receipt(1000, [0u8; 32], perm);
        let view = redact(&receipt);
        let json = serde_json::to_string(&view).unwrap();
        // The redacted view must NOT contain model_output_hash or spend_receipt_hash field names
        assert!(
            !json.contains("model_output_hash"),
            "model_output_hash should not appear in redacted view JSON"
        );
        assert!(
            !json.contains("spend_receipt_hash"),
            "spend_receipt_hash should not appear in redacted view JSON"
        );
        // But it should still contain the fields we want
        assert!(json.contains("agent_id_hash"));
        assert!(json.contains("kill_switch_state_hash"));
        assert!(json.contains("flight_hash"));
    }

    #[test]
    fn test_private_reveal_verifies_full_action() {
        let perm = [0xCCu8; 32];
        let chain = make_chain(3, perm);
        let root = chain_root(&chain);
        let reveal = PrivateFlightReveal {
            chain_root: root,
            receipts: chain.receipts.clone(),
        };
        assert!(verify_private_reveal(&reveal).is_ok());
    }

    #[test]
    fn test_tampered_reveal_fails() {
        let perm = [0xCCu8; 32];
        let chain = make_chain(3, perm);
        let root = chain_root(&chain);
        let mut reveal = PrivateFlightReveal {
            chain_root: root,
            receipts: chain.receipts.clone(),
        };
        // Tamper one receipt in the reveal
        reveal.receipts[0].model_output_hash = [0xFFu8; 32];
        let result = verify_private_reveal(&reveal);
        assert!(matches!(result, Err(FlightError::RevealMismatch)));
    }

    #[test]
    fn test_empty_chain_errors() {
        let chain = FlightChain { receipts: vec![] };
        let result = chain_valid(&chain);
        assert!(matches!(result, Err(FlightError::EmptyChain)));
    }
}
