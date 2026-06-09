//! # dark-fedimint-redeem — on-chain redeem for federated eNULL ecash (DEVNET)
//!
//! Releases ONE fixed denomination of a locked reserve to a recipient when
//! presented with a valid threshold-issued Chaumian token, and records the
//! token's nullifier so it can never be redeemed twice.
//!
//! ## What the chain verifies (no Groth16, no trusted setup)
//! A token is the Chaumian pair `(Y, C)` where `Y = H2C(x)` is the point the
//! federation blind-signed (it saw only `B' = Y + rG`, never `Y`), and `C = k·Y`
//! for the federation's shared mint secret `k` (held by nobody — see
//! `dark-fedimint-ecash`). The redeemer sends:
//!   * `y`    = Y   (the unlinkable token point; also the nullifier seed)
//!   * `c`    = C
//!   * `dleq` = a Chaum–Pedersen proof that `C = k·Y` under the stored `K = k·G`
//! The program:
//!   1. verifies the DLEQ against the **stored group key `K`** — proving `C` is a
//!      genuine federation signature on `Y` WITHOUT the chain ever knowing `k`.
//!      The point arithmetic uses Solana's native `sol_curve_*` Ristretto
//!      syscalls (`curve_syscall.rs`), NOT software dalek (which overflows the CU
//!      budget). Same algebra as the host `dark_fedimint_ecash::dleq` reference.
//!   2. derives `nullifier = SHA256("eNULL-NULLIFIER-v1" ‖ Y)` (cheap sol_sha256),
//!   3. checks the nullifier PDA (seed = `["nullifier", mint_config, nullifier]`)
//!      does not yet exist (reusing `dark_shielded_pool`'s nullifier-PDA pattern),
//!   4. creates that PDA (marks the token spent) and pays one `denomination` of
//!      the reserve vault to the recipient.
//!
//! Revealing `Y` at redeem is safe (Cashu model): the federation cannot link it
//! to the `B'` it signed because the blinding `r` is unknown to it. The token
//! secret `x` never touches the chain, which also avoids an expensive on-chain
//! hash-to-curve.
//!
//! ## Trust model (honest)
//! The chain trusts the single stored group key `K`. `K` is produced by a `k`-of-`n`
//! DKG, so over-issuance requires `k` colluding guardians, not one custodian. This
//! is **strictly fewer-than-k-of-N trust**, not single-custodian — the decentralized
//! win. DEVNET only, UNAUDITED, `MAINNET_READY = false`. The reserve here is SOL
//! lamports for a simple e2e; swapping to a locked-USDC SPL vault is a documented
//! follow-up (same redeem logic, SPL transfer instead of a lamport move).

pub mod curve_syscall;
pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

/// Never trustless / never mainnet from this program. DKG + threshold are real,
/// but the federation is single-process-simulated and the stack is unaudited.
pub const MAINNET_READY: bool = false;
/// The redeem verifies a real Ristretto BDHKE DLEQ — not a hash stub.
pub const IS_STUB: bool = false;

#[cfg(not(feature = "no-entrypoint"))]
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

#[cfg(not(feature = "no-entrypoint"))]
fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    processor::process_instruction(program_id, accounts, data)
}
