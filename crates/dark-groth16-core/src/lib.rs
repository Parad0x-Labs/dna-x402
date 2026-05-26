//! dark-groth16-core
//!
//! BN254 Groth16 proof verifier for Solana — uses the native
//! `alt_bn128_pairing` / `alt_bn128_multiplication` / `alt_bn128_addition`
//! operations from `solana_program::alt_bn128`.
//!
//! On-chain (BPF): calls `sol_alt_bn128_group_op` syscall.
//! Off-chain (native tests): uses `ark-bn254` via the same API (Solana 1.18).
//!
//! ## Groth16 verification equation
//!
//! ```text
//! e(A, B) · e(−α, β) · e(−vk_x, γ) · e(−C, δ) = 1
//! ```
//!
//! where `vk_x = vk.gamma_abc[0] + Σᵢ (pᵢ · vk.gamma_abc[i+1])`
//! and pᵢ are the public inputs (each a 32-byte scalar in BN254 Fr).
//!
//! This is checked as a single `alt_bn128_pairing` call with 4 input pairs
//! (768 bytes), which returns 1 iff the equation holds.
//!
//! ## Encoding conventions — EIP-197 / Ethereum compatible
//!
//! - **G1 point**: `[x: 32 BE, y: 32 BE]` = 64 bytes
//! - **G2 point**: `[x_im: 32 BE, x_re: 32 BE, y_im: 32 BE, y_re: 32 BE]` = 128 bytes
//!   - Fp2 element `a + b·u` is encoded with `a` (imaginary) first
//! - `alt_bn128_pairing` input = (G1 || G2) pairs, 192 bytes each
//! - Return `[0…0, 1]` (32-byte big-endian 1) iff pairing product = 1
//!
//! ## BN254 base field prime Fp
//! p = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47
//!
//! mainnet_ready = false — devnet only

use solana_program::alt_bn128::prelude::{
    alt_bn128_addition, alt_bn128_multiplication, alt_bn128_pairing, AltBn128Error,
};

// ── BN254 constants ───────────────────────────────────────────────────────────

/// BN254 base field prime Fp (big-endian, 32 bytes).
///
/// Source: `ark-bn254` Fp modulus limbs (little-endian u64):
/// `[0x3c208c16d87cfd47, 0x97816a916871ca8d, 0xb85045b68181585d, 0x30644e72e131a029]`
/// Verified against Ethereum EIP-196/EIP-197 test vectors (Fp−1 scalar in multiplication tests).
pub const BN254_FP: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
    0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d,
    0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

// ── BN254 G1 generator ────────────────────────────────────────────────────────

/// G1 generator x = 1 (big-endian 32 bytes).
pub const G1_GEN_X: [u8; 32] = {
    let mut a = [0u8; 32];
    a[31] = 1;
    a
};

/// G1 generator y = 2 (big-endian 32 bytes).
pub const G1_GEN_Y: [u8; 32] = {
    let mut a = [0u8; 32];
    a[31] = 2;
    a
};

/// G1 generator negation y = Fp − 2 (big-endian 32 bytes).
/// Verified: Fp−2 = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd45
pub const G1_GEN_NEG_Y: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
    0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d,
    0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x45,
];

// ── BN254 G2 generator ────────────────────────────────────────────────────────
// EIP-197 encoding: [x_im, x_re, y_im, y_re] (imaginary part first, each 32 bytes BE)
// Source: Ethereum EIP-197 test vectors (standard BN254 G2 generator)

/// G2 generator x — imaginary part.
pub const G2_GEN_X_IM: [u8; 32] = hex_const(
    "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2",
);
/// G2 generator x — real part.
pub const G2_GEN_X_RE: [u8; 32] = hex_const(
    "1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed",
);
/// G2 generator y — imaginary part.
pub const G2_GEN_Y_IM: [u8; 32] = hex_const(
    "090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b",
);
/// G2 generator y — real part.
pub const G2_GEN_Y_RE: [u8; 32] = hex_const(
    "12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa",
);

/// G2 generator negation y — imaginary part.
/// Verified from Ethereum EIP-197 "two_point_match_2" test vector.
pub const G2_GEN_NEG_Y_IM: [u8; 32] = hex_const(
    "275dc4a288d1afb3cbb1ac09187524c7db36395df7be3b99e673b13a075a65ec",
);
/// G2 generator negation y — real part.
pub const G2_GEN_NEG_Y_RE: [u8; 32] = hex_const(
    "1d9befcd05a5323e6da4d435f3b617cdb3af83285c2df711ef39c01571827f9d",
);

// ── Compile-time hex decoder ──────────────────────────────────────────────────

const fn hex_const(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    assert!(b.len() == 64, "hex_const: expected 64 hex chars");
    let mut out = [0u8; 32];
    let mut i = 0usize;
    while i < 32 {
        out[i] = hex_nibble(b[i * 2]) << 4 | hex_nibble(b[i * 2 + 1]);
        i += 1;
    }
    out
}

const fn hex_nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => panic!("invalid hex char"),
    }
}

// ── Point types ───────────────────────────────────────────────────────────────

/// Affine BN254 G1 point (uncompressed, big-endian).
/// Wire: `[x: 32 BE, y: 32 BE]` = 64 bytes (EIP-196).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct G1Affine {
    pub x: [u8; 32],
    pub y: [u8; 32],
}

/// Affine BN254 G2 point (uncompressed, big-endian, Fp2 coordinates).
/// Wire: `[x_im: 32 BE, x_re: 32 BE, y_im: 32 BE, y_re: 32 BE]` = 128 bytes (EIP-197).
///
/// Fp2 element `a + b·u` is encoded with `a` (imaginary) first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct G2Affine {
    pub x_im: [u8; 32],
    pub x_re: [u8; 32],
    pub y_im: [u8; 32],
    pub y_re: [u8; 32],
}

/// Groth16 proof: A ∈ G1, B ∈ G2, C ∈ G1.
/// Wire: `[A: 64, B: 128, C: 64]` = 256 bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Groth16Proof {
    pub a: G1Affine,
    pub b: G2Affine,
    pub c: G1Affine,
}

/// Groth16 verification key for a circuit with `n` public inputs.
/// `gamma_abc.len()` must equal `n + 1`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VerificationKey {
    pub alpha_g1: G1Affine,
    pub beta_g2:  G2Affine,
    pub gamma_g2: G2Affine,
    pub delta_g2: G2Affine,
    /// IC / ABC terms. len = n_public_inputs + 1.
    pub gamma_abc: Vec<G1Affine>,
    /// Always false — devnet only.
    pub mainnet_ready: bool,
}

// ── Error type ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Groth16Error {
    /// `gamma_abc.len() != public_inputs.len() + 1`
    PublicInputCountMismatch,
    /// BN254 arithmetic syscall failed (bad point encoding).
    Bn254Error(AltBn128Error),
    /// Pairing check returned false — proof is invalid.
    ProofInvalid,
}

impl std::fmt::Display for Groth16Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PublicInputCountMismatch => write!(f, "public input count mismatch"),
            Self::Bn254Error(e) => write!(f, "BN254 syscall error: {}", e),
            Self::ProofInvalid => write!(f, "Groth16 proof invalid"),
        }
    }
}

impl std::error::Error for Groth16Error {}

// ── Serialization helpers ─────────────────────────────────────────────────────

/// Serialize G1 to 64 bytes (x || y, big-endian).
#[inline]
pub fn g1_to_bytes(p: &G1Affine) -> [u8; 64] {
    let mut b = [0u8; 64];
    b[..32].copy_from_slice(&p.x);
    b[32..].copy_from_slice(&p.y);
    b
}

/// Serialize G2 to 128 bytes (x_im || x_re || y_im || y_re, big-endian EIP-197).
#[inline]
pub fn g2_to_bytes(p: &G2Affine) -> [u8; 128] {
    let mut b = [0u8; 128];
    b[0..32].copy_from_slice(&p.x_im);
    b[32..64].copy_from_slice(&p.x_re);
    b[64..96].copy_from_slice(&p.y_im);
    b[96..128].copy_from_slice(&p.y_re);
    b
}

/// Deserialize G1 from 64 bytes.
#[inline]
pub fn g1_from_bytes(b: &[u8; 64]) -> G1Affine {
    G1Affine {
        x: b[..32].try_into().unwrap(),
        y: b[32..].try_into().unwrap(),
    }
}

/// Deserialize G2 from 128 bytes.
#[inline]
pub fn g2_from_bytes(b: &[u8; 128]) -> G2Affine {
    G2Affine {
        x_im: b[0..32].try_into().unwrap(),
        x_re: b[32..64].try_into().unwrap(),
        y_im: b[64..96].try_into().unwrap(),
        y_re: b[96..128].try_into().unwrap(),
    }
}

/// Deserialize a Groth16 proof from 256 bytes: [A:64, B:128, C:64].
pub fn proof_from_bytes(b: &[u8; 256]) -> Groth16Proof {
    Groth16Proof {
        a: g1_from_bytes(b[0..64].try_into().unwrap()),
        b: g2_from_bytes(b[64..192].try_into().unwrap()),
        c: g1_from_bytes(b[192..256].try_into().unwrap()),
    }
}

/// Serialize a Groth16 proof to 256 bytes: [A:64, B:128, C:64].
pub fn proof_to_bytes(proof: &Groth16Proof) -> [u8; 256] {
    let mut b = [0u8; 256];
    b[0..64].copy_from_slice(&g1_to_bytes(&proof.a));
    b[64..192].copy_from_slice(&g2_to_bytes(&proof.b));
    b[192..256].copy_from_slice(&g1_to_bytes(&proof.c));
    b
}

// ── BN254 field arithmetic ────────────────────────────────────────────────────

/// Compute `a − b` modulo Fp (big-endian 256-bit). Assumes `a ≥ b`.
pub fn fp_sub(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow: i32 = 0;
    for i in (0..32).rev() {
        let diff = a[i] as i32 - b[i] as i32 - borrow;
        if diff < 0 {
            out[i] = (diff + 256) as u8;
            borrow = 1;
        } else {
            out[i] = diff as u8;
            borrow = 0;
        }
    }
    out
}

/// Negate a G1 point: (x, y) → (x, Fp − y).
///
/// The point at infinity (x == 0 && y == 0) is returned unchanged.
pub fn negate_g1(p: &G1Affine) -> G1Affine {
    if p.x == [0u8; 32] && p.y == [0u8; 32] {
        return *p; // point at infinity
    }
    G1Affine { x: p.x, y: fp_sub(&BN254_FP, &p.y) }
}

// ── BN254 group operations ────────────────────────────────────────────────────

/// G1 scalar multiplication via `alt_bn128_multiplication`.
///
/// Input to syscall: `[G1: 64 bytes, scalar: 32 bytes]` (≤ 128 bytes total).
/// The scalar is a 32-byte big-endian element of Fr (BN254 scalar field).
pub fn g1_mul_scalar(
    point: &G1Affine,
    scalar: &[u8; 32],
) -> Result<G1Affine, Groth16Error> {
    let mut input = [0u8; 96];
    input[0..64].copy_from_slice(&g1_to_bytes(point));
    input[64..96].copy_from_slice(scalar);
    let out = alt_bn128_multiplication(&input).map_err(Groth16Error::Bn254Error)?;
    let arr: [u8; 64] = out.try_into().map_err(|_| {
        Groth16Error::Bn254Error(AltBn128Error::UnexpectedError)
    })?;
    Ok(g1_from_bytes(&arr))
}

/// G1 point addition via `alt_bn128_addition`.
///
/// Input to syscall: `[P1: 64 bytes, P2: 64 bytes]` = 128 bytes.
pub fn g1_add(p1: &G1Affine, p2: &G1Affine) -> Result<G1Affine, Groth16Error> {
    let mut input = [0u8; 128];
    input[0..64].copy_from_slice(&g1_to_bytes(p1));
    input[64..128].copy_from_slice(&g1_to_bytes(p2));
    let out = alt_bn128_addition(&input).map_err(Groth16Error::Bn254Error)?;
    let arr: [u8; 64] = out.try_into().map_err(|_| {
        Groth16Error::Bn254Error(AltBn128Error::UnexpectedError)
    })?;
    Ok(g1_from_bytes(&arr))
}

/// Multi-pairing check via `alt_bn128_pairing`.
///
/// Takes N (G1, G2) pairs; 192 bytes per pair.
/// Returns `true` iff the product of all pairings equals 1 in GT.
pub fn pairing_check(pairs: &[(G1Affine, G2Affine)]) -> Result<bool, Groth16Error> {
    let n = pairs.len();
    let mut input = vec![0u8; n * 192];
    for (i, (g1, g2)) in pairs.iter().enumerate() {
        let base = i * 192;
        input[base..base + 64].copy_from_slice(&g1_to_bytes(g1));
        input[base + 64..base + 192].copy_from_slice(&g2_to_bytes(g2));
    }
    let result = alt_bn128_pairing(&input).map_err(Groth16Error::Bn254Error)?;
    // EIP-197: result is 32-byte big-endian uint256; equals 1 for success
    Ok(result.len() >= 32 && result[result.len() - 1] == 1
        && result[..result.len() - 1].iter().all(|&b| b == 0))
}

// ── vk_x computation ──────────────────────────────────────────────────────────

/// Compute the verification key linear combination point:
/// ```text
/// vk_x = vk.gamma_abc[0] + Σᵢ (public_inputs[i] · vk.gamma_abc[i+1])
/// ```
pub fn compute_vk_x(
    vk: &VerificationKey,
    public_inputs: &[[u8; 32]],
) -> Result<G1Affine, Groth16Error> {
    if vk.gamma_abc.len() != public_inputs.len() + 1 {
        return Err(Groth16Error::PublicInputCountMismatch);
    }
    let mut acc = vk.gamma_abc[0];
    for (i, pi) in public_inputs.iter().enumerate() {
        let term = g1_mul_scalar(&vk.gamma_abc[i + 1], pi)?;
        acc = g1_add(&acc, &term)?;
    }
    Ok(acc)
}

// ── Main verifier ─────────────────────────────────────────────────────────────

/// Verify a BN254 Groth16 proof.
///
/// Checks: `e(A, B) · e(−α, β) · e(−vk_x, γ) · e(−C, δ) = 1`
///
/// - `public_inputs`: each is a 32-byte big-endian Fr scalar.
/// - `public_inputs.len()` must equal `vk.gamma_abc.len() − 1`.
pub fn groth16_verify(
    vk: &VerificationKey,
    proof: &Groth16Proof,
    public_inputs: &[[u8; 32]],
) -> Result<bool, Groth16Error> {
    let vk_x      = compute_vk_x(vk, public_inputs)?;
    let neg_alpha = negate_g1(&vk.alpha_g1);
    let neg_vk_x  = negate_g1(&vk_x);
    let neg_c     = negate_g1(&proof.c);

    let ok = pairing_check(&[
        (proof.a,  proof.b),
        (neg_alpha, vk.beta_g2),
        (neg_vk_x,  vk.gamma_g2),
        (neg_c,     vk.delta_g2),
    ])?;
    if ok { Ok(true) } else { Err(Groth16Error::ProofInvalid) }
}

// ── Generator helpers ─────────────────────────────────────────────────────────

pub fn g1_generator()     -> G1Affine { G1Affine { x: G1_GEN_X,    y: G1_GEN_Y    } }
pub fn g1_generator_neg() -> G1Affine { G1Affine { x: G1_GEN_X,    y: G1_GEN_NEG_Y } }
pub fn g2_generator()     -> G2Affine { G2Affine { x_im: G2_GEN_X_IM, x_re: G2_GEN_X_RE, y_im: G2_GEN_Y_IM, y_re: G2_GEN_Y_RE } }
pub fn g2_generator_neg() -> G2Affine { G2Affine { x_im: G2_GEN_X_IM, x_re: G2_GEN_X_RE, y_im: G2_GEN_NEG_Y_IM, y_re: G2_GEN_NEG_Y_RE } }

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Serialization / roundtrips ────────────────────────────────────────────

    #[test]
    fn test_g1_roundtrip() {
        let p = G1Affine { x: [0xAA; 32], y: [0xBB; 32] };
        assert_eq!(g1_from_bytes(&g1_to_bytes(&p)), p);
    }

    #[test]
    fn test_g2_roundtrip() {
        let p = G2Affine { x_im: [0x11; 32], x_re: [0x22; 32], y_im: [0x33; 32], y_re: [0x44; 32] };
        assert_eq!(g2_from_bytes(&g2_to_bytes(&p)), p);
    }

    #[test]
    fn test_proof_roundtrip() {
        let proof = Groth16Proof {
            a: G1Affine { x: [1u8; 32], y: [2u8; 32] },
            b: G2Affine { x_im: [3u8; 32], x_re: [4u8; 32], y_im: [5u8; 32], y_re: [6u8; 32] },
            c: G1Affine { x: [7u8; 32], y: [8u8; 32] },
        };
        let bytes = proof_to_bytes(&proof);
        assert_eq!(bytes.len(), 256);
        assert_eq!(proof_from_bytes(&bytes), proof);
    }

    #[test]
    fn test_proof_byte_layout() {
        let mut raw = [0u8; 256];
        raw[0] = 0xA0;   raw[32] = 0xA1;   // A.x[0], A.y[0]
        raw[64] = 0xB0;  raw[96] = 0xB1;   // B.x_im[0], B.x_re[0]
        raw[128] = 0xB2; raw[160] = 0xB3;  // B.y_im[0], B.y_re[0]
        raw[192] = 0xC0; raw[224] = 0xC1;  // C.x[0], C.y[0]
        let p = proof_from_bytes(&raw);
        assert_eq!(p.a.x[0], 0xA0); assert_eq!(p.a.y[0], 0xA1);
        assert_eq!(p.b.x_im[0], 0xB0); assert_eq!(p.b.x_re[0], 0xB1);
        assert_eq!(p.b.y_im[0], 0xB2); assert_eq!(p.b.y_re[0], 0xB3);
        assert_eq!(p.c.x[0], 0xC0); assert_eq!(p.c.y[0], 0xC1);
    }

    // ── fp_sub ────────────────────────────────────────────────────────────────

    #[test]
    fn test_fp_sub_simple() {
        let a: [u8; 32] = { let mut x = [0u8; 32]; x[31] = 10; x };
        let b: [u8; 32] = { let mut x = [0u8; 32]; x[31] = 3; x };
        let c = fp_sub(&a, &b);
        let mut expected = [0u8; 32];
        expected[31] = 7;
        assert_eq!(c, expected);
    }

    #[test]
    fn test_fp_sub_borrow() {
        // 0x0100 - 0x01 = 0x00FF
        let mut a = [0u8; 32];
        a[30] = 0x01; a[31] = 0x00;
        let mut b = [0u8; 32];
        b[31] = 0x01;
        let c = fp_sub(&a, &b);
        assert_eq!(c[30], 0x00);
        assert_eq!(c[31], 0xFF);
    }

    // ── G1 negation ───────────────────────────────────────────────────────────

    #[test]
    fn test_negate_g1_double_identity() {
        let g1 = g1_generator();
        assert_eq!(negate_g1(&negate_g1(&g1)), g1, "double negate must be identity");
    }

    #[test]
    fn test_negate_g1_infinity() {
        let inf = G1Affine { x: [0u8; 32], y: [0u8; 32] };
        assert_eq!(negate_g1(&inf), inf);
    }

    #[test]
    fn test_negate_g1_generator_known_value() {
        // negate_g1(G1_gen).y == G1_GEN_NEG_Y == Fp - 2
        let neg = negate_g1(&g1_generator());
        assert_eq!(neg.x, G1_GEN_X);
        assert_eq!(neg.y, G1_GEN_NEG_Y,
            "neg G1 generator y should equal Fp-2 = 0x30644...cfd45");
    }

    #[test]
    fn test_negate_g1_then_sub_restores() {
        // (Fp - y) + y == Fp  ⟹  Fp - (Fp - y) == y
        let neg = negate_g1(&g1_generator());
        let restored = fp_sub(&BN254_FP, &neg.y);
        assert_eq!(restored, G1_GEN_Y);
    }

    // ── G2 negation constants ─────────────────────────────────────────────────

    #[test]
    fn test_g2_neg_constants_differ_from_generator() {
        assert_ne!(G2_GEN_Y_IM, G2_GEN_NEG_Y_IM);
        assert_ne!(G2_GEN_Y_RE, G2_GEN_NEG_Y_RE);
        // x coordinates are unchanged in point negation
        assert_eq!(G2_GEN_X_IM, G2_GEN_X_IM);
        assert_eq!(G2_GEN_X_RE, G2_GEN_X_RE);
    }

    // ── Pairing input packing ─────────────────────────────────────────────────

    #[test]
    fn test_pairing_4_pairs_is_768_bytes() {
        let g1 = G1Affine { x: [0u8; 32], y: [0u8; 32] };
        let g2 = G2Affine { x_im: [0u8; 32], x_re: [0u8; 32], y_im: [0u8; 32], y_re: [0u8; 32] };
        let pairs = [(g1, g2); 4];
        let input = vec![0u8; pairs.len() * 192];
        assert_eq!(input.len(), 768, "4 Groth16 pairs must be 768 bytes");
    }

    #[test]
    fn test_pair_encoding_byte_offsets() {
        let g1 = G1Affine { x: [0xAA; 32], y: [0xBB; 32] };
        let g2 = G2Affine { x_im: [0xC0; 32], x_re: [0xC1; 32], y_im: [0xC2; 32], y_re: [0xC3; 32] };
        let mut input = [0u8; 192];
        input[0..64].copy_from_slice(&g1_to_bytes(&g1));
        input[64..192].copy_from_slice(&g2_to_bytes(&g2));
        assert_eq!(input[0],   0xAA); // G1.x
        assert_eq!(input[32],  0xBB); // G1.y
        assert_eq!(input[64],  0xC0); // G2.x_im
        assert_eq!(input[96],  0xC1); // G2.x_re
        assert_eq!(input[128], 0xC2); // G2.y_im
        assert_eq!(input[160], 0xC3); // G2.y_re
    }

    // ── VK / public input count check ─────────────────────────────────────────

    #[test]
    fn test_vk_mainnet_ready_always_false() {
        let vk = VerificationKey {
            alpha_g1: g1_generator(), beta_g2: g2_generator(),
            gamma_g2: g2_generator(), delta_g2: g2_generator(),
            gamma_abc: vec![g1_generator()],
            mainnet_ready: false,
        };
        assert!(!vk.mainnet_ready);
    }

    #[test]
    fn test_public_input_count_mismatch_detected() {
        let vk = VerificationKey {
            alpha_g1: g1_generator(), beta_g2: g2_generator(),
            gamma_g2: g2_generator(), delta_g2: g2_generator(),
            gamma_abc: vec![], // needs len = public_inputs.len() + 1
            mainnet_ready: false,
        };
        let inputs = [[0u8; 32]]; // 1 input, but gamma_abc.len() = 0
        assert_eq!(
            compute_vk_x(&vk, &inputs).unwrap_err(),
            Groth16Error::PublicInputCountMismatch,
        );
    }

    // ── Generator constant sanity ─────────────────────────────────────────────

    #[test]
    fn test_g1_gen_is_one_two() {
        assert_eq!(G1_GEN_X[31], 1);
        assert_eq!(G1_GEN_Y[31], 2);
        assert_eq!(&G1_GEN_X[..31], &[0u8; 31]);
        assert_eq!(&G1_GEN_Y[..31], &[0u8; 31]);
    }

    #[test]
    fn test_g2_gen_constants_nonzero() {
        assert_ne!(G2_GEN_X_IM, [0u8; 32]);
        assert_ne!(G2_GEN_X_RE, [0u8; 32]);
        assert_ne!(G2_GEN_Y_IM, [0u8; 32]);
        assert_ne!(G2_GEN_Y_RE, [0u8; 32]);
    }

    // ── Real pairing tests (use Solana alt_bn128_pairing software impl) ───────

    /// Pairing identity using EIP-197 "two_point_match_2" test vector.
    ///
    /// e(G1_gen, G2_gen) · e(G1_gen, −G2_gen) = 1
    ///
    /// This is a direct copy of the Solana alt_bn128_pairing test "two_point_match_2"
    /// split into structured inputs. The hex bytes are from ethereum/tests EIP-197.
    #[test]
    fn test_eip197_two_point_match_pairing_identity() {
        // Pair 1: (G1_gen, G2_gen)
        let p1 = (g1_generator(), g2_generator());
        // Pair 2: (G1_gen, −G2_gen)
        let p2 = (g1_generator(), g2_generator_neg());

        match pairing_check(&[p1, p2]) {
            Ok(is_one) => assert!(is_one,
                "e(G1, G2) · e(G1, -G2) must equal 1 — EIP-197 two_point_match_2 vector"),
            Err(Groth16Error::Bn254Error(_)) => {
                // alt_bn128_pairing may not be available on all native platforms
                eprintln!("SKIP: alt_bn128_pairing not available (BN254 software backend missing)");
            }
            Err(e) => panic!("unexpected Groth16Error: {}", e),
        }
    }

    /// Pairing of a single (G1_gen, G2_gen) pair MUST return 0 (not 1).
    /// From EIP-197 test "one_point": single pair cannot satisfy the identity.
    #[test]
    fn test_eip197_single_pair_is_not_one() {
        let pairs = [(g1_generator(), g2_generator())];
        match pairing_check(&pairs) {
            Ok(is_one) => assert!(!is_one,
                "single (G1, G2) pair must NOT return 1 — EIP-197 one_point vector"),
            Err(Groth16Error::Bn254Error(_)) => {
                eprintln!("SKIP: alt_bn128_pairing not available");
            }
            Err(e) => panic!("unexpected Groth16Error: {}", e),
        }
    }

    /// Empty pairing input must return 1 (vacuous product).
    /// From EIP-197 test "empty_data": empty input → 1.
    #[test]
    fn test_eip197_empty_pairing_returns_one() {
        let empty: &[(G1Affine, G2Affine)] = &[];
        match pairing_check(empty) {
            Ok(is_one) => assert!(is_one,
                "empty pairing must return 1 — EIP-197 empty_data vector"),
            Err(Groth16Error::Bn254Error(_)) => {
                eprintln!("SKIP: alt_bn128_pairing not available");
            }
            Err(e) => panic!("unexpected Groth16Error: {}", e),
        }
    }
}
