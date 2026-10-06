//! x402_settle: atomic settlement of x402 payments.
//!
//! One program, one voucher format, three lanes:
//!
//! - **B2, voucher batch.** Payers deposit into an escrow PDA. Each x402
//!   payment is an ed25519 voucher signed by the payer over a cumulative
//!   amount per payer-payee pair. [`processor`] verifies up to ~25 vouchers
//!   per transaction in the program (no precompile, so no per-voucher
//!   signature fee) and moves the deltas from escrows to payee balances held
//!   in shared book accounts.
//! - **C, channels.** A payer locks part of its escrow for one payee; the
//!   payee closes with the latest cumulative voucher (many channels per
//!   transaction). Closes the payee did not sign open a dispute window in
//!   which a newer voucher supersedes; after expiry the payer reclaims.
//! - **Two-phase batches** for B2 sets larger than one transaction: stage
//!   chunks (vouchers verified, funds reserved), then commit (all credits in
//!   one instruction) or abort (all reservations released).
//!
//! Fan-out to existing token accounts is a client-side V1 multi-transfer
//! (`packages/x402-settle`); see the README for why no instruction is added.
//!
//! Escrow withdrawals are time-locked (request, `EXIT_DELAY_SLOTS`, withdraw),
//! so vouchers already handed to payees cannot be front-run. There is no
//! protocol fee.

use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey};

pub mod crypto;
pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;
pub mod token;

solana_program::declare_id!("DFt7SG4WUiy6qpYJRLTKdcx4dvSHE1dVG5sbTfXWbfZE");

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    processor::process(program_id, accounts, data)
}
