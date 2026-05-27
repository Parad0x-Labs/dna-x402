use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct Escrow {
    pub escrow_id: [u8; 32],
    pub party_a_hash: [u8; 32],
    pub party_b_hash: [u8; 32],
    pub arbiter_hash: [u8; 32],
    pub amount_commitment: [u8; 32],
    pub released_to: Option<u8>, // 0=party_a, 1=party_b
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum EscrowError {
    ZeroSecret,
    AlreadyReleased,
    InvalidParty,
}

fn sha256_tagged(tag: &[u8], data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(tag);
    h.update(data);
    h.finalize().into()
}

fn sha256_tagged3(tag: &[u8], a: &[u8], b: &[u8], c: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(tag);
    h.update(a);
    h.update(b);
    h.update(c);
    h.finalize().into()
}

pub fn new_escrow(
    party_a_secret: &[u8; 32],
    party_b_secret: &[u8; 32],
    arbiter_secret: &[u8; 32],
    amount: u64,
    blinding: &[u8; 32],
) -> Result<Escrow, EscrowError> {
    if party_a_secret == &[0u8; 32] || party_b_secret == &[0u8; 32] || arbiter_secret == &[0u8; 32]
    {
        return Err(EscrowError::ZeroSecret);
    }
    let party_a_hash = sha256_tagged(b"escrow2-party-v1", party_a_secret);
    let party_b_hash = sha256_tagged(b"escrow2-party-v1", party_b_secret);
    let arbiter_hash = sha256_tagged(b"escrow2-arbiter-v1", arbiter_secret);
    let amount_le8 = amount.to_le_bytes();
    let amount_commitment = {
        let mut h = Sha256::new();
        h.update(b"escrow2-amount-v1");
        h.update(amount_le8);
        h.update(blinding);
        h.finalize().into()
    };
    let escrow_id = sha256_tagged3(
        b"escrow2-id-v1",
        &party_a_hash,
        &party_b_hash,
        &arbiter_hash,
    );
    Ok(Escrow {
        escrow_id,
        party_a_hash,
        party_b_hash,
        arbiter_hash,
        amount_commitment,
        released_to: None,
        mainnet_ready: false,
    })
}

pub fn release(escrow: &mut Escrow, to_party: u8) -> Result<(), EscrowError> {
    if escrow.released_to.is_some() {
        return Err(EscrowError::AlreadyReleased);
    }
    if to_party > 1 {
        return Err(EscrowError::InvalidParty);
    }
    escrow.released_to = Some(to_party);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_secrets() -> ([u8; 32], [u8; 32], [u8; 32], [u8; 32]) {
        let mut a = [0u8; 32];
        a[0] = 0xAA;
        let mut b = [0u8; 32];
        b[0] = 0xBB;
        let mut arb = [0u8; 32];
        arb[0] = 0xCC;
        let mut blind = [0u8; 32];
        blind[0] = 0xDD;
        (a, b, arb, blind)
    }

    #[test]
    fn new_escrow_mainnet_ready_false() {
        let (a, b, arb, blind) = make_secrets();
        let e = new_escrow(&a, &b, &arb, 1_000_000, &blind).unwrap();
        assert!(!e.mainnet_ready);
        assert!(e.released_to.is_none());
        assert_ne!(e.escrow_id, [0u8; 32]);
    }

    #[test]
    fn release_to_party_a() {
        let (a, b, arb, blind) = make_secrets();
        let mut e = new_escrow(&a, &b, &arb, 1_000_000, &blind).unwrap();
        release(&mut e, 0).unwrap();
        assert_eq!(e.released_to, Some(0));
    }

    #[test]
    fn double_release_is_rejected() {
        let (a, b, arb, blind) = make_secrets();
        let mut e = new_escrow(&a, &b, &arb, 1_000_000, &blind).unwrap();
        release(&mut e, 1).unwrap();
        let err = release(&mut e, 0).unwrap_err();
        assert_eq!(err, EscrowError::AlreadyReleased);
    }

    #[test]
    fn invalid_party_is_rejected() {
        let (a, b, arb, blind) = make_secrets();
        let mut e = new_escrow(&a, &b, &arb, 1_000_000, &blind).unwrap();
        let err = release(&mut e, 2).unwrap_err();
        assert_eq!(err, EscrowError::InvalidParty);
    }

    #[test]
    fn zero_secret_is_rejected() {
        let (_, b, arb, blind) = make_secrets();
        let err = new_escrow(&[0u8; 32], &b, &arb, 1_000_000, &blind).unwrap_err();
        assert_eq!(err, EscrowError::ZeroSecret);
    }

    #[test]
    fn escrow_id_is_deterministic() {
        let (a, b, arb, blind) = make_secrets();
        let e1 = new_escrow(&a, &b, &arb, 1_000_000, &blind).unwrap();
        let e2 = new_escrow(&a, &b, &arb, 1_000_000, &blind).unwrap();
        assert_eq!(e1.escrow_id, e2.escrow_id);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_party_a_hash_nonzero() {
        let (a, b, arb, blind) = make_secrets();
        let e = new_escrow(&a, &b, &arb, 500, &blind).unwrap();
        assert_ne!(e.party_a_hash, [0u8; 32]);
    }

    #[test]
    fn test_party_b_hash_nonzero() {
        let (a, b, arb, blind) = make_secrets();
        let e = new_escrow(&a, &b, &arb, 500, &blind).unwrap();
        assert_ne!(e.party_b_hash, [0u8; 32]);
    }

    #[test]
    fn test_arbiter_hash_nonzero() {
        let (a, b, arb, blind) = make_secrets();
        let e = new_escrow(&a, &b, &arb, 500, &blind).unwrap();
        assert_ne!(e.arbiter_hash, [0u8; 32]);
    }

    #[test]
    fn test_amount_commitment_nonzero() {
        let (a, b, arb, blind) = make_secrets();
        let e = new_escrow(&a, &b, &arb, 500, &blind).unwrap();
        assert_ne!(e.amount_commitment, [0u8; 32]);
    }

    #[test]
    fn test_released_to_none_initially() {
        let (a, b, arb, blind) = make_secrets();
        let e = new_escrow(&a, &b, &arb, 500, &blind).unwrap();
        assert!(e.released_to.is_none());
    }

    #[test]
    fn test_release_to_party_b() {
        let (a, b, arb, blind) = make_secrets();
        let mut e = new_escrow(&a, &b, &arb, 500, &blind).unwrap();
        release(&mut e, 1).unwrap();
        assert_eq!(e.released_to, Some(1));
    }

    #[test]
    fn test_escrow_id_nonzero() {
        let (a, b, arb, blind) = make_secrets();
        let e = new_escrow(&a, &b, &arb, 500, &blind).unwrap();
        assert_ne!(e.escrow_id, [0u8; 32]);
    }

    #[test]
    fn test_zero_party_b_rejected() {
        let (a, _, arb, blind) = make_secrets();
        let err = new_escrow(&a, &[0u8; 32], &arb, 500, &blind).unwrap_err();
        assert_eq!(err, EscrowError::ZeroSecret);
    }

    #[test]
    fn test_zero_arbiter_rejected() {
        let (a, b, _, blind) = make_secrets();
        let err = new_escrow(&a, &b, &[0u8; 32], 500, &blind).unwrap_err();
        assert_eq!(err, EscrowError::ZeroSecret);
    }

    #[test]
    fn test_amount_commitment_amount_sensitive() {
        let (a, b, arb, blind) = make_secrets();
        let e1 = new_escrow(&a, &b, &arb, 100, &blind).unwrap();
        let e2 = new_escrow(&a, &b, &arb, 200, &blind).unwrap();
        assert_ne!(e1.amount_commitment, e2.amount_commitment);
    }
}
