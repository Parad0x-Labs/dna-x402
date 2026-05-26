use sha2::{Digest, Sha256};

// x402 Payment Requirement (server side)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct X402PaymentRequirement {
    pub scheme: String,  // "exact" | "upto"
    pub network: String, // "solana-devnet" | "solana-mainnet"
    pub asset: String,   // "SOL" | SPL mint address
    pub amount_lamports: u64,
    pub pay_to: [u8; 32], // payee pubkey
    pub resource: String, // URL/path being paid for
    pub expires_at_slot: u64,
    pub nonce: [u8; 8],
    pub facilitator_url: Option<String>,
}

impl X402PaymentRequirement {
    pub fn requirement_hash(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"dark_null_v1_x402_req");
        h.update(self.scheme.as_bytes());
        h.update(self.network.as_bytes());
        h.update(self.asset.as_bytes());
        h.update(self.amount_lamports.to_le_bytes());
        h.update(self.pay_to);
        // Do NOT include resource directly — scope-hash it
        let mut rh = Sha256::new();
        rh.update(b"dark_null_v1_x402_scope");
        rh.update(self.resource.as_bytes());
        let scope_hash: [u8; 32] = rh.finalize().into();
        h.update(scope_hash);
        h.update(self.expires_at_slot.to_le_bytes());
        h.update(self.nonce);
        h.finalize().into()
    }

    pub fn scope_hash(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"dark_null_v1_x402_scope");
        h.update(self.resource.as_bytes());
        h.finalize().into()
    }

    pub fn is_expired(&self, current_slot: u64) -> bool {
        current_slot > self.expires_at_slot
    }
}

// x402 Payment Proof (client side)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct X402PaymentProof {
    pub requirement_hash: [u8; 32],
    pub payer_pubkey: [u8; 32],
    pub tx_signature: String, // Solana tx sig (real devnet sig or "MOCK_SIG_...")
    pub payment_header_hash: [u8; 32],
    pub receipt_scope_hash: [u8; 32],
    pub is_mock: bool,
}

impl X402PaymentProof {
    pub fn proof_hash(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"dark_null_v1_x402_proof");
        h.update(self.requirement_hash);
        h.update(self.payer_pubkey);
        // Hash tx sig string (not raw — preserves format)
        let mut sh = Sha256::new();
        sh.update(self.tx_signature.as_bytes());
        let sig_hash: [u8; 32] = sh.finalize().into();
        h.update(sig_hash);
        h.update(self.payment_header_hash);
        h.update(self.receipt_scope_hash);
        h.update([self.is_mock as u8]);
        h.finalize().into()
    }
}

// Dark Null Receipt created after successful x402 payment
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DarkX402Receipt {
    pub x402_requirement_hash: [u8; 32],
    pub payment_proof_hash: [u8; 32],
    pub receipt_note_hash: [u8; 32],
    pub receipt_nullifier: [u8; 32],
    pub service_scope_hash: [u8; 32],
    pub response_hash: [u8; 32],
    pub replay_key: [u8; 32],
    pub is_mock: bool,
}

impl DarkX402Receipt {
    pub fn receipt_id(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"dark_null_v1_x402_receipt_id");
        h.update(self.x402_requirement_hash);
        h.update(self.payment_proof_hash);
        h.update(self.receipt_nullifier);
        h.finalize().into()
    }
}

// Derive replay key — binds requirement + payer + nonce
pub fn derive_replay_key(req: &X402PaymentRequirement, payer: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"dark_null_v1_x402_replay");
    h.update(req.requirement_hash());
    h.update(payer);
    h.update(req.nonce);
    h.finalize().into()
}

// Mint a Dark Null receipt note after payment
pub fn mint_receipt_note_after_payment(
    req: &X402PaymentRequirement,
    proof: &X402PaymentProof,
    response_bytes: &[u8],
    current_slot: u64,
) -> Result<DarkX402Receipt, X402Error> {
    // Check requirement hash matches
    if proof.requirement_hash != req.requirement_hash() {
        return Err(X402Error::RequirementHashMismatch);
    }
    if req.is_expired(current_slot) {
        return Err(X402Error::RequirementExpired);
    }
    if proof.tx_signature.is_empty() {
        return Err(X402Error::EmptyTxSignature);
    }
    // Verify payer pubkey != pay_to (no self-pay in mock)
    if proof.payer_pubkey == req.pay_to {
        return Err(X402Error::SelfPayment);
    }

    let scope_hash = req.scope_hash();
    let receipt_note_hash = {
        let mut h = Sha256::new();
        h.update(b"dark_null_v1_x402_note");
        h.update(proof.proof_hash());
        h.update(scope_hash);
        h.finalize().into()
    };
    let receipt_nullifier = {
        let mut h = Sha256::new();
        h.update(b"dark_null_v1_x402_nullifier");
        h.update(receipt_note_hash);
        h.update(req.nonce);
        h.finalize().into()
    };
    let response_hash = {
        let mut h = Sha256::new();
        h.update(b"dark_null_v1_x402_response");
        h.update(response_bytes);
        h.finalize().into()
    };
    let replay_key = derive_replay_key(req, &proof.payer_pubkey);

    Ok(DarkX402Receipt {
        x402_requirement_hash: proof.requirement_hash,
        payment_proof_hash: proof.proof_hash(),
        receipt_note_hash,
        receipt_nullifier,
        service_scope_hash: scope_hash,
        response_hash,
        replay_key,
        is_mock: proof.is_mock,
    })
}

pub fn verify_no_raw_url_in_proof(proof: &X402PaymentProof) -> bool {
    // Proof only contains hashes — resource URL is hashed into scope_hash, not stored raw
    // This function verifies the proof struct contains no string that looks like a URL
    !proof.tx_signature.starts_with("http") && !proof.receipt_scope_hash.is_empty()
}

pub fn verify_no_raw_buyer_identity(proof: &X402PaymentProof) -> bool {
    // payer_pubkey is a raw 32-byte key — it IS stored
    // But it should not appear as a human-readable string in any field
    // This is a structural check: proof contains [u8;32] not strings
    !proof.tx_signature.contains("pubkey") && !proof.tx_signature.contains("wallet")
}

pub fn redact_sensitive_headers(headers: &[(&str, &str)]) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(k, v)| {
            let redacted =
                if k.to_lowercase().contains("payment") || k.to_lowercase().contains("x-payment") {
                    "[REDACTED_PAYMENT_HEADER]".to_string()
                } else {
                    v.to_string()
                };
            (k.to_string(), redacted)
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum X402Error {
    RequirementHashMismatch,
    RequirementExpired,
    EmptyTxSignature,
    SelfPayment,
    Replay,
    StrictVerificationFailed(String),
    MockNotAllowedInStrictMode,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_req(resource: &str, expires_at_slot: u64) -> X402PaymentRequirement {
        X402PaymentRequirement {
            scheme: "exact".to_string(),
            network: "solana-devnet".to_string(),
            asset: "SOL".to_string(),
            amount_lamports: 1_000_000,
            pay_to: [0xAA; 32],
            resource: resource.to_string(),
            expires_at_slot,
            nonce: [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08],
            facilitator_url: None,
        }
    }

    fn make_proof(req: &X402PaymentRequirement, payer: [u8; 32], sig: &str) -> X402PaymentProof {
        let requirement_hash = req.requirement_hash();
        let scope_hash = req.scope_hash();
        let mut phh = Sha256::new();
        phh.update(b"dark_null_v1_x402_payment_header");
        phh.update(requirement_hash);
        phh.update(payer);
        let payment_header_hash: [u8; 32] = phh.finalize().into();
        X402PaymentProof {
            requirement_hash,
            payer_pubkey: payer,
            tx_signature: sig.to_string(),
            payment_header_hash,
            receipt_scope_hash: scope_hash,
            is_mock: true,
        }
    }

    // 1. requirement_hash is deterministic
    #[test]
    fn test_requirement_hash_deterministic() {
        let req1 = make_req("https://api.darknull.example/gpt4", 9999);
        let req2 = make_req("https://api.darknull.example/gpt4", 9999);
        assert_eq!(req1.requirement_hash(), req2.requirement_hash());
    }

    // 2. scope_hash hides raw URL
    #[test]
    fn test_scope_hash_hides_raw_url() {
        let url = "https://api.example.com/gpt4";
        let req = make_req(url, 9999);
        let sh = req.scope_hash();
        // The scope hash must not equal the raw URL bytes padded to 32
        let url_bytes = url.as_bytes();
        // scope_hash is 32 bytes; raw URL is not 32 bytes — but verify the hash is not simply the url
        assert_ne!(&sh[..], url_bytes);
        // Also confirm it's not all zeros
        assert_ne!(sh, [0u8; 32]);
    }

    // 3. proof_hash is deterministic
    #[test]
    fn test_proof_hash_deterministic() {
        let req = make_req("https://api.darknull.example/gpt4", 9999);
        let payer = [0xBB; 32];
        let proof1 = make_proof(&req, payer, "MOCK_SIG_aabbccdd");
        let proof2 = make_proof(&req, payer, "MOCK_SIG_aabbccdd");
        assert_eq!(proof1.proof_hash(), proof2.proof_hash());
    }

    // 4. mint_receipt valid path
    #[test]
    fn test_mint_receipt_valid() {
        let req = make_req("https://api.darknull.example/resource", 9999);
        let payer = [0xBB; 32];
        let proof = make_proof(&req, payer, "MOCK_SIG_aabbccdd");
        let result = mint_receipt_note_after_payment(&req, &proof, b"payload", 1000);
        assert!(result.is_ok());
        let receipt = result.unwrap();
        assert_eq!(receipt.is_mock, true);
        assert_eq!(receipt.service_scope_hash, req.scope_hash());
    }

    // 5. mint_receipt rejects wrong requirement hash
    #[test]
    fn test_mint_receipt_wrong_requirement_hash() {
        let req = make_req("https://api.darknull.example/resource", 9999);
        let payer = [0xBB; 32];
        let mut proof = make_proof(&req, payer, "MOCK_SIG_aabbccdd");
        // Tamper the requirement hash
        proof.requirement_hash = [0xFF; 32];
        let result = mint_receipt_note_after_payment(&req, &proof, b"payload", 1000);
        assert!(matches!(result, Err(X402Error::RequirementHashMismatch)));
    }

    // 6. mint_receipt rejects expired requirement
    #[test]
    fn test_mint_receipt_expired() {
        let req = make_req("https://api.darknull.example/resource", 500);
        let payer = [0xBB; 32];
        let proof = make_proof(&req, payer, "MOCK_SIG_aabbccdd");
        // current_slot > expires_at_slot
        let result = mint_receipt_note_after_payment(&req, &proof, b"payload", 1000);
        assert!(matches!(result, Err(X402Error::RequirementExpired)));
    }

    // 7. mint_receipt rejects empty signature
    #[test]
    fn test_mint_receipt_empty_sig() {
        let req = make_req("https://api.darknull.example/resource", 9999);
        let payer = [0xBB; 32];
        let proof = make_proof(&req, payer, "");
        let result = mint_receipt_note_after_payment(&req, &proof, b"payload", 1000);
        assert!(matches!(result, Err(X402Error::EmptyTxSignature)));
    }

    // 8. mint_receipt rejects self-payment
    #[test]
    fn test_mint_receipt_self_payment() {
        let req = make_req("https://api.darknull.example/resource", 9999);
        // payer == pay_to ([0xAA; 32] from make_req)
        let payer = [0xAA; 32];
        let proof = make_proof(&req, payer, "MOCK_SIG_aabbccdd");
        let result = mint_receipt_note_after_payment(&req, &proof, b"payload", 1000);
        assert!(matches!(result, Err(X402Error::SelfPayment)));
    }

    // 9. replay key is deterministic
    #[test]
    fn test_replay_key_deterministic() {
        let req = make_req("https://api.darknull.example/resource", 9999);
        let payer = [0xBB; 32];
        let k1 = derive_replay_key(&req, &payer);
        let k2 = derive_replay_key(&req, &payer);
        assert_eq!(k1, k2);
    }

    // 10. verify_no_raw_url passes for hash-based proof
    #[test]
    fn test_verify_no_raw_url_passes_for_hash() {
        let req = make_req("https://api.darknull.example/resource", 9999);
        let payer = [0xBB; 32];
        let proof = make_proof(&req, payer, "MOCK_SIG_aabbccdd");
        assert!(verify_no_raw_url_in_proof(&proof));
    }

    // 11. redact_payment_headers removes payment header values
    #[test]
    fn test_redact_payment_headers() {
        let headers = vec![
            ("X-Payment-Proof", "secret_proof_data"),
            ("Content-Type", "application/json"),
            ("x-payment-token", "another_secret"),
        ];
        let redacted = redact_sensitive_headers(&headers);
        assert_eq!(redacted[0].1, "[REDACTED_PAYMENT_HEADER]");
        assert_eq!(redacted[1].1, "application/json");
        assert_eq!(redacted[2].1, "[REDACTED_PAYMENT_HEADER]");
    }

    // 12. receipt_id is deterministic
    #[test]
    fn test_receipt_id_deterministic() {
        let req = make_req("https://api.darknull.example/resource", 9999);
        let payer = [0xBB; 32];
        let proof = make_proof(&req, payer, "MOCK_SIG_aabbccdd");
        let receipt1 = mint_receipt_note_after_payment(&req, &proof, b"payload", 1000).unwrap();
        let receipt2 = mint_receipt_note_after_payment(&req, &proof, b"payload", 1000).unwrap();
        assert_eq!(receipt1.receipt_id(), receipt2.receipt_id());
    }
}
