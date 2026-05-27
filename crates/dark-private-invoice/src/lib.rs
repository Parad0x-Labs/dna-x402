use sha2::{Digest, Sha256};

pub struct Invoice {
    pub invoice_id: [u8; 32],
    pub issuer_hash: [u8; 32],
    pub recipient_hash: [u8; 32],
    pub amount_commitment: [u8; 32],
    pub due_epoch: u64,
    pub paid: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum InvoiceError {
    ZeroIssuerSecret,
    ZeroRecipientSecret,
    ZeroAmount,
    AlreadyPaid,
}

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

pub fn new_invoice(
    issuer_secret: &[u8; 32],
    recipient_secret: &[u8; 32],
    amount: u64,
    blinding: &[u8; 32],
    due_epoch: u64,
) -> Result<Invoice, InvoiceError> {
    if issuer_secret == &[0u8; 32] {
        return Err(InvoiceError::ZeroIssuerSecret);
    }
    if recipient_secret == &[0u8; 32] {
        return Err(InvoiceError::ZeroRecipientSecret);
    }
    if amount == 0 {
        return Err(InvoiceError::ZeroAmount);
    }
    let issuer_hash = sha256_multi(&[b"inv-issuer-v1", issuer_secret]);
    let recipient_hash = sha256_multi(&[b"inv-recipient-v1", recipient_secret]);
    let amount_le = amount.to_le_bytes();
    let amount_commitment = sha256_multi(&[b"inv-amount-v1", &amount_le, blinding]);
    let due_le = due_epoch.to_le_bytes();
    let invoice_id = sha256_multi(&[
        b"inv-id-v1",
        &issuer_hash,
        &recipient_hash,
        &amount_commitment,
        &due_le,
    ]);
    Ok(Invoice {
        invoice_id,
        issuer_hash,
        recipient_hash,
        amount_commitment,
        due_epoch,
        paid: false,
        mainnet_ready: false,
    })
}

pub fn pay_invoice(invoice: &mut Invoice) -> Result<(), InvoiceError> {
    if invoice.paid {
        return Err(InvoiceError::AlreadyPaid);
    }
    invoice.paid = true;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issuer() -> [u8; 32] {
        [0x11u8; 32]
    }
    fn recipient() -> [u8; 32] {
        [0x22u8; 32]
    }
    fn blinding() -> [u8; 32] {
        [0x33u8; 32]
    }

    #[test]
    fn new_invoice_mainnet_ready_false() {
        let inv = new_invoice(&issuer(), &recipient(), 1000, &blinding(), 9999999).unwrap();
        assert_eq!(inv.mainnet_ready, false);
        assert_ne!(inv.invoice_id, [0u8; 32]);
        assert_eq!(inv.paid, false);
    }

    #[test]
    fn pay_sets_paid_true() {
        let mut inv = new_invoice(&issuer(), &recipient(), 1000, &blinding(), 9999999).unwrap();
        pay_invoice(&mut inv).unwrap();
        assert_eq!(inv.paid, true);
    }

    #[test]
    fn double_pay_rejected() {
        let mut inv = new_invoice(&issuer(), &recipient(), 1000, &blinding(), 9999999).unwrap();
        pay_invoice(&mut inv).unwrap();
        let result = pay_invoice(&mut inv);
        assert_eq!(result.err(), Some(InvoiceError::AlreadyPaid));
    }

    #[test]
    fn zero_issuer_rejected() {
        let result = new_invoice(&[0u8; 32], &recipient(), 1000, &blinding(), 9999999);
        assert_eq!(result.err(), Some(InvoiceError::ZeroIssuerSecret));
    }

    #[test]
    fn zero_amount_rejected() {
        let result = new_invoice(&issuer(), &recipient(), 0, &blinding(), 9999999);
        assert_eq!(result.err(), Some(InvoiceError::ZeroAmount));
    }

    #[test]
    fn invoice_id_is_deterministic() {
        let inv1 = new_invoice(&issuer(), &recipient(), 1000, &blinding(), 9999999).unwrap();
        let inv2 = new_invoice(&issuer(), &recipient(), 1000, &blinding(), 9999999).unwrap();
        assert_eq!(inv1.invoice_id, inv2.invoice_id);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_issuer_hash_nonzero() {
        let inv = new_invoice(&issuer(), &recipient(), 1000, &blinding(), 100).unwrap();
        assert_ne!(inv.issuer_hash, [0u8; 32]);
    }

    #[test]
    fn test_recipient_hash_nonzero() {
        let inv = new_invoice(&issuer(), &recipient(), 1000, &blinding(), 100).unwrap();
        assert_ne!(inv.recipient_hash, [0u8; 32]);
    }

    #[test]
    fn test_amount_commitment_nonzero() {
        let inv = new_invoice(&issuer(), &recipient(), 1000, &blinding(), 100).unwrap();
        assert_ne!(inv.amount_commitment, [0u8; 32]);
    }

    #[test]
    fn test_mainnet_ready_false() {
        let inv = new_invoice(&issuer(), &recipient(), 1000, &blinding(), 100).unwrap();
        assert!(!inv.mainnet_ready);
    }

    #[test]
    fn test_paid_false_initially() {
        let inv = new_invoice(&issuer(), &recipient(), 1000, &blinding(), 100).unwrap();
        assert!(!inv.paid);
    }

    #[test]
    fn test_zero_recipient_rejected() {
        let result = new_invoice(&issuer(), &[0u8; 32], 1000, &blinding(), 100);
        assert_eq!(result.err(), Some(InvoiceError::ZeroRecipientSecret));
    }

    #[test]
    fn test_due_epoch_stored() {
        let inv = new_invoice(&issuer(), &recipient(), 1000, &blinding(), 42_000).unwrap();
        assert_eq!(inv.due_epoch, 42_000);
    }

    #[test]
    fn test_invoice_id_nonzero() {
        let inv = new_invoice(&issuer(), &recipient(), 1000, &blinding(), 100).unwrap();
        assert_ne!(inv.invoice_id, [0u8; 32]);
    }

    #[test]
    fn test_different_amounts_different_commitment() {
        let i1 = new_invoice(&issuer(), &recipient(), 100, &blinding(), 1).unwrap();
        let i2 = new_invoice(&issuer(), &recipient(), 200, &blinding(), 1).unwrap();
        assert_ne!(i1.amount_commitment, i2.amount_commitment);
    }

    #[test]
    fn test_different_recipient_different_invoice_id() {
        let r2 = [0x44u8; 32];
        let i1 = new_invoice(&issuer(), &recipient(), 1000, &blinding(), 1).unwrap();
        let i2 = new_invoice(&issuer(), &r2, 1000, &blinding(), 1).unwrap();
        assert_ne!(i1.invoice_id, i2.invoice_id);
    }
}
