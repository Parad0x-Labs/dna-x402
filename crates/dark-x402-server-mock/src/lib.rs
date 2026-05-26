// MOCK SERVER — no real network, no real Solana tx verification
// All payments are simulated. is_mock=true on all receipts.
// Do not use in production.

use dark_x402_core::*;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub struct MockX402Server {
    pub resource_path: String,
    pub amount_lamports: u64,
    pub pay_to: [u8; 32],
    pub network: String,
    redeemed_replay_keys: HashSet<[u8; 32]>,
    current_slot: u64,
}

#[derive(Debug, Clone)]
pub enum ServerResponse {
    PaymentRequired(X402PaymentRequirement),
    ServicePayload {
        data: Vec<u8>,
        receipt: DarkX402Receipt,
    },
    Error(X402Error),
}

impl MockX402Server {
    pub fn new(resource_path: &str, amount_lamports: u64, pay_to: [u8; 32]) -> Self {
        Self {
            resource_path: resource_path.to_string(),
            amount_lamports,
            pay_to,
            network: "solana-devnet".to_string(),
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

    pub fn request_resource(&self, payment_proof: Option<&X402PaymentProof>) -> ServerResponse {
        match payment_proof {
            None => ServerResponse::PaymentRequired(self.make_requirement()),
            Some(proof) => {
                let req = self.make_requirement();
                // Check replay
                let replay_key = derive_replay_key(&req, &proof.payer_pubkey);
                if self.redeemed_replay_keys.contains(&replay_key) {
                    return ServerResponse::Error(X402Error::Replay);
                }
                // Mint receipt
                let payload = b"dark_null_service_payload";
                match mint_receipt_note_after_payment(&req, proof, payload, self.current_slot) {
                    Ok(receipt) => ServerResponse::ServicePayload {
                        data: payload.to_vec(),
                        receipt,
                    },
                    Err(e) => ServerResponse::Error(e),
                }
            }
        }
    }

    pub fn mark_redeemed(&mut self, replay_key: [u8; 32]) {
        self.redeemed_replay_keys.insert(replay_key);
    }

    pub fn advance_slot(&mut self, slots: u64) {
        self.current_slot += slots;
    }
}

// Build a valid mock proof for a given requirement and payer
pub fn build_mock_proof(req: &X402PaymentRequirement, payer_pubkey: [u8; 32]) -> X402PaymentProof {
    let requirement_hash = req.requirement_hash();
    let scope_hash = req.scope_hash();
    let sig = format!("MOCK_SIG_{}", hex_short(&requirement_hash));
    let mut phh = Sha256::new();
    phh.update(b"dark_null_v1_x402_payment_header");
    phh.update(requirement_hash);
    phh.update(payer_pubkey);
    let payment_header_hash: [u8; 32] = phh.finalize().into();
    X402PaymentProof {
        requirement_hash,
        payer_pubkey,
        tx_signature: sig,
        payment_header_hash,
        receipt_scope_hash: scope_hash,
        is_mock: true,
    }
}

fn hex_short(bytes: &[u8]) -> String {
    bytes[..4].iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_server() -> MockX402Server {
        MockX402Server::new(
            "https://api.darknull.example/resource",
            1_000_000,
            [0xAA; 32],
        )
    }

    fn make_payer() -> [u8; 32] {
        [0xBB; 32]
    }

    // 1. Server returns PaymentRequired when no proof given
    #[test]
    fn test_server_returns_payment_required_on_no_proof() {
        let server = make_server();
        let resp = server.request_resource(None);
        matches!(resp, ServerResponse::PaymentRequired(_));
        if let ServerResponse::PaymentRequired(req) = resp {
            assert_eq!(req.amount_lamports, 1_000_000);
            assert_eq!(req.scheme, "exact");
            assert_eq!(req.network, "solana-devnet");
        } else {
            panic!("expected PaymentRequired");
        }
    }

    // 2. Server accepts valid mock proof
    #[test]
    fn test_server_accepts_valid_mock_proof() {
        let server = make_server();
        let req = server.make_requirement();
        let payer = make_payer();
        let proof = build_mock_proof(&req, payer);
        let resp = server.request_resource(Some(&proof));
        if let ServerResponse::ServicePayload { data, receipt } = resp {
            assert_eq!(data, b"dark_null_service_payload");
            assert!(receipt.is_mock);
        } else {
            panic!("expected ServicePayload, got {:?}", resp);
        }
    }

    // 3. Server rejects wrong requirement hash
    #[test]
    fn test_server_rejects_wrong_requirement_hash() {
        let server = make_server();
        let req = server.make_requirement();
        let payer = make_payer();
        let mut proof = build_mock_proof(&req, payer);
        proof.requirement_hash = [0xFF; 32]; // tamper
        let resp = server.request_resource(Some(&proof));
        if let ServerResponse::Error(e) = resp {
            assert_eq!(e, X402Error::RequirementHashMismatch);
        } else {
            panic!("expected Error, got {:?}", resp);
        }
    }

    // 4. Server rejects replay — mark_redeemed then try again
    #[test]
    fn test_server_rejects_replay() {
        let mut server = make_server();
        let req = server.make_requirement();
        let payer = make_payer();
        let proof = build_mock_proof(&req, payer);
        // First request succeeds
        let resp1 = server.request_resource(Some(&proof));
        assert!(matches!(resp1, ServerResponse::ServicePayload { .. }));
        // Mark replay key as redeemed
        let replay_key = derive_replay_key(&req, &payer);
        server.mark_redeemed(replay_key);
        // Second request with same proof must be rejected
        let resp2 = server.request_resource(Some(&proof));
        if let ServerResponse::Error(e) = resp2 {
            assert_eq!(e, X402Error::Replay);
        } else {
            panic!("expected Replay error, got {:?}", resp2);
        }
    }

    // 5. Server rejects expired requirement
    #[test]
    fn test_server_rejects_expired_requirement() {
        let mut server = make_server();
        // Capture requirement at slot 1000 (expires at 1100)
        let old_req = server.make_requirement();
        let payer = make_payer();
        // Build proof against old requirement
        let proof = build_mock_proof(&old_req, payer);
        // Advance slot past expiry
        server.advance_slot(200); // now at slot 1200, req expired at 1100
                                  // Server now makes a new requirement (different hash), so proof hash mismatches
                                  // The mint function also checks is_expired with current_slot
        let resp = server.request_resource(Some(&proof));
        // Either RequirementHashMismatch (different nonce → different hash) or RequirementExpired
        if let ServerResponse::Error(e) = resp {
            assert!(
                e == X402Error::RequirementHashMismatch || e == X402Error::RequirementExpired,
                "unexpected error: {:?}",
                e
            );
        } else {
            panic!("expected Error for expired requirement, got {:?}", resp);
        }
    }

    // 6. Server rejects empty signature
    #[test]
    fn test_server_rejects_empty_signature() {
        let server = make_server();
        let req = server.make_requirement();
        let payer = make_payer();
        let mut proof = build_mock_proof(&req, payer);
        proof.tx_signature = String::new();
        // Rebuild requirement_hash correctly so it passes hash check but fails sig check
        proof.requirement_hash = req.requirement_hash();
        let resp = server.request_resource(Some(&proof));
        if let ServerResponse::Error(e) = resp {
            assert_eq!(e, X402Error::EmptyTxSignature);
        } else {
            panic!("expected EmptyTxSignature error, got {:?}", resp);
        }
    }

    // 7. Server payload is deterministic for same resource
    #[test]
    fn test_server_payload_is_deterministic() {
        let server = make_server();
        let req = server.make_requirement();
        let payer = make_payer();
        let proof = build_mock_proof(&req, payer);
        let resp1 = server.request_resource(Some(&proof));
        let resp2 = server.request_resource(Some(&proof));
        if let (
            ServerResponse::ServicePayload { data: d1, .. },
            ServerResponse::ServicePayload { data: d2, .. },
        ) = (resp1, resp2)
        {
            assert_eq!(d1, d2);
        } else {
            panic!("expected two ServicePayload responses");
        }
    }

    // 8. Receipt is_mock flagged true
    #[test]
    fn test_server_receipt_is_mock_flagged() {
        let server = make_server();
        let req = server.make_requirement();
        let payer = make_payer();
        let proof = build_mock_proof(&req, payer);
        let resp = server.request_resource(Some(&proof));
        if let ServerResponse::ServicePayload { receipt, .. } = resp {
            assert!(receipt.is_mock, "receipt.is_mock must be true in mock mode");
        } else {
            panic!("expected ServicePayload");
        }
    }
}
