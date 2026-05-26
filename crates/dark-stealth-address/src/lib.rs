use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct StealthMetaAddress {
    /// Public scanning key: SHA256("stealth-scan-pubkey-v1" || scan_secret)
    pub scan_pubkey: [u8; 32],
    /// Public spending key: SHA256("stealth-spend-pubkey-v1" || spend_secret)
    pub spend_pubkey: [u8; 32],
    /// Always false — not production-ready
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone)]
pub struct StealthPayment {
    /// One-time address: SHA256("stealth-addr-v1" || shared_secret || spend_pubkey)
    pub one_time_address: [u8; 32],
    /// Ephemeral public key: SHA256("stealth-ephem-v1" || ephemeral_secret)
    pub ephemeral_pubkey: [u8; 32],
    /// Amount commitment: SHA256("stealth-amount-v1" || amount.to_le_bytes() || ephemeral_secret)
    pub amount_commitment: [u8; 32],
    /// Always false — not production-ready
    pub mainnet_ready: bool,
}

#[derive(Debug)]
pub enum StealthError {
    ZeroSecret,
    AmountZero,
    ScanMismatch,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn sha256_domain(domain: &[u8], data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    h.update(data);
    h.finalize().into()
}

fn sha256_domain2(domain: &[u8], a: &[u8], b: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    h.update(a);
    h.update(b);
    h.finalize().into()
}

fn is_zero(bytes: &[u8; 32]) -> bool {
    bytes.iter().all(|&b| b == 0)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Build a `StealthMetaAddress` from a scan secret and spend secret.
///
/// Returns `StealthError::ZeroSecret` if either secret is all-zero bytes.
pub fn create_meta_address(
    scan_secret: &[u8; 32],
    spend_secret: &[u8; 32],
) -> Result<StealthMetaAddress, StealthError> {
    if is_zero(scan_secret) || is_zero(spend_secret) {
        return Err(StealthError::ZeroSecret);
    }

    let scan_pubkey = sha256_domain(b"stealth-scan-pubkey-v1", scan_secret);
    let spend_pubkey = sha256_domain(b"stealth-spend-pubkey-v1", spend_secret);

    Ok(StealthMetaAddress {
        scan_pubkey,
        spend_pubkey,
        mainnet_ready: false,
    })
}

/// Create a stealth payment to `meta_addr` using `ephemeral_secret` and `amount`.
///
/// Returns `StealthError::AmountZero` if `amount` is zero.
pub fn send_stealth_payment(
    meta_addr: &StealthMetaAddress,
    ephemeral_secret: &[u8; 32],
    amount: u64,
) -> Result<StealthPayment, StealthError> {
    if amount == 0 {
        return Err(StealthError::AmountZero);
    }

    // ephemeral_pubkey = SHA256("stealth-ephem-v1" || ephemeral_secret)
    let ephemeral_pubkey = sha256_domain(b"stealth-ephem-v1", ephemeral_secret);

    // shared_secret = SHA256("stealth-shared-v1" || ephemeral_pubkey || scan_pubkey)
    // Both sender and recipient can compute this: sender has ephemeral_pubkey (just
    // computed) and scan_pubkey (from the meta address); recipient has the published
    // ephemeral_pubkey and can derive scan_pubkey from their scan_secret.
    let shared_secret = sha256_domain2(
        b"stealth-shared-v1",
        &ephemeral_pubkey,
        &meta_addr.scan_pubkey,
    );

    // one_time_address = SHA256("stealth-addr-v1" || shared_secret || spend_pubkey)
    let one_time_address = sha256_domain2(
        b"stealth-addr-v1",
        &shared_secret,
        &meta_addr.spend_pubkey,
    );

    // amount_commitment = SHA256("stealth-amount-v1" || amount.to_le_bytes() || ephemeral_secret)
    let amount_commitment = sha256_domain2(
        b"stealth-amount-v1",
        &amount.to_le_bytes(),
        ephemeral_secret,
    );

    Ok(StealthPayment {
        one_time_address,
        ephemeral_pubkey,
        amount_commitment,
        mainnet_ready: false,
    })
}

/// Check whether `payment` was sent to `meta_addr` by scanning with `scan_secret`.
///
/// The recipient recomputes `scan_pubkey` from `scan_secret`, then mirrors the
/// sender's shared-secret derivation using the published `ephemeral_pubkey`.
/// Returns `true` iff the reconstructed one-time address matches the payment.
pub fn scan_payment(
    meta_addr: &StealthMetaAddress,
    scan_secret: &[u8; 32],
    payment: &StealthPayment,
) -> bool {
    // Recompute scan_pubkey so we can reproduce the sender's shared_secret.
    let scan_pubkey = sha256_domain(b"stealth-scan-pubkey-v1", scan_secret);

    // shared_secret = SHA256("stealth-shared-v1" || ephemeral_pubkey || scan_pubkey)
    // Matches sender: SHA256(domain || ephemeral_pubkey || meta_addr.scan_pubkey).
    let shared_secret = sha256_domain2(
        b"stealth-shared-v1",
        &payment.ephemeral_pubkey,
        &scan_pubkey,
    );

    // expected_addr = SHA256("stealth-addr-v1" || shared_secret || spend_pubkey)
    let expected_addr = sha256_domain2(
        b"stealth-addr-v1",
        &shared_secret,
        &meta_addr.spend_pubkey,
    );

    expected_addr == payment.one_time_address
}

/// Return a JSON string with the public fields of a payment.
///
/// Intentionally omits the raw amount and all secrets — only the opaque
/// commitments / public keys are included.
pub fn payment_public_record(payment: &StealthPayment) -> String {
    let ephemeral_hex = hex_encode(&payment.ephemeral_pubkey);
    let commitment_hex = hex_encode(&payment.amount_commitment);

    serde_json::json!({
        "ephemeral_pubkey": ephemeral_hex,
        "amount_commitment": commitment_hex,
        "mainnet_ready": payment.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Internal hex helper (avoids pulling in the `hex` crate)
// ---------------------------------------------------------------------------

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn scan_secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xAB;
        s
    }

    fn spend_secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xCD;
        s
    }

    fn ephemeral_secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xEF;
        s
    }

    // 1. Happy-path roundtrip: send then scan
    #[test]
    fn test_send_scan_roundtrip() {
        let meta = create_meta_address(&scan_secret(), &spend_secret()).unwrap();
        let payment = send_stealth_payment(&meta, &ephemeral_secret(), 1_000_000).unwrap();
        assert!(scan_payment(&meta, &scan_secret(), &payment));
    }

    // 2. A different scan_secret must not claim ownership
    #[test]
    fn test_wrong_scan_secret_fails() {
        let meta = create_meta_address(&scan_secret(), &spend_secret()).unwrap();
        let payment = send_stealth_payment(&meta, &ephemeral_secret(), 500).unwrap();

        let mut wrong = scan_secret();
        wrong[1] = 0xFF; // flip one byte
        assert!(!scan_payment(&meta, &wrong, &payment));
    }

    // 3. All-zero scan_secret must be rejected
    #[test]
    fn test_zero_secret_rejected() {
        let zero = [0u8; 32];
        let result = create_meta_address(&zero, &spend_secret());
        assert!(matches!(result, Err(StealthError::ZeroSecret)));
    }

    // 4. Amount == 0 must be rejected
    #[test]
    fn test_zero_amount_rejected() {
        let meta = create_meta_address(&scan_secret(), &spend_secret()).unwrap();
        let result = send_stealth_payment(&meta, &ephemeral_secret(), 0);
        assert!(matches!(result, Err(StealthError::AmountZero)));
    }

    // 5. Two different ephemeral secrets -> two different one-time addresses
    #[test]
    fn test_different_ephemeral_different_address() {
        let meta = create_meta_address(&scan_secret(), &spend_secret()).unwrap();

        let ephem1 = ephemeral_secret();
        let mut ephem2 = ephemeral_secret();
        ephem2[31] = 0x01;

        let p1 = send_stealth_payment(&meta, &ephem1, 100).unwrap();
        let p2 = send_stealth_payment(&meta, &ephem2, 100).unwrap();

        assert_ne!(
            p1.one_time_address, p2.one_time_address,
            "different ephemeral keys must produce different one-time addresses"
        );
    }

    // 6. Public record must not contain the raw decimal amount
    #[test]
    fn test_public_record_hides_amount() {
        let meta = create_meta_address(&scan_secret(), &spend_secret()).unwrap();
        let amount: u64 = 42_000_001;
        let payment = send_stealth_payment(&meta, &ephemeral_secret(), amount).unwrap();

        let record = payment_public_record(&payment);

        // The raw decimal string must not appear in the public JSON
        assert!(
            !record.contains(&amount.to_string()),
            "public record must not expose raw amount; got: {}",
            record
        );
    }
}
