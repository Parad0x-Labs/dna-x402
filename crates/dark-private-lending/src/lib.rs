use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoanOffer {
    pub offer_id: [u8; 32],
    pub lender_hash: [u8; 32],
    pub principal: u64,
    pub interest_bps: u16,
    pub duration_unix: i64,
    pub collateral_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Loan {
    pub loan_id: [u8; 32],
    pub offer_id: [u8; 32],
    pub borrower_hash: [u8; 32],
    pub borrowed_at_unix: i64,
    pub due_at_unix: i64,
    pub repayment_hash: [u8; 32],
    pub repaid: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LendError {
    ZeroLenderSecret,
    ZeroBorrowerSecret,
    PrincipalZero,
    AlreadyRepaid,
    LoanOverdue { due: i64, current: i64 },
}

fn sha256(data: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for d in data {
        h.update(d);
    }
    h.finalize().into()
}

pub fn create_offer(
    lender_secret: &[u8; 32],
    principal: u64,
    interest_bps: u16,
    duration_unix: i64,
    collateral_bytes: &[u8],
) -> Result<LoanOffer, LendError> {
    if lender_secret == &[0u8; 32] {
        return Err(LendError::ZeroLenderSecret);
    }
    if principal == 0 {
        return Err(LendError::PrincipalZero);
    }
    let lender_hash = sha256(&[b"loan-lender-v1", lender_secret]);
    let collateral_hash = sha256(&[b"loan-collateral-v1", collateral_bytes]);
    let principal_le = principal.to_le_bytes();
    let interest_le = interest_bps.to_le_bytes();
    let duration_le = duration_unix.to_le_bytes();
    let offer_id = sha256(&[
        b"loan-offer-v1",
        &lender_hash,
        &principal_le,
        &interest_le,
        &duration_le,
        &collateral_hash,
    ]);
    Ok(LoanOffer {
        offer_id,
        lender_hash,
        principal,
        interest_bps,
        duration_unix,
        collateral_hash,
        mainnet_ready: false,
    })
}

pub fn take_loan(
    offer: &LoanOffer,
    borrower_secret: &[u8; 32],
    borrowed_at_unix: i64,
) -> Result<Loan, LendError> {
    if borrower_secret == &[0u8; 32] {
        return Err(LendError::ZeroBorrowerSecret);
    }
    let borrower_hash = sha256(&[b"loan-borrower-v1", borrower_secret]);
    let borrowed_at_le = borrowed_at_unix.to_le_bytes();
    let loan_id = sha256(&[b"loan-id-v1", &offer.offer_id, &borrower_hash, &borrowed_at_le]);
    let due_at_unix = borrowed_at_unix + offer.duration_unix;
    let repayment_amount = offer.principal + (offer.principal * offer.interest_bps as u64 / 10_000);
    let repayment_amount_le = repayment_amount.to_le_bytes();
    let repayment_hash = sha256(&[b"loan-repay-v1", &loan_id, &repayment_amount_le]);
    Ok(Loan {
        loan_id,
        offer_id: offer.offer_id,
        borrower_hash,
        borrowed_at_unix,
        due_at_unix,
        repayment_hash,
        repaid: false,
        mainnet_ready: false,
    })
}

pub fn repay_loan(loan: &mut Loan, current_unix: i64) -> Result<[u8; 32], LendError> {
    if loan.repaid {
        return Err(LendError::AlreadyRepaid);
    }
    if current_unix > loan.due_at_unix {
        return Err(LendError::LoanOverdue {
            due: loan.due_at_unix,
            current: current_unix,
        });
    }
    loan.repaid = true;
    Ok(loan.repayment_hash)
}

pub fn loan_public_record(loan: &Loan) -> String {
    let obj = serde_json::json!({
        "loan_id": hex_encode(loan.loan_id),
        "offer_id": hex_encode(loan.offer_id),
        "due_at_unix": loan.due_at_unix,
        "repaid": loan.repaid,
        "mainnet_ready": loan.mainnet_ready,
    });
    serde_json::to_string(&obj).unwrap()
}

fn hex_encode(b: [u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lender() -> [u8; 32] { [1u8; 32] }
    fn borrower() -> [u8; 32] { [2u8; 32] }
    fn collateral() -> &'static [u8] { b"SOL collateral" }

    #[test]
    fn test_create_take_repay_happy_path() {
        let offer = create_offer(&lender(), 1_000_000_000, 30, 86400, collateral()).unwrap();
        let mut loan = take_loan(&offer, &borrower(), 1_000_000).unwrap();
        assert_eq!(loan.due_at_unix, 1_000_000 + 86400);
        assert!(!loan.repaid);
        // repay before due
        let hash = repay_loan(&mut loan, 1_000_100).unwrap();
        assert!(loan.repaid);
        assert_eq!(hash, loan.repayment_hash);
        assert!(!loan.mainnet_ready);
    }

    #[test]
    fn test_overdue_rejected() {
        let offer = create_offer(&lender(), 1_000_000_000, 30, 86400, collateral()).unwrap();
        let mut loan = take_loan(&offer, &borrower(), 1_000_000).unwrap();
        // current > due
        let err = repay_loan(&mut loan, 1_000_000 + 86400 + 1).unwrap_err();
        assert_eq!(
            err,
            LendError::LoanOverdue {
                due: loan.due_at_unix,
                current: 1_000_000 + 86400 + 1
            }
        );
    }

    #[test]
    fn test_already_repaid_rejected() {
        let offer = create_offer(&lender(), 1_000_000_000, 30, 86400, collateral()).unwrap();
        let mut loan = take_loan(&offer, &borrower(), 1_000_000).unwrap();
        repay_loan(&mut loan, 1_000_100).unwrap();
        let err = repay_loan(&mut loan, 1_000_200).unwrap_err();
        assert_eq!(err, LendError::AlreadyRepaid);
    }

    #[test]
    fn test_zero_lender_rejected() {
        let err = create_offer(&[0u8; 32], 1_000_000_000, 30, 86400, collateral()).unwrap_err();
        assert_eq!(err, LendError::ZeroLenderSecret);
    }

    #[test]
    fn test_interest_calculation_correct() {
        // 1000 SOL at 30bps: fee = 1000 * 30 / 10000 = 3 SOL (in lamports: 3_000_000_000)
        // Using SOL as u64 units directly for simplicity: principal=1000, bps=30
        let offer = create_offer(&lender(), 1000, 30, 86400, collateral()).unwrap();
        // repayment_amount = 1000 + floor(1000 * 30 / 10000) = 1000 + 3 = 1003
        let loan = take_loan(&offer, &borrower(), 0).unwrap();
        // Recompute repayment_hash manually
        let sha256_fn = |data: &[&[u8]]| -> [u8; 32] {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            for d in data { h.update(d); }
            h.finalize().into()
        };
        let expected_repayment_amount: u64 = 1000 + 3;
        let expected_hash = sha256_fn(&[b"loan-repay-v1", &loan.loan_id, &expected_repayment_amount.to_le_bytes()]);
        assert_eq!(loan.repayment_hash, expected_hash);
    }

    #[test]
    fn test_public_record_hides_borrower() {
        let offer = create_offer(&lender(), 1_000_000_000, 30, 86400, collateral()).unwrap();
        let loan = take_loan(&offer, &borrower(), 1_000_000).unwrap();
        let record = loan_public_record(&loan);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v.get("borrower_hash").is_none());
        assert!(v.get("loan_id").is_some());
        assert_eq!(v["mainnet_ready"], false);
    }
}
