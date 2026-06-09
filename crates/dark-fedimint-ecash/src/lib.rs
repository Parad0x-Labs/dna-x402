//! # Federated eNULL — Chaumian BDHKE ecash over Ristretto (DEVNET, unaudited)
//!
//! A ceremony-free, decentralized ecash privacy rail. There is **no trusted
//! Groth16 setup** and **no single custodial mint**: a `k`-of-`n` federation of
//! guardians jointly issues blind-signed bearer tokens and threshold-controls
//! the reserve. The blind-signing math is real elliptic-curve BDHKE over the
//! Ristretto group (curve25519-dalek) — *not* the SHA256 `dark-blind-signature`
//! stub.
//!
//! ## What "hides sender + amount" means here
//! * **Amount** is hidden by fixed denominations (every token is worth exactly
//!   one denomination, like a physical coin), so on-chain amounts carry no info.
//! * **Sender** is hidden by the blinding: the federation signs a *blinded*
//!   point and never sees the token secret `x`, so it cannot link the token it
//!   signed to the token that is later redeemed (Chaumian unlinkability).
//!
//! ## BDHKE (Blind Diffie-Hellman Key Exchange) — the Cashu scheme
//! Let `G` be the Ristretto basepoint and `k` the mint secret with public key
//! `K = k·G`.
//! 1. User picks a random token secret `x`, computes `Y = H2C(x)` (hash-to-curve).
//! 2. User picks a random blinding scalar `r`, sends `B_ = Y + r·G` to the mint.
//! 3. Mint returns the blind signature `C_ = k·B_`.
//! 4. User unblinds: `C = C_ - r·K = k·Y`  (because `k·(Y+rG) - r·(kG) = k·Y`).
//! 5. The token is the bearer pair `(x, C)`. It is valid iff `C == k·H2C(x)`.
//!
//! ## On-chain redeem without revealing `k`
//! The redeem program must verify `C == k·Y` **without** knowing `k` (publishing
//! `k` would let anyone forge). The federation therefore attaches a **DLEQ proof**
//! (Cashu's actual scheme): a non-interactive Schnorr proof that the *same* `k`
//! relates `K = k·G` and `C = k·Y`. The chain stores only the public key `K`,
//! verifies the DLEQ against `(Y, C, K)`, and checks the nullifier `x` is unseen.
//! No Groth16, no exotic syscall — just two Ristretto scalar-mults and a hash.
//!
//! ## Modules
//! * [`bdhke`]     — the core blind-sign / unblind / verify primitives.
//! * [`dleq`]      — the DLEQ proof the on-chain redeem checks.
//! * [`federation`]— `k`-of-`n` DKG (Feldman VSS), threshold blind-signing, and
//!                   threshold DLEQ, so no single guardian holds `k`.
//! * [`token`]     — the redeem artifact (what the e2e harness serializes).
//!
//! HONEST STATUS: DEVNET / library only, UNAUDITED, never mainnet. The hash-to-
//! curve is the standard try-and-increment over Ristretto; constant-timeness of
//! the host path is best-effort, not audited.

#![cfg_attr(not(feature = "std"), no_std)]

pub mod bdhke;
pub mod dleq;

#[cfg(feature = "std")]
pub mod federation;
#[cfg(feature = "std")]
pub mod token;

pub use bdhke::{
    blind, hash_to_curve, nullifier, sign_blinded, unblind, verify_token, BlindedMessage, Token,
};
pub use dleq::{verify_dleq, DleqProof};

/// Library marker — this is a devnet pilot, never mainnet.
pub const MAINNET_READY: bool = false;
/// The blind-signing is real Ristretto BDHKE, not a hash stub.
pub const IS_STUB: bool = false;
