use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bond {
    pub bond_id: [u8; 32],
    pub issuer_hash: [u8; 32],
    pub beneficiary_hash: [u8; 32],
    pub amount_lamports: u64,
    pub maturity_unix: i64,
    pub covenant_hash: [u8; 32],
    pub redeemed: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BondReceipt {
    pub bond_id: [u8; 32],
    pub beneficiary_hash: [u8; 32],
    pub amount_lamports: u64,
    pub redeemed_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BondError {
    IssuerSecretZero,
    BeneficiarySecretZero,
    AmountZero,
    NotMatured { maturity: i64, current: i64 },
    AlreadyRedeemed,
}

// ── Hash helpers ─────────────────────────────────────────────────────────────

fn sha256_issuer(secret: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"bond-issuer-v1");
    h.update(secret);
    h.finalize().into()
}

fn sha256_beneficiary(secret: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"bond-beneficiary-v1");
    h.update(secret);
    h.finalize().into()
}

fn sha256_covenant(
    issuer_hash: &[u8; 32],
    beneficiary_hash: &[u8; 32],
    amount_lamports: u64,
    maturity_unix: i64,
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"bond-covenant-v1");
    h.update(issuer_hash);
    h.update(beneficiary_hash);
    h.update(amount_lamports.to_le_bytes());
    h.update(maturity_unix.to_le_bytes());
    h.finalize().into()
}

fn sha256_bond_id(covenant_hash: &[u8; 32], nonce: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"bond-id-v1");
    h.update(covenant_hash);
    h.update(nonce);
    h.finalize().into()
}

fn is_zero(bytes: &[u8; 32]) -> bool {
    bytes.iter().all(|&b| b == 0)
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Issue a new time-locked bond. `mainnet_ready` is always `false`.
pub fn issue_bond(
    issuer_secret: &[u8; 32],
    beneficiary_secret: &[u8; 32],
    amount_lamports: u64,
    maturity_unix: i64,
    nonce: &[u8; 32],
) -> Result<Bond, BondError> {
    if is_zero(issuer_secret) {
        return Err(BondError::IssuerSecretZero);
    }
    if is_zero(beneficiary_secret) {
        return Err(BondError::BeneficiarySecretZero);
    }
    if amount_lamports == 0 {
        return Err(BondError::AmountZero);
    }

    let issuer_hash = sha256_issuer(issuer_secret);
    let beneficiary_hash = sha256_beneficiary(beneficiary_secret);
    let covenant_hash = sha256_covenant(&issuer_hash, &beneficiary_hash, amount_lamports, maturity_unix);
    let bond_id = sha256_bond_id(&covenant_hash, nonce);

    Ok(Bond {
        bond_id,
        issuer_hash,
        beneficiary_hash,
        amount_lamports,
        maturity_unix,
        covenant_hash,
        redeemed: false,
        mainnet_ready: false, // NEVER true
    })
}

/// Redeem a matured bond. `mainnet_ready` is always `false` in the receipt.
pub fn redeem_bond(
    bond: &mut Bond,
    beneficiary_secret: &[u8; 32],
    current_unix: i64,
) -> Result<BondReceipt, BondError> {
    if current_unix < bond.maturity_unix {
        return Err(BondError::NotMatured {
            maturity: bond.maturity_unix,
            current: current_unix,
        });
    }
    if bond.redeemed {
        return Err(BondError::AlreadyRedeemed);
    }

    // Verify the caller is the legitimate beneficiary
    let claimed_hash = sha256_beneficiary(beneficiary_secret);
    if claimed_hash != bond.beneficiary_hash {
        // Treat a wrong secret the same as a zero-secret guard path;
        // for this primitive we surface it as BeneficiarySecretZero so
        // callers learn they provided the wrong identity.
        return Err(BondError::BeneficiarySecretZero);
    }

    bond.redeemed = true;

    Ok(BondReceipt {
        bond_id: bond.bond_id,
        beneficiary_hash: bond.beneficiary_hash,
        amount_lamports: bond.amount_lamports,
        redeemed_at_unix: current_unix,
        mainnet_ready: false, // NEVER true
    })
}

/// Returns a JSON public record that exposes only non-identifying fields.
/// `issuer_hash` and `beneficiary_hash` are intentionally omitted.
pub fn bond_public_record(bond: &Bond) -> String {
    let bond_id_hex = hex_encode(&bond.bond_id);
    let covenant_hash_hex = hex_encode(&bond.covenant_hash);

    serde_json::json!({
        "bond_id": bond_id_hex,
        "covenant_hash": covenant_hash_hex,
        "amount_lamports": bond.amount_lamports,
        "maturity_unix": bond.maturity_unix,
        "redeemed": bond.redeemed,
        "mainnet_ready": bond.mainnet_ready,
    })
    .to_string()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn issuer() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xAA;
        s
    }

    fn beneficiary() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xBB;
        s
    }

    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0x01;
        n
    }

    #[test]
    fn test_issue_redeem_happy_path() {
        let maturity: i64 = 1_000_000;
        let amount: u64 = 5_000_000_000; // 5 SOL in lamports

        let mut bond = issue_bond(&issuer(), &beneficiary(), amount, maturity, &nonce())
            .expect("issue should succeed");

        assert!(!bond.redeemed);
        assert!(!bond.mainnet_ready);

        let receipt = redeem_bond(&mut bond, &beneficiary(), maturity)
            .expect("redeem at maturity should succeed");

        assert_eq!(receipt.amount_lamports, amount);
        assert!(bond.redeemed);
        assert!(!receipt.mainnet_ready);
    }

    #[test]
    fn test_not_matured_rejected() {
        let maturity: i64 = 2_000_000;
        let mut bond = issue_bond(&issuer(), &beneficiary(), 1_000, maturity, &nonce())
            .expect("issue should succeed");

        let err = redeem_bond(&mut bond, &beneficiary(), maturity - 1)
            .expect_err("should reject early redemption");

        assert_eq!(
            err,
            BondError::NotMatured {
                maturity,
                current: maturity - 1
            }
        );
    }

    #[test]
    fn test_double_redeem_rejected() {
        let maturity: i64 = 500_000;
        let mut bond = issue_bond(&issuer(), &beneficiary(), 1_000, maturity, &nonce())
            .expect("issue should succeed");

        redeem_bond(&mut bond, &beneficiary(), maturity).expect("first redeem should succeed");

        let err = redeem_bond(&mut bond, &beneficiary(), maturity)
            .expect_err("second redeem should fail");

        assert_eq!(err, BondError::AlreadyRedeemed);
    }

    #[test]
    fn test_zero_issuer_rejected() {
        let zero = [0u8; 32];
        let err = issue_bond(&zero, &beneficiary(), 1_000, 0, &nonce())
            .expect_err("zero issuer should be rejected");

        assert_eq!(err, BondError::IssuerSecretZero);
    }

    #[test]
    fn test_amount_zero_rejected() {
        let err = issue_bond(&issuer(), &beneficiary(), 0, 0, &nonce())
            .expect_err("zero amount should be rejected");

        assert_eq!(err, BondError::AmountZero);
    }

    #[test]
    fn test_public_record_hides_identities() {
        let bond = issue_bond(&issuer(), &beneficiary(), 42_000, 9_999, &nonce())
            .expect("issue should succeed");

        let record = bond_public_record(&bond);

        let issuer_hex = hex_encode(&bond.issuer_hash);
        let beneficiary_hex = hex_encode(&bond.beneficiary_hash);

        assert!(
            !record.contains(&issuer_hex),
            "public record must NOT contain issuer_hash"
        );
        assert!(
            !record.contains(&beneficiary_hex),
            "public record must NOT contain beneficiary_hash"
        );

        // Verify expected fields are present
        assert!(record.contains("bond_id"));
        assert!(record.contains("covenant_hash"));
        assert!(record.contains("amount_lamports"));
        assert!(record.contains("maturity_unix"));
        assert!(record.contains("redeemed"));
        assert!(record.contains("mainnet_ready"));
    }
}
