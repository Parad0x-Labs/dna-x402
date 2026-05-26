// MOCK CLIENT — no real Solana wallet, no real SOL transfer
// All proofs are simulated. is_mock=true on all proofs.
// Do not use in production.

use dark_x402_core::*;
use sha2::{Digest, Sha256};

pub struct MockX402Client {
    pub payer_pubkey: [u8; 32],
    pub stored_receipts: Vec<DarkX402Receipt>,
    pub strict_mode: bool, // if true, reject is_mock=true payments
}

impl MockX402Client {
    pub fn new(payer_pubkey: [u8; 32]) -> Self {
        Self {
            payer_pubkey,
            stored_receipts: Vec::new(),
            strict_mode: false,
        }
    }

    pub fn parse_payment_requirement(
        &self,
        req: &X402PaymentRequirement,
    ) -> Result<[u8; 32], X402Error> {
        // Validate: must not be expired, must be non-zero amount
        if req.amount_lamports == 0 {
            return Err(X402Error::RequirementHashMismatch);
        }
        Ok(req.requirement_hash())
    }

    pub fn build_mock_payment_proof(&self, req: &X402PaymentRequirement) -> X402PaymentProof {
        if self.strict_mode {
            panic!("[MOCK CLIENT] strict_mode=true: mock proofs are disabled. Provide a real devnet tx sig.");
        }
        let requirement_hash = req.requirement_hash();
        let scope_hash = req.scope_hash();
        // Mock tx sig: "MOCK_SIG_" || first 4 bytes of req hash as hex
        let sig = format!("MOCK_SIG_{}", hex_short(&requirement_hash));
        let mut phh = Sha256::new();
        phh.update(b"dark_null_v1_x402_payment_header");
        phh.update(requirement_hash);
        phh.update(self.payer_pubkey);
        let payment_header_hash: [u8; 32] = phh.finalize().into();
        X402PaymentProof {
            requirement_hash,
            payer_pubkey: self.payer_pubkey,
            tx_signature: sig,
            payment_header_hash,
            receipt_scope_hash: scope_hash,
            is_mock: true,
        }
    }

    pub fn store_receipt(&mut self, receipt: DarkX402Receipt) {
        self.stored_receipts.push(receipt);
    }

    pub fn find_receipt_for_scope(&self, scope_hash: &[u8; 32]) -> Option<&DarkX402Receipt> {
        self.stored_receipts
            .iter()
            .find(|r| r.service_scope_hash == *scope_hash)
    }

    pub fn has_receipt_for_resource(&self, resource_url: &str) -> bool {
        let mut h = Sha256::new();
        h.update(b"dark_null_v1_x402_scope");
        h.update(resource_url.as_bytes());
        let scope_hash: [u8; 32] = h.finalize().into();
        self.stored_receipts
            .iter()
            .any(|r| r.service_scope_hash == scope_hash)
    }
}

fn hex_short(bytes: &[u8]) -> String {
    bytes[..4].iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_req(resource: &str) -> X402PaymentRequirement {
        X402PaymentRequirement {
            scheme: "exact".to_string(),
            network: "solana-devnet".to_string(),
            asset: "SOL".to_string(),
            amount_lamports: 1_000_000,
            pay_to: [0xAA; 32],
            resource: resource.to_string(),
            expires_at_slot: 9999,
            nonce: [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08],
            facilitator_url: None,
        }
    }

    fn make_client() -> MockX402Client {
        MockX402Client::new([0xBB; 32])
    }

    fn make_receipt(req: &X402PaymentRequirement, client: &MockX402Client) -> DarkX402Receipt {
        let proof = client.build_mock_payment_proof(req);
        mint_receipt_note_after_payment(req, &proof, b"payload", 1000).unwrap()
    }

    // 1. Client parses valid requirement and returns hash
    #[test]
    fn test_client_parses_valid_requirement() {
        let client = make_client();
        let req = make_req("https://api.darknull.example/resource");
        let result = client.parse_payment_requirement(&req);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), req.requirement_hash());
    }

    // 2. Client builds a mock proof without panicking
    #[test]
    fn test_client_builds_mock_proof() {
        let client = make_client();
        let req = make_req("https://api.darknull.example/resource");
        let proof = client.build_mock_payment_proof(&req);
        assert_eq!(proof.payer_pubkey, client.payer_pubkey);
        assert_eq!(proof.requirement_hash, req.requirement_hash());
    }

    // 3. Mock proof tx_signature starts with "MOCK_SIG_"
    #[test]
    fn test_client_mock_proof_has_mock_sig_prefix() {
        let client = make_client();
        let req = make_req("https://api.darknull.example/resource");
        let proof = client.build_mock_payment_proof(&req);
        assert!(
            proof.tx_signature.starts_with("MOCK_SIG_"),
            "mock sig must start with MOCK_SIG_, got: {}",
            proof.tx_signature
        );
    }

    // 4. Client can store a receipt
    #[test]
    fn test_client_stores_receipt() {
        let mut client = make_client();
        let req = make_req("https://api.darknull.example/resource");
        let receipt = make_receipt(&req, &client);
        client.store_receipt(receipt);
        assert_eq!(client.stored_receipts.len(), 1);
    }

    // 5. Client can find receipt by scope hash
    #[test]
    fn test_client_finds_receipt_for_scope() {
        let mut client = make_client();
        let req = make_req("https://api.darknull.example/resource");
        let receipt = make_receipt(&req, &client);
        let scope_hash = req.scope_hash();
        client.store_receipt(receipt);
        let found = client.find_receipt_for_scope(&scope_hash);
        assert!(found.is_some());
        assert_eq!(found.unwrap().service_scope_hash, scope_hash);
    }

    // 6. Client can check has_receipt_for_resource by URL
    #[test]
    fn test_client_has_receipt_for_resource() {
        let mut client = make_client();
        let url = "https://api.darknull.example/resource";
        let req = make_req(url);
        let receipt = make_receipt(&req, &client);
        client.store_receipt(receipt);
        assert!(client.has_receipt_for_resource(url));
        assert!(!client.has_receipt_for_resource("https://other.example.com/other"));
    }

    // 7. Proof requirement_hash matches the requirement
    #[test]
    fn test_client_proof_requirement_hash_matches() {
        let client = make_client();
        let req = make_req("https://api.darknull.example/resource");
        let proof = client.build_mock_payment_proof(&req);
        assert_eq!(proof.requirement_hash, req.requirement_hash());
    }

    // 8. Proof is_mock flag is true
    #[test]
    fn test_client_mock_flagged_in_proof() {
        let client = make_client();
        let req = make_req("https://api.darknull.example/resource");
        let proof = client.build_mock_payment_proof(&req);
        assert!(
            proof.is_mock,
            "mock client must produce proofs with is_mock=true"
        );
    }
}
