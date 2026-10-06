//! null_lottery_pools: permissionless, creator-seeded rolling-jackpot lottery pools.
//!
//! Anyone creates a pool: the creator seeds the jackpot (the seed cannot be
//! withdrawn), sets the ticket price and the odds (`k` numbers out of `1..=n`),
//! and earns a fee on ticket sales that stays at `f_max` until the seed is
//! recouped and then decays towards `f_min` (see [`econ`]). The rest of each
//! sale goes to a reserve (which seeds the next jackpot after a win) and to the
//! jackpot (capped; overflow goes to the reserve). There is no protocol fee,
//! no treasury and no admin key.
//!
//! Round life cycle (one open round per pool):
//!
//! 1. BuyTicket appends the ticket leaf to the round's on-chain incremental
//!    Merkle tree ([`tree`]); the buyer's own transaction fixes the order.
//! 2. After `close_slot`, anyone cranks Draw. The numbers come from the
//!    SlotHashes entry of a slot fixed in advance ([`draw`]). The jackpot is
//!    locked as the round's prize and the next round opens.
//! 3. During the claim window, a ticket owner registers a winning ticket with
//!    its leaf and Merkle proof (Claim). Nothing else touches the prize.
//! 4. After the window, anyone cranks Settle: the prize is split equally among
//!    the registered winning tickets (Payout, permissionless, pays the owner),
//!    or rolls over if none registered. After a win the reserve seeds the
//!    next jackpot.
//!
//! The pool account is the vault; [`processor`] checks the solvency invariant
//! at the end of every instruction.

use solana_program::{account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey};

pub mod draw;
pub mod econ;
pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;
pub mod tree;

solana_program::declare_id!("39QHCDuqugs2Fm16CtvD3SBmDJp9n2WbdNGQPtqFZSxw");

entrypoint!(process_instruction);

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    processor::process(program_id, accounts, data)
}
