//! Instruction encoding for the redeem program.
//!
//! Discriminators (first byte):
//!   0x00 InitMint  : data = group_pub(32) ‖ denomination(u64 LE)
//!   0x01 Fund      : data = amount(u64 LE)            (top up the reserve)
//!   0x02 Redeem    : data = y(32) ‖ c(32) ‖ dleq(64)
//!
//! In the Chaumian model the unlinkable token is `(Y, C)` where `Y = H2C(x)` is
//! the point the federation blind-signed (it never saw `Y`, only `B' = Y + rG`).
//! Revealing `Y` at redeem cannot be linked back to issuance, so `Y` itself is
//! the nullifier seed (the program derives `nullifier = SHA256(Y)` cheaply via
//! the sol_sha256 syscall). The token secret `x` never has to touch the chain,
//! which also avoids an expensive on-chain hash-to-curve.

use crate::error::RedeemError;
use solana_program::program_error::ProgramError;

pub const REDEEM_DATA_LEN: usize = 1 + 32 + 32 + 64; // disc + y + c + dleq = 129

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RedeemInstruction {
    InitMint {
        group_pub: [u8; 32],
        denomination: u64,
    },
    Fund {
        amount: u64,
    },
    Redeem {
        y: [u8; 32],
        c: [u8; 32],
        dleq: [u8; 64],
    },
}

impl RedeemInstruction {
    pub fn pack(&self) -> Vec<u8> {
        match self {
            RedeemInstruction::InitMint {
                group_pub,
                denomination,
            } => {
                let mut v = Vec::with_capacity(1 + 32 + 8);
                v.push(0x00);
                v.extend_from_slice(group_pub);
                v.extend_from_slice(&denomination.to_le_bytes());
                v
            }
            RedeemInstruction::Fund { amount } => {
                let mut v = Vec::with_capacity(9);
                v.push(0x01);
                v.extend_from_slice(&amount.to_le_bytes());
                v
            }
            RedeemInstruction::Redeem { y, c, dleq } => {
                let mut v = Vec::with_capacity(REDEEM_DATA_LEN);
                v.push(0x02);
                v.extend_from_slice(y);
                v.extend_from_slice(c);
                v.extend_from_slice(dleq);
                v
            }
        }
    }

    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        let (&disc, rest) = data
            .split_first()
            .ok_or(ProgramError::from(RedeemError::InvalidInstruction))?;
        match disc {
            0x00 => {
                if rest.len() < 40 {
                    return Err(RedeemError::InvalidInstruction.into());
                }
                let mut group_pub = [0u8; 32];
                group_pub.copy_from_slice(&rest[..32]);
                let denomination = u64::from_le_bytes(rest[32..40].try_into().unwrap());
                Ok(RedeemInstruction::InitMint {
                    group_pub,
                    denomination,
                })
            }
            0x01 => {
                if rest.len() < 8 {
                    return Err(RedeemError::InvalidInstruction.into());
                }
                let amount = u64::from_le_bytes(rest[..8].try_into().unwrap());
                Ok(RedeemInstruction::Fund { amount })
            }
            0x02 => {
                // y(32) + c(32) + dleq(64) = 128
                if rest.len() < 128 {
                    return Err(RedeemError::InvalidInstruction.into());
                }
                let mut y = [0u8; 32];
                let mut c = [0u8; 32];
                let mut dleq = [0u8; 64];
                y.copy_from_slice(&rest[0..32]);
                c.copy_from_slice(&rest[32..64]);
                dleq.copy_from_slice(&rest[64..128]);
                Ok(RedeemInstruction::Redeem { y, c, dleq })
            }
            _ => Err(RedeemError::InvalidInstruction.into()),
        }
    }
}
