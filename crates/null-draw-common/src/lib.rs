//! Shared on-chain helpers of `null_lottery_pools` and `null_fair_draw`.
//!
//! - [`slot_hashes`]: which SlotHashes entry a draw uses. The target slot is
//!   fixed before anyone can know its hash; once it ages out of the 512-entry
//!   window a fixed fallback slot is used, so every crank in the same period
//!   gets the same hash and nobody supplies randomness.
//! - [`pda`]: create a program-owned PDA in a way that a lamport transfer to
//!   the address before creation cannot block (allocate + assign instead of
//!   create_account when the address already holds lamports).

pub mod pda;
pub mod slot_hashes;
