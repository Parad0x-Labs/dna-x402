//! null_fair_draw: a provably fair draw primitive for raffles, giveaways and
//! reward roll-outs.
//!
//! An organizer creates a draw with prize tiers (SOL or one SPL mint) and
//! escrows every prize before entries open or a list is committed. Entrants
//! are either added on-chain by the entrants themselves (open raffle, entries
//! appended to a SHA-256 sum tree) or committed by the organizer as the root
//! of an off-chain `(wallet, weight)` list (committed list). The randomness is
//! the SlotHashes entry of a slot fixed before anyone can know it; anyone can
//! crank, and nobody supplies randomness.
//!
//! Winners are drawn without replacement from the remaining weight
//! ([`stream`]): slot `j` takes the point `U_j mod remaining` and maps it past
//! every interval already won, so the same leaf never wins twice and every
//! crank reaches the same result. Winners claim their prize themselves during
//! the claim window; unclaimed prizes are re-drawn among the entries that
//! have not won, for up to `redraw_rounds` rounds with fresh randomness each,
//! then returned to the organizer. The program charges no fee.
//!
//! Modules: [`sumtree`] (leaf, node, proofs, append), [`stream`] (seed,
//! stream, bias-bounded reduction, without-replacement mapping), [`state`]
//! (account layout), [`instruction`] (encoding and builders, also the CPI
//! interface), [`processor`].

#[cfg(not(feature = "no-entrypoint"))]
use solana_program::{account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey};

pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;
pub mod stream;
pub mod sumtree;
pub mod token;

solana_program::declare_id!("FZxUXmGNzivQCw1nS6N6GakwyWN1PrX5ebGnS7hPjzGL");

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

#[cfg(not(feature = "no-entrypoint"))]
pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    processor::process(program_id, accounts, data)
}
