//! On-chain Ristretto DLEQ verification via Solana's native `sol_curve_*`
//! syscalls — NOT the pure-software curve25519-dalek scalar-mult path.
//!
//! Software Ristretto scalar-mult on SBF costs >1.4M CU per mult (it blows the
//! per-instruction budget), so the redeem hot path uses the `CURVE25519_RISTRETTO`
//! group-operation syscalls, which the validator runs natively for a few thousand
//! CU each. The DLEQ verifier below does exactly the same algebra as
//! `dark_fedimint_ecash::dleq::verify_dleq` (the host/prover reference), so a proof
//! built host-side with dalek verifies here byte-for-byte.
//!
//! Algebra recomputed (Chaum–Pedersen):
//!   R1' = z·G − e·K
//!   R2' = z·Y − e·C
//!   accept iff  e == SHA512(domain ‖ G ‖ K ‖ Y ‖ C ‖ R1' ‖ R2') mod ℓ
//!
//! Only the POINT arithmetic uses syscalls. Scalar reduction
//! (`from_bytes_mod_order_wide`) is pure dalek field math — cheap and
//! stack-safe; the only dalek code that overflows the SBF stack is the basepoint
//! *table* constructor, which this module never touches (the basepoint `G` is a
//! hard-coded 32-byte constant).

use curve25519_dalek::scalar::Scalar;
use sha2::{Digest, Sha512};

// Curve / op selectors (see solana-zk-token-sdk curve_syscall_traits). Only the
// `target_os = "solana"` syscall path references these; the host fallback uses
// dalek, so allow dead_code for the host build.
#[allow(dead_code)]
const CURVE25519_RISTRETTO: u64 = 1;
#[allow(dead_code)]
const OP_SUB: u64 = 1;
#[allow(dead_code)]
const OP_MUL: u64 = 2;

/// Compressed Ristretto basepoint `G` (== `RISTRETTO_BASEPOINT_POINT.compress()`).
/// Hard-coded to avoid pulling the dalek basepoint-table constructors (which
/// overflow the SBF stack) into the program. Verified in a host test against
/// dalek's constant.
pub const RISTRETTO_BASEPOINT_COMPRESSED: [u8; 32] = [
    0xe2, 0xf2, 0xae, 0x0a, 0x6a, 0xbc, 0x4e, 0x71, 0xa8, 0x84, 0xa9, 0x61, 0xc5, 0x00, 0x51, 0x5f,
    0x58, 0xe3, 0x0b, 0x6a, 0xa5, 0x82, 0xdd, 0x8d, 0xb6, 0xa6, 0x59, 0x45, 0xe0, 0x8d, 0x2d, 0x76,
];

/// `scalar · point` via the Ristretto MUL syscall (on-chain) or dalek (host).
fn mul(scalar: &[u8; 32], point: &[u8; 32]) -> Option<[u8; 32]> {
    #[cfg(target_os = "solana")]
    {
        let mut out = [0u8; 32];
        let res = unsafe {
            solana_program::syscalls::sol_curve_group_op(
                CURVE25519_RISTRETTO,
                OP_MUL,
                scalar.as_ptr(),
                point.as_ptr(),
                out.as_mut_ptr(),
            )
        };
        if res == 0 {
            Some(out)
        } else {
            None
        }
    }
    #[cfg(not(target_os = "solana"))]
    {
        host_fallback::mul(scalar, point)
    }
}

/// `left − right` via the Ristretto SUB syscall (on-chain) or dalek (host).
fn sub(left: &[u8; 32], right: &[u8; 32]) -> Option<[u8; 32]> {
    #[cfg(target_os = "solana")]
    {
        let mut out = [0u8; 32];
        let res = unsafe {
            solana_program::syscalls::sol_curve_group_op(
                CURVE25519_RISTRETTO,
                OP_SUB,
                left.as_ptr(),
                right.as_ptr(),
                out.as_mut_ptr(),
            )
        };
        if res == 0 {
            Some(out)
        } else {
            None
        }
    }
    #[cfg(not(target_os = "solana"))]
    {
        host_fallback::sub(left, right)
    }
}

/// `e = SHA512(domain ‖ G ‖ K ‖ Y ‖ C ‖ R1 ‖ R2) mod ℓ`, returned as canonical
/// 32-byte LE. Matches `dark_fedimint_ecash::dleq::challenge` exactly.
fn challenge_e(
    k_pub: &[u8; 32],
    y: &[u8; 32],
    c: &[u8; 32],
    r1: &[u8; 32],
    r2: &[u8; 32],
) -> [u8; 32] {
    let mut h = Sha512::new();
    h.update(b"eNULL-DLEQ-v1");
    h.update(RISTRETTO_BASEPOINT_COMPRESSED);
    h.update(k_pub);
    h.update(y);
    h.update(c);
    h.update(r1);
    h.update(r2);
    let d = h.finalize();
    let mut wide = [0u8; 64];
    wide.copy_from_slice(&d);
    // Field reduction only — no curve points, no basepoint table. Cheap on SBF.
    Scalar::from_bytes_mod_order_wide(&wide).to_bytes()
}

/// Verify a DLEQ proof `(e, z)` that `C = k·Y` under `K = k·G`, syscall-backed.
/// Mirrors `dark_fedimint_ecash::dleq::verify_dleq`. `false` on any failure.
pub fn verify_dleq_syscall(
    k_pub: &[u8; 32],
    y: &[u8; 32],
    c: &[u8; 32],
    e_bytes: &[u8; 32],
    z_bytes: &[u8; 32],
) -> bool {
    // R1' = z·G − e·K
    let zg = match mul(z_bytes, &RISTRETTO_BASEPOINT_COMPRESSED) {
        Some(p) => p,
        None => return false,
    };
    let ek = match mul(e_bytes, k_pub) {
        Some(p) => p,
        None => return false,
    };
    let r1 = match sub(&zg, &ek) {
        Some(p) => p,
        None => return false,
    };

    // R2' = z·Y − e·C
    let zy = match mul(z_bytes, y) {
        Some(p) => p,
        None => return false,
    };
    let ec = match mul(e_bytes, c) {
        Some(p) => p,
        None => return false,
    };
    let r2 = match sub(&zy, &ec) {
        Some(p) => p,
        None => return false,
    };

    let e_check = challenge_e(k_pub, y, c, &r1, &r2);
    &e_check == e_bytes
}

#[cfg(not(target_os = "solana"))]
mod host_fallback {
    use curve25519_dalek::ristretto::CompressedRistretto;
    use curve25519_dalek::scalar::Scalar;

    pub fn mul(scalar: &[u8; 32], point: &[u8; 32]) -> Option<[u8; 32]> {
        let s = Scalar::from_canonical_bytes(*scalar)?;
        let p = CompressedRistretto(*point).decompress()?;
        Some((s * p).compress().to_bytes())
    }
    pub fn sub(left: &[u8; 32], right: &[u8; 32]) -> Option<[u8; 32]> {
        let l = CompressedRistretto(*left).decompress()?;
        let r = CompressedRistretto(*right).decompress()?;
        Some((l - r).compress().to_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT as G;

    #[test]
    fn basepoint_constant_matches_dalek() {
        assert_eq!(RISTRETTO_BASEPOINT_COMPRESSED, G.compress().to_bytes());
    }

    #[test]
    fn host_verify_matches_ecash_reference() {
        // Build a real DLEQ with the ecash crate and verify via this module's
        // host path — they must agree.
        use dark_fedimint_ecash::bdhke::hash_to_curve;
        use dark_fedimint_ecash::dleq::prove_dleq;
        use rand::rngs::OsRng;
        use rand::RngCore;

        let mut wide = [0u8; 64];
        OsRng.fill_bytes(&mut wide);
        let k = Scalar::from_bytes_mod_order_wide(&wide);
        let y_pt = hash_to_curve(b"syscall-parity");
        OsRng.fill_bytes(&mut wide);
        let nonce = Scalar::from_bytes_mod_order_wide(&wide);
        let proof = prove_dleq(&k, &y_pt, nonce);

        let k_pub = (k * G).compress().to_bytes();
        let c = (k * y_pt).compress().to_bytes();
        let y = y_pt.compress().to_bytes();

        assert!(verify_dleq_syscall(&k_pub, &y, &c, &proof.e, &proof.z));
        // tamper -> reject
        let mut bad = proof.z;
        bad[0] ^= 1;
        assert!(!verify_dleq_syscall(&k_pub, &y, &c, &proof.e, &bad));
    }
}
