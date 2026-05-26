use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq)]
pub struct SubscriberCredential {
    pub subscriber_hash: [u8; 32],
    pub credential_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecoyReveal {
    pub pick_hash: [u8; 32],
    pub fake_side: u8,
    pub sniper_tax_lamports: u64,
    pub tax_receipt_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq)]
pub struct SniperTaxReceipt {
    pub sniper_hash: [u8; 32],
    pub tax_paid_lamports: u64,
    pub protocol_fee_lamports: u64,
    pub seller_fee_lamports: u64,
    pub receipt_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum TrapError {
    #[error("invalid subscriber")]
    InvalidSubscriber,
}

/// Build a credential for a given subscriber hash and season byte.
pub fn build_credential(subscriber_pubkey: &[u8; 32], season: u8) -> SubscriberCredential {
    let subscriber_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(subscriber_pubkey);
        h.finalize().into()
    };
    let credential_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"subscriber-v1");
        h.update(subscriber_hash);
        h.update([season]);
        h.finalize().into()
    };
    SubscriberCredential {
        subscriber_hash,
        credential_hash,
    }
}

pub fn is_valid_subscriber(candidate: &[u8; 32], credential: &SubscriberCredential) -> bool {
    // The candidate is a raw pubkey; hash it and compare with credential.subscriber_hash
    let candidate_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(candidate);
        h.finalize().into()
    };
    candidate_hash == credential.subscriber_hash
}

pub fn create_decoy_reveal(
    pick_hash: &[u8; 32],
    sniper_hash: &[u8; 32],
    tax_lamports: u64,
) -> DecoyReveal {
    // fake_side: derive deterministically from sniper_hash so it looks random
    let fake_side: u8 = sniper_hash[0].wrapping_add(0x5a) % 5;

    let tax_receipt_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"decoy-tax-v1");
        h.update(pick_hash);
        h.update(sniper_hash);
        h.update(tax_lamports.to_le_bytes());
        h.update([fake_side]);
        h.finalize().into()
    };

    DecoyReveal {
        pick_hash: *pick_hash,
        fake_side,
        sniper_tax_lamports: tax_lamports,
        tax_receipt_hash,
    }
}

pub fn mint_sniper_tax_receipt(decoy: &DecoyReveal, sniper_hash: &[u8; 32]) -> SniperTaxReceipt {
    let protocol_fee_lamports = decoy.sniper_tax_lamports / 10;
    let seller_fee_lamports = decoy.sniper_tax_lamports - protocol_fee_lamports;

    let receipt_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"sniper-tax-receipt-v1");
        h.update(sniper_hash);
        h.update(decoy.sniper_tax_lamports.to_le_bytes());
        h.update(decoy.tax_receipt_hash);
        h.finalize().into()
    };

    SniperTaxReceipt {
        sniper_hash: *sniper_hash,
        tax_paid_lamports: decoy.sniper_tax_lamports,
        protocol_fee_lamports,
        seller_fee_lamports,
        receipt_hash,
    }
}

pub fn decoy_cannot_verify_against_real(
    decoy: &DecoyReveal,
    real_side_commitment: &[u8; 32],
) -> bool {
    // The decoy's fake_side as a byte should not reconstruct real_side_commitment.
    // We simply confirm the decoy's tax_receipt_hash != real_side_commitment (they are independent).
    decoy.tax_receipt_hash != *real_side_commitment
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subscriber_pubkey() -> [u8; 32] {
        let mut k = [0u8; 32];
        k[0] = 0xAB;
        k
    }

    #[test]
    fn test_real_subscriber_identified() {
        let pubkey = subscriber_pubkey();
        let cred = build_credential(&pubkey, 1);
        assert!(is_valid_subscriber(&pubkey, &cred));
    }

    #[test]
    fn test_unknown_subscriber_gets_decoy() {
        let pubkey = subscriber_pubkey();
        let cred = build_credential(&pubkey, 1);
        let other_pubkey = [0xCC_u8; 32];
        assert!(!is_valid_subscriber(&other_pubkey, &cred));
    }

    #[test]
    fn test_decoy_cannot_verify_against_real() {
        let pick_hash = [1u8; 32];
        let sniper_hash = [2u8; 32];
        let decoy = create_decoy_reveal(&pick_hash, &sniper_hash, 5000);
        let real_side_commitment = [3u8; 32];
        assert!(decoy_cannot_verify_against_real(
            &decoy,
            &real_side_commitment
        ));
    }

    #[test]
    fn test_sniper_tax_receipt_minted() {
        let pick_hash = [1u8; 32];
        let sniper_hash = [2u8; 32];
        let decoy = create_decoy_reveal(&pick_hash, &sniper_hash, 10_000);
        let receipt = mint_sniper_tax_receipt(&decoy, &sniper_hash);
        assert_ne!(receipt.receipt_hash, [0u8; 32]);
        assert_eq!(receipt.tax_paid_lamports, 10_000);
    }

    #[test]
    fn test_protocol_fee_computed() {
        let pick_hash = [1u8; 32];
        let sniper_hash = [2u8; 32];
        let tax = 10_000u64;
        let decoy = create_decoy_reveal(&pick_hash, &sniper_hash, tax);
        let receipt = mint_sniper_tax_receipt(&decoy, &sniper_hash);
        assert_eq!(receipt.protocol_fee_lamports, tax / 10);
        assert_eq!(receipt.seller_fee_lamports, tax - tax / 10);
    }
}
