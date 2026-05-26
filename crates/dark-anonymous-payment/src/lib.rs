use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnonPayment {
    pub payment_id: [u8; 32],
    pub sender_commitment: [u8; 32],
    pub receiver_commitment: [u8; 32],
    pub amount_commitment: [u8; 32],
    pub memo_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentProof {
    pub payment_id: [u8; 32],
    pub proof_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum PaymentError {
    ZeroSenderSecret,
    ZeroReceiverSecret,
    ZeroAmount,
    EmptyMemo,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

// ── API ────────────────────────────────────────────────────────────────────

/// Creates a fully anonymous payment.
///
/// sender_commitment   = SHA256("anon-pay-sender-v1"   || SHA256("anon-pay-secret-v1" || sender_secret) || nonce_s)
/// receiver_commitment = SHA256("anon-pay-receiver-v1" || SHA256("anon-pay-secret-v1" || receiver_secret) || nonce_r)
/// amount_commitment   = SHA256("anon-pay-amount-v1"   || amount_le || blinding)
/// memo_hash           = SHA256("anon-pay-memo-v1"     || memo_bytes)
/// payment_id          = SHA256("anon-pay-id-v1"       || sender_commitment || receiver_commitment || amount_commitment || memo_hash)
pub fn create_payment(
    sender_secret: &[u8; 32],
    receiver_secret: &[u8; 32],
    amount: u64,
    memo_bytes: &[u8],
    blinding: &[u8; 32],
    nonce_s: &[u8; 32],
    nonce_r: &[u8; 32],
) -> Result<AnonPayment, PaymentError> {
    if sender_secret == &[0u8; 32] {
        return Err(PaymentError::ZeroSenderSecret);
    }
    if receiver_secret == &[0u8; 32] {
        return Err(PaymentError::ZeroReceiverSecret);
    }
    if amount == 0 {
        return Err(PaymentError::ZeroAmount);
    }
    if memo_bytes.is_empty() {
        return Err(PaymentError::EmptyMemo);
    }

    let sender_inner = sha256_multi(&[b"anon-pay-secret-v1", sender_secret]);
    let receiver_inner = sha256_multi(&[b"anon-pay-secret-v1", receiver_secret]);

    let sender_commitment = sha256_multi(&[b"anon-pay-sender-v1", &sender_inner, nonce_s]);
    let receiver_commitment = sha256_multi(&[b"anon-pay-receiver-v1", &receiver_inner, nonce_r]);
    let amount_commitment = sha256_multi(&[b"anon-pay-amount-v1", &amount.to_le_bytes(), blinding]);
    let memo_hash = sha256_multi(&[b"anon-pay-memo-v1", memo_bytes]);

    let payment_id = sha256_multi(&[
        b"anon-pay-id-v1",
        &sender_commitment,
        &receiver_commitment,
        &amount_commitment,
        &memo_hash,
    ]);

    Ok(AnonPayment {
        payment_id,
        sender_commitment,
        receiver_commitment,
        amount_commitment,
        memo_hash,
        mainnet_ready: false,
    })
}

/// Produces a proof of the payment.
/// proof_hash = SHA256("anon-pay-proof-v1" || payment_id || sender_commitment || receiver_commitment)
pub fn prove_payment(payment: &AnonPayment) -> PaymentProof {
    let proof_hash = sha256_multi(&[
        b"anon-pay-proof-v1",
        &payment.payment_id,
        &payment.sender_commitment,
        &payment.receiver_commitment,
    ]);
    PaymentProof {
        payment_id: payment.payment_id,
        proof_hash,
        mainnet_ready: false,
    }
}

/// Verifies the proof matches the payment.
pub fn verify_payment(payment: &AnonPayment, proof: &PaymentProof) -> bool {
    if proof.payment_id != payment.payment_id {
        return false;
    }
    let expected_proof_hash = sha256_multi(&[
        b"anon-pay-proof-v1",
        &payment.payment_id,
        &payment.sender_commitment,
        &payment.receiver_commitment,
    ]);
    expected_proof_hash == proof.proof_hash
}

/// JSON: payment_id, memo_hash, mainnet_ready — NOT sender/receiver/amount.
pub fn payment_public_record(payment: &AnonPayment) -> String {
    serde_json::json!({
        "payment_id": hex32(&payment.payment_id),
        "memo_hash": hex32(&payment.memo_hash),
        "mainnet_ready": payment.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b;
        s
    }

    #[test]
    fn test_create_prove_verify() {
        let payment = create_payment(
            &secret(0x01),
            &secret(0x02),
            1000,
            b"payment memo",
            &secret(0x03),
            &secret(0x04),
            &secret(0x05),
        )
        .unwrap();
        assert!(!payment.mainnet_ready);

        let proof = prove_payment(&payment);
        assert!(!proof.mainnet_ready);
        assert_eq!(proof.payment_id, payment.payment_id);

        assert!(verify_payment(&payment, &proof));

        // Tampered proof fails
        let mut bad_proof = proof.clone();
        bad_proof.proof_hash[0] ^= 0xff;
        assert!(!verify_payment(&payment, &bad_proof));
    }

    #[test]
    fn test_different_senders_produce_different_payments() {
        let p1 = create_payment(
            &secret(0x10),
            &secret(0x20),
            500,
            b"memo",
            &secret(0x30),
            &secret(0x40),
            &secret(0x50),
        )
        .unwrap();
        let p2 = create_payment(
            &secret(0x11),
            &secret(0x20),
            500,
            b"memo",
            &secret(0x30),
            &secret(0x40),
            &secret(0x50),
        )
        .unwrap();
        assert_ne!(p1.payment_id, p2.payment_id);
        assert_ne!(p1.sender_commitment, p2.sender_commitment);
    }

    #[test]
    fn test_amount_commitment_hides_amount() {
        let p1 = create_payment(
            &secret(0x11),
            &secret(0x22),
            100,
            b"memo",
            &secret(0x33),
            &secret(0x44),
            &secret(0x55),
        )
        .unwrap();
        let p2 = create_payment(
            &secret(0x11),
            &secret(0x22),
            200,
            b"memo",
            &secret(0x33),
            &secret(0x44),
            &secret(0x55),
        )
        .unwrap();
        // Different amounts → different amount_commitment (hidden)
        assert_ne!(p1.amount_commitment, p2.amount_commitment);
        // amount_commitment does not directly reveal amount
        let p1_record = payment_public_record(&p1);
        assert!(!p1_record.contains("100"));
        assert!(!p1_record.contains("amount_commitment"));
    }

    #[test]
    fn test_zero_sender_rejected() {
        let err = create_payment(
            &[0u8; 32],
            &secret(0x22),
            100,
            b"memo",
            &secret(0x33),
            &secret(0x44),
            &secret(0x55),
        )
        .unwrap_err();
        assert_eq!(err, PaymentError::ZeroSenderSecret);
    }

    #[test]
    fn test_empty_memo_rejected() {
        let err = create_payment(
            &secret(0x11),
            &secret(0x22),
            100,
            b"",
            &secret(0x33),
            &secret(0x44),
            &secret(0x55),
        )
        .unwrap_err();
        assert_eq!(err, PaymentError::EmptyMemo);
    }

    #[test]
    fn test_public_record_hides_sender_receiver_amount() {
        let payment = create_payment(
            &secret(0x61),
            &secret(0x62),
            9999,
            b"hidden amount",
            &secret(0x63),
            &secret(0x64),
            &secret(0x65),
        )
        .unwrap();
        let rec = payment_public_record(&payment);
        let v: serde_json::Value = serde_json::from_str(&rec).unwrap();
        assert!(v["payment_id"].is_string());
        assert!(v["memo_hash"].is_string());
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("sender_commitment").is_none());
        assert!(v.get("receiver_commitment").is_none());
        assert!(v.get("amount_commitment").is_none());
        assert!(!rec.contains(&hex32(&payment.sender_commitment)));
        assert!(!rec.contains(&hex32(&payment.receiver_commitment)));
        assert!(!rec.contains(&hex32(&payment.amount_commitment)));
    }
}
