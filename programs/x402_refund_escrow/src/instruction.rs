//! Instruction set for the x402 refund escrow.
//!
//! `SettleSuccess` and `ProveEquivocation` carry no signature bytes themselves —
//! the seller's ed25519 signature(s) ride in separate ed25519-precompile
//! instruction(s) in the same transaction, and the processor reads them back by
//! index via the instructions sysvar. The instruction data only names *which*
//! sibling instruction(s) to read.

use crate::error::EscrowError;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EscrowInstruction {
    /// Buyer opens the escrow for one x402 call and deposits `amount` lamports.
    /// Accounts: [buyer(signer,writable), escrow_pda(writable), system_program]
    OpenEscrow {
        seller: [u8; 32],
        amount: u64,
        payment_commitment: [u8; 32],
        deadline: i64,
        dispute_window: i64,
    },
    /// Seller bonds `amount` lamports, slashable on equivocation.
    /// Accounts: [seller(signer,writable), escrow_pda(writable), system_program]
    PostBond { amount: u64 },
    /// Seller settles success by pointing at the ed25519 precompile instruction
    /// that verified their success receipt.
    /// Accounts: [seller(signer), escrow_pda(writable), seller_wallet(writable), instructions_sysvar]
    SettleSuccess { receipt_ix_index: u8 },
    /// Anyone triggers the buyer's auto-refund once the deadline passes with no
    /// success settlement. Refunds only the payment; the bond stays escrowed and
    /// slashable until maturity.
    /// Accounts: [escrow_pda(writable), buyer_wallet(writable)]
    RefundOnTimeout,
    /// Anyone proves the seller signed two conflicting receipts for this payment.
    /// Accounts: [escrow_pda(writable), buyer_wallet(writable), instructions_sysvar]
    ProveEquivocation { ix_index_a: u8, ix_index_b: u8 },
    /// After maturity on a resolved (settled or refunded) escrow with no proven
    /// equivocation, return the bond to the seller, reclaim the rent to the
    /// buyer, and close the account.
    /// Accounts: [escrow_pda(writable), seller_wallet(writable), buyer_wallet(writable)]
    CloseAfterDispute,
}

impl EscrowInstruction {
    pub fn unpack(data: &[u8]) -> Result<Self, EscrowError> {
        let (&tag, rest) = data.split_first().ok_or(EscrowError::InvalidInstruction)?;
        match tag {
            0 => {
                if rest.len() != 32 + 8 + 32 + 8 + 8 {
                    return Err(EscrowError::InvalidInstruction);
                }
                let mut seller = [0u8; 32];
                seller.copy_from_slice(&rest[0..32]);
                let amount = read_u64(&rest[32..40])?;
                let mut payment_commitment = [0u8; 32];
                payment_commitment.copy_from_slice(&rest[40..72]);
                let deadline = read_i64(&rest[72..80])?;
                let dispute_window = read_i64(&rest[80..88])?;
                Ok(Self::OpenEscrow {
                    seller,
                    amount,
                    payment_commitment,
                    deadline,
                    dispute_window,
                })
            }
            1 => {
                if rest.len() != 8 {
                    return Err(EscrowError::InvalidInstruction);
                }
                Ok(Self::PostBond {
                    amount: read_u64(rest)?,
                })
            }
            2 => {
                if rest.len() != 1 {
                    return Err(EscrowError::InvalidInstruction);
                }
                Ok(Self::SettleSuccess {
                    receipt_ix_index: rest[0],
                })
            }
            3 => {
                if !rest.is_empty() {
                    return Err(EscrowError::InvalidInstruction);
                }
                Ok(Self::RefundOnTimeout)
            }
            4 => {
                if rest.len() != 2 {
                    return Err(EscrowError::InvalidInstruction);
                }
                Ok(Self::ProveEquivocation {
                    ix_index_a: rest[0],
                    ix_index_b: rest[1],
                })
            }
            5 => {
                if !rest.is_empty() {
                    return Err(EscrowError::InvalidInstruction);
                }
                Ok(Self::CloseAfterDispute)
            }
            _ => Err(EscrowError::InvalidInstruction),
        }
    }

    pub fn pack(&self) -> Vec<u8> {
        let mut v = Vec::new();
        match self {
            Self::OpenEscrow {
                seller,
                amount,
                payment_commitment,
                deadline,
                dispute_window,
            } => {
                v.push(0);
                v.extend_from_slice(seller);
                v.extend_from_slice(&amount.to_le_bytes());
                v.extend_from_slice(payment_commitment);
                v.extend_from_slice(&deadline.to_le_bytes());
                v.extend_from_slice(&dispute_window.to_le_bytes());
            }
            Self::PostBond { amount } => {
                v.push(1);
                v.extend_from_slice(&amount.to_le_bytes());
            }
            Self::SettleSuccess { receipt_ix_index } => {
                v.push(2);
                v.push(*receipt_ix_index);
            }
            Self::RefundOnTimeout => v.push(3),
            Self::ProveEquivocation {
                ix_index_a,
                ix_index_b,
            } => {
                v.push(4);
                v.push(*ix_index_a);
                v.push(*ix_index_b);
            }
            Self::CloseAfterDispute => v.push(5),
        }
        v
    }
}

fn read_u64(b: &[u8]) -> Result<u64, EscrowError> {
    let arr: [u8; 8] = b.try_into().map_err(|_| EscrowError::InvalidInstruction)?;
    Ok(u64::from_le_bytes(arr))
}

fn read_i64(b: &[u8]) -> Result<i64, EscrowError> {
    let arr: [u8; 8] = b.try_into().map_err(|_| EscrowError::InvalidInstruction)?;
    Ok(i64::from_le_bytes(arr))
}
