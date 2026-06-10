//! # dark-kvac — Keyed-Verification Anonymous Credentials for x402 (DEVNET, unaudited)
//!
//! A **ceremony-free, pairing-free, anonymous-but-accountable** credential for the
//! x402 paid-call rail. The construction is an **algebraic-MAC keyed-verification
//! credential** (Chase–Meiklejohn–Zaverucha, *Algebraic MACs and Keyed-Verification
//! Anonymous Credentials*, CCS 2014 / eprint 2013/516), instantiated over the
//! **ristretto255** group with the same `curve25519-dalek` 3.2.1 the eNULL eCash
//! rail uses — **not** the SHA256 `dark-anon-credential*` stubs this supersedes.
//!
//! ## Why KVAC fits x402 exactly
//! In keyed-verification the **issuer is the verifier**. An x402 gateway issues a
//! credential once to an authenticated agent, then verifies every later
//! presentation with its own secret key. That removes the trusted-setup ceremony a
//! Groth16 credential needs and the pairing a BBS+/PS credential needs: verification
//! is a handful of Ristretto group-ops + one SHA-512 — cheap enough to run on-chain
//! through the `sol_curve_*` syscalls, exactly like our DLEQ redeem path.
//!
//! ## Properties (target)
//! * **Issuance**: clear-attribute (the gateway already knows the agent at issue
//!   time; anonymity is required at *presentation*, not issuance). Blind issuance
//!   is a documented v2.
//! * **Presentation unlinkability**: two shows of one credential, and a show vs its
//!   issuance, are unlinkable to everyone including the gateway — *except* via the
//!   intended per-context nullifier.
//! * **Accountability**: a per-context nullifier `n = f(cred_secret, context)` with
//!   a correctness proof gives one-action-per-identity-per-context Sybil resistance
//!   (the backbone GhostScore / one-`.null`-per-human need).
//!
//! ## Layout
//! * [`group`]      — scheme-independent Ristretto helpers: H2C, NUMS generators,
//!                    and a Fiat–Shamir transcript utility.
//! * [`fs`]         — the canonical raw-concatenation challenge serialization
//!                    (spec Part 4.3) used by issuance and presentation.
//! * [`params`]     — the 12 generators + attribute layout (Part 1).
//! * [`keys`]       — issuer keygen `sk` + published `iparams = (CW, I)` (Part 2).
//! * [`issue`]      — clear-attribute MAC + issuance proof + the `ms` PoK (Part 3).
//! * [`present`]    — the holder's unlinkable presentation prover (Part 4).
//! * [`verify`]     — the gateway's keyed verifier (Part 4.5).
//! * [`nullifier`]  — the per-context nullifier `n = ms·H_ctx` (Part 5).
//!
//! HONEST STATUS: DEVNET / library only, UNAUDITED, never mainnet. Unforgeability
//! holds in the generic-group model (CMZ Thm 2); the nullifier PRF is pseudorandom
//! under DDH in ROM. Constant-timeness of the host path is best-effort. The
//! verifier runs in the gateway (it needs `sk`); only the nullifier is recorded
//! on-chain (spec §6.2).

#![cfg_attr(not(feature = "std"), no_std)]

pub mod fs;
pub mod group;
pub mod issue;
pub mod keys;
pub mod nullifier;
pub mod params;
pub mod present;
pub mod util;
pub mod verify;
pub mod wire;

pub use issue::{commit_ms, fresh_u, issue, verify_issuance, Credential, IssuanceProof, MsPok};
pub use keys::{IssuerParams, IssuerSecretKey};
pub use nullifier::{h_ctx, nullifier};
pub use params::{attr_scalars, Generators, N_ATTRS};
pub use present::{present, Presentation, PresentRandomness};
pub use verify::verify;

/// Library marker — devnet pilot, never mainnet.
pub const MAINNET_READY: bool = false;
/// The credential is a real algebraic-MAC construction over Ristretto, not a hash stub.
pub const IS_STUB: bool = false;
