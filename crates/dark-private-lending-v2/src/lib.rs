use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct LoanV2 {
    pub loan_id: [u8; 32],
    pub lender_hash: [u8; 32],
    pub borrower_hash: [u8; 32],
    pub principal_commitment: [u8; 32],
    pub rate_commitment: [u8; 32],
    pub due_epoch: u64,
    pub repaid: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum LoanErrorV2 {
    ZeroSecret,
    ZeroPrincipal,
    InvalidRate,
    AlreadyRepaid,
}

fn sha256_tagged(tag: &[u8], data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(tag);
    h.update(data);
    h.finalize().into()
}

pub fn new_loan(
    lender_secret: &[u8; 32],
    borrower_secret: &[u8; 32],
    principal: u64,
    rate_bps: u32,
    blinding: &[u8; 32],
    due_epoch: u64,
) -> Result<LoanV2, LoanErrorV2> {
    if lender_secret == &[0u8; 32] || borrower_secret == &[0u8; 32] {
        return Err(LoanErrorV2::ZeroSecret);
    }
    if principal == 0 {
        return Err(LoanErrorV2::ZeroPrincipal);
    }
    if rate_bps > 10_000 {
        return Err(LoanErrorV2::InvalidRate);
    }
    let lender_hash = sha256_tagged(b"lendv2-lender-v1", lender_secret);
    let borrower_hash = sha256_tagged(b"lendv2-borrower-v1", borrower_secret);
    let principal_commitment = {
        let mut h = Sha256::new();
        h.update(b"lendv2-principal-v1");
        h.update(principal.to_le_bytes());
        h.update(blinding);
        h.finalize().into()
    };
    let rate_commitment = {
        let mut h = Sha256::new();
        h.update(b"lendv2-rate-v1");
        h.update(rate_bps.to_le_bytes());
        h.update(blinding);
        h.finalize().into()
    };
    let loan_id = {
        let mut h = Sha256::new();
        h.update(b"lendv2-id-v1");
        h.update(lender_hash);
        h.update(borrower_hash);
        h.update(principal_commitment);
        h.update(due_epoch.to_le_bytes());
        h.finalize().into()
    };
    Ok(LoanV2 {
        loan_id,
        lender_hash,
        borrower_hash,
        principal_commitment,
        rate_commitment,
        due_epoch,
        repaid: false,
        mainnet_ready: false,
    })
}

pub fn repay_loan(loan: &mut LoanV2) -> Result<(), LoanErrorV2> {
    if loan.repaid {
        return Err(LoanErrorV2::AlreadyRepaid);
    }
    loan.repaid = true;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_secrets() -> ([u8; 32], [u8; 32], [u8; 32]) {
        let mut l = [0u8; 32];
        l[0] = 0xAA;
        let mut b = [0u8; 32];
        b[0] = 0xBB;
        let mut blind = [0u8; 32];
        blind[0] = 0xCC;
        (l, b, blind)
    }

    #[test]
    fn new_loan_mainnet_ready_false() {
        let (l, b, blind) = make_secrets();
        let loan = new_loan(&l, &b, 1_000_000, 500, &blind, 1_800_000_000).unwrap();
        assert!(!loan.mainnet_ready);
        assert!(!loan.repaid);
        assert_ne!(loan.loan_id, [0u8; 32]);
    }

    #[test]
    fn repay_sets_flag() {
        let (l, b, blind) = make_secrets();
        let mut loan = new_loan(&l, &b, 1_000_000, 500, &blind, 1_800_000_000).unwrap();
        repay_loan(&mut loan).unwrap();
        assert!(loan.repaid);
    }

    #[test]
    fn double_repay_is_rejected() {
        let (l, b, blind) = make_secrets();
        let mut loan = new_loan(&l, &b, 1_000_000, 500, &blind, 1_800_000_000).unwrap();
        repay_loan(&mut loan).unwrap();
        let err = repay_loan(&mut loan).unwrap_err();
        assert_eq!(err, LoanErrorV2::AlreadyRepaid);
    }

    #[test]
    fn zero_secret_is_rejected() {
        let (_, b, blind) = make_secrets();
        let err = new_loan(&[0u8; 32], &b, 1_000_000, 500, &blind, 1_800_000_000).unwrap_err();
        assert_eq!(err, LoanErrorV2::ZeroSecret);
    }

    #[test]
    fn zero_principal_is_rejected() {
        let (l, b, blind) = make_secrets();
        let err = new_loan(&l, &b, 0, 500, &blind, 1_800_000_000).unwrap_err();
        assert_eq!(err, LoanErrorV2::ZeroPrincipal);
    }

    #[test]
    fn invalid_rate_is_rejected() {
        let (l, b, blind) = make_secrets();
        let err = new_loan(&l, &b, 1_000_000, 10_001, &blind, 1_800_000_000).unwrap_err();
        assert_eq!(err, LoanErrorV2::InvalidRate);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_loan_id_nonzero() {
        let (l, b, blind) = make_secrets();
        let loan = new_loan(&l, &b, 1_000, 500, &blind, 1_000).unwrap();
        assert_ne!(loan.loan_id, [0u8; 32]);
    }

    #[test]
    fn test_lender_hash_nonzero() {
        let (l, b, blind) = make_secrets();
        let loan = new_loan(&l, &b, 1_000, 500, &blind, 1_000).unwrap();
        assert_ne!(loan.lender_hash, [0u8; 32]);
    }

    #[test]
    fn test_borrower_hash_nonzero() {
        let (l, b, blind) = make_secrets();
        let loan = new_loan(&l, &b, 1_000, 500, &blind, 1_000).unwrap();
        assert_ne!(loan.borrower_hash, [0u8; 32]);
    }

    #[test]
    fn test_principal_commitment_nonzero() {
        let (l, b, blind) = make_secrets();
        let loan = new_loan(&l, &b, 1_000, 500, &blind, 1_000).unwrap();
        assert_ne!(loan.principal_commitment, [0u8; 32]);
    }

    #[test]
    fn test_rate_commitment_nonzero() {
        let (l, b, blind) = make_secrets();
        let loan = new_loan(&l, &b, 1_000, 500, &blind, 1_000).unwrap();
        assert_ne!(loan.rate_commitment, [0u8; 32]);
    }

    #[test]
    fn test_mainnet_ready_false() {
        let (l, b, blind) = make_secrets();
        let loan = new_loan(&l, &b, 1_000, 500, &blind, 1_000).unwrap();
        assert!(!loan.mainnet_ready);
    }

    #[test]
    fn test_repaid_false_initially() {
        let (l, b, blind) = make_secrets();
        let loan = new_loan(&l, &b, 1_000, 500, &blind, 1_000).unwrap();
        assert!(!loan.repaid);
    }

    #[test]
    fn test_zero_borrower_rejected() {
        let (l, _, blind) = make_secrets();
        let err = new_loan(&l, &[0u8; 32], 1_000, 500, &blind, 1_000).unwrap_err();
        assert_eq!(err, LoanErrorV2::ZeroSecret);
    }

    #[test]
    fn test_max_rate_ok() {
        let (l, b, blind) = make_secrets();
        let result = new_loan(&l, &b, 1_000, 10_000, &blind, 1_000);
        assert!(result.is_ok());
    }

    #[test]
    fn test_due_epoch_stored() {
        let (l, b, blind) = make_secrets();
        let loan = new_loan(&l, &b, 1_000, 500, &blind, 9_999).unwrap();
        assert_eq!(loan.due_epoch, 9_999);
    }
}
