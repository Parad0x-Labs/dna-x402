//! Sealed fee quote auction for Dark Null relayers.
//!
//! Protocol:
//!   1. Relayer commits: `QuoteCommitment { hash = H(amount || nonce || relayer || receipt_hash) }`.
//!   2. Wallet picks a winner and reveals only that relayer's quote.
//!   3. Losing relayers' amounts stay hidden — their commitments are unlinkable.
//!   4. Nonce prevents replay; receipt_hash binds the quote to a specific operation.

use sha2::{Digest, Sha256};

// ── Types ─────────────────────────────────────────────────────────────────────

/// Published by a relayer before the wallet selects.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuoteCommitment {
    /// H(amount || nonce || relayer || receipt_hash)
    pub hash: [u8; 32],
    /// Relayer identity (32-byte Ed25519 public key or Solana pubkey).
    pub relayer: [u8; 32],
    /// Optional binding to a specific receipt root / operation hash.
    pub receipt_hash: [u8; 32],
}

/// The winner sends this; losers never reveal.
#[derive(Clone, Debug)]
pub struct QuoteReveal {
    pub amount_lamports: u64,
    /// Random nonce used in the commitment.
    pub nonce: [u8; 32],
    pub relayer: [u8; 32],
    pub receipt_hash: [u8; 32],
}

#[derive(Debug, PartialEq, Eq)]
pub enum QuoteError {
    /// The relayer in the reveal does not match the commitment.
    RelayerMismatch,
    /// The commitment hash does not match what the reveal computes.
    CommitmentMismatch,
    /// The receipt hash in the reveal does not match the commitment.
    ReceiptMismatch,
}

impl std::fmt::Display for QuoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            QuoteError::RelayerMismatch => write!(f, "sealed-quote: relayer mismatch"),
            QuoteError::CommitmentMismatch => write!(f, "sealed-quote: commitment mismatch"),
            QuoteError::ReceiptMismatch => write!(f, "sealed-quote: receipt hash mismatch"),
        }
    }
}

// ── Core API ──────────────────────────────────────────────────────────────────

fn compute_hash(
    amount: u64,
    nonce: &[u8; 32],
    relayer: &[u8; 32],
    receipt_hash: &[u8; 32],
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(&amount.to_le_bytes());
    h.update(nonce.as_ref());
    h.update(relayer.as_ref());
    h.update(receipt_hash.as_ref());
    h.finalize().into()
}

/// A relayer commits to a quote without revealing the amount.
pub fn commit_quote(
    amount_lamports: u64,
    nonce: &[u8; 32],
    relayer: &[u8; 32],
    receipt_hash: &[u8; 32],
) -> QuoteCommitment {
    QuoteCommitment {
        hash: compute_hash(amount_lamports, nonce, relayer, receipt_hash),
        relayer: *relayer,
        receipt_hash: *receipt_hash,
    }
}

/// Verify a reveal against its commitment and return the quoted amount.
pub fn reveal_quote(reveal: &QuoteReveal, commitment: &QuoteCommitment) -> Result<u64, QuoteError> {
    if reveal.relayer != commitment.relayer {
        return Err(QuoteError::RelayerMismatch);
    }
    if reveal.receipt_hash != commitment.receipt_hash {
        return Err(QuoteError::ReceiptMismatch);
    }
    let expected = compute_hash(
        reveal.amount_lamports,
        &reveal.nonce,
        &reveal.relayer,
        &reveal.receipt_hash,
    );
    if expected != commitment.hash {
        return Err(QuoteError::CommitmentMismatch);
    }
    Ok(reveal.amount_lamports)
}

/// Select the lowest-cost quote from a set of reveals (after verification).
pub fn select_cheapest(reveals: &[QuoteReveal], commitments: &[QuoteCommitment]) -> Option<usize> {
    reveals
        .iter()
        .enumerate()
        .filter_map(|(i, r)| {
            commitments
                .get(i)
                .and_then(|c| reveal_quote(r, c).ok().map(|amt| (i, amt)))
        })
        .min_by_key(|(_, amt)| *amt)
        .map(|(i, _)| i)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const RELAYER: [u8; 32] = [0x01; 32];
    const NONCE: [u8; 32] = [0x02; 32];
    const RECEIPT: [u8; 32] = [0x03; 32];
    const AMOUNT: u64 = 500_000;

    fn good_commit() -> QuoteCommitment {
        commit_quote(AMOUNT, &NONCE, &RELAYER, &RECEIPT)
    }

    fn good_reveal() -> QuoteReveal {
        QuoteReveal {
            amount_lamports: AMOUNT,
            nonce: NONCE,
            relayer: RELAYER,
            receipt_hash: RECEIPT,
        }
    }

    #[test]
    fn test_commit_reveal_roundtrip() {
        let c = good_commit();
        let r = good_reveal();
        assert_eq!(reveal_quote(&r, &c).unwrap(), AMOUNT);
    }

    #[test]
    fn test_relayer_mismatch() {
        let c = good_commit();
        let mut r = good_reveal();
        r.relayer = [0xFF; 32];
        assert_eq!(reveal_quote(&r, &c), Err(QuoteError::RelayerMismatch));
    }

    #[test]
    fn test_commitment_mismatch_on_wrong_amount() {
        let c = good_commit();
        let mut r = good_reveal();
        r.amount_lamports = AMOUNT + 1;
        assert_eq!(reveal_quote(&r, &c), Err(QuoteError::CommitmentMismatch));
    }

    #[test]
    fn test_receipt_mismatch() {
        let c = good_commit();
        let mut r = good_reveal();
        r.receipt_hash = [0xFF; 32];
        assert_eq!(reveal_quote(&r, &c), Err(QuoteError::ReceiptMismatch));
    }

    #[test]
    fn test_nonce_replay_prevention() {
        // Same amount, different nonce → different commitment → cannot reuse old reveal
        let c1 = commit_quote(AMOUNT, &NONCE, &RELAYER, &RECEIPT);
        let c2 = commit_quote(AMOUNT, &[0x99; 32], &RELAYER, &RECEIPT);
        assert_ne!(c1.hash, c2.hash);
        // Old reveal fails against new commitment
        let r = good_reveal();
        assert_eq!(reveal_quote(&r, &c2), Err(QuoteError::CommitmentMismatch));
    }

    #[test]
    fn test_commitment_not_zero() {
        let c = good_commit();
        assert_ne!(c.hash, [0u8; 32]);
    }

    #[test]
    fn test_select_cheapest() {
        let relayer_a = [0x0A; 32];
        let relayer_b = [0x0B; 32];
        let nonce_a = [0x10; 32];
        let nonce_b = [0x20; 32];
        let c_a = commit_quote(100_000, &nonce_a, &relayer_a, &RECEIPT);
        let c_b = commit_quote(200_000, &nonce_b, &relayer_b, &RECEIPT);
        let r_a = QuoteReveal {
            amount_lamports: 100_000,
            nonce: nonce_a,
            relayer: relayer_a,
            receipt_hash: RECEIPT,
        };
        let r_b = QuoteReveal {
            amount_lamports: 200_000,
            nonce: nonce_b,
            relayer: relayer_b,
            receipt_hash: RECEIPT,
        };
        let winner = select_cheapest(&[r_a, r_b], &[c_a, c_b]);
        assert_eq!(winner, Some(0), "relayer_a (100k) should be cheapest");
    }
}
