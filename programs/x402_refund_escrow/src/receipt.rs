//! The canonical settlement receipt — the message a seller signs with ed25519.
//!
//! Its settle tx carries the signature through the ed25519 precompile, and the
//! program reads it back via the instructions sysvar (see `ed25519.rs`). So
//! "did the seller vouch, and for exactly what" is checked on-chain against the
//! seller's own signature — nothing off-chain has to attest.
//!
//! A seller who signs two receipts that disagree over one `payment_commitment`
//! has produced a self-signed fraud proof (`receipts_conflict`).

use crate::error::EscrowError;

/// Domain separator — a signature over this layout can't be replayed as any
/// other message this key ever signs.
pub const RECEIPT_DOMAIN: &[u8; 13] = b"NULLX402RCPT1";

pub const STATUS_FAIL: u8 = 0;
pub const STATUS_SUCCESS: u8 = 1;

/// domain[13] || payment_commitment[32] || status[1] || response_hash[32] || deadline[8 LE]
pub const RECEIPT_MSG_LEN: usize = 13 + 32 + 1 + 32 + 8; // 86

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SettleReceipt {
    pub payment_commitment: [u8; 32],
    pub status: u8,
    pub response_hash: [u8; 32],
    pub deadline: i64,
}

impl SettleReceipt {
    pub fn encode(&self) -> [u8; RECEIPT_MSG_LEN] {
        let mut m = [0u8; RECEIPT_MSG_LEN];
        m[0..13].copy_from_slice(RECEIPT_DOMAIN);
        m[13..45].copy_from_slice(&self.payment_commitment);
        m[45] = self.status;
        m[46..78].copy_from_slice(&self.response_hash);
        m[78..86].copy_from_slice(&self.deadline.to_le_bytes());
        m
    }

    pub fn decode(msg: &[u8]) -> Result<Self, EscrowError> {
        if msg.len() != RECEIPT_MSG_LEN || &msg[0..13] != RECEIPT_DOMAIN.as_slice() {
            return Err(EscrowError::ReceiptMismatch);
        }
        let status = msg[45];
        if status != STATUS_FAIL && status != STATUS_SUCCESS {
            return Err(EscrowError::ReceiptMismatch);
        }
        let mut payment_commitment = [0u8; 32];
        payment_commitment.copy_from_slice(&msg[13..45]);
        let mut response_hash = [0u8; 32];
        response_hash.copy_from_slice(&msg[46..78]);
        let mut deadline_raw = [0u8; 8];
        deadline_raw.copy_from_slice(&msg[78..86]);
        Ok(Self {
            payment_commitment,
            status,
            response_hash,
            deadline: i64::from_le_bytes(deadline_raw),
        })
    }
}

/// Two receipts are a genuine equivocation when they are about the **same**
/// payment yet the seller said contradictory things: a different status, or the
/// same "success" claim over a different response. Two identical receipts, or
/// receipts about different payments, are NOT a conflict — that guard is what
/// stops a griefer slashing a non-equivocating seller by replaying one receipt twice.
pub fn receipts_conflict(a: &SettleReceipt, b: &SettleReceipt) -> bool {
    if a.payment_commitment != b.payment_commitment {
        return false;
    }
    if a.status != b.status {
        return true;
    }
    a.status == STATUS_SUCCESS && a.response_hash != b.response_hash
}
