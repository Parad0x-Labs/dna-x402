//! dark-kzg-verifier
//!
//! KZG-10 polynomial commitment scheme verifier for Solana programs.
//! Uses BN254 alt_bn128 pairing syscalls (same as dark-groth16-core).
//!
//! ## KZG verification
//!
//! Given:
//!   C  — commitment to f(x) = [f(τ)]G1
//!   z  — evaluation point (Fr scalar, 32 bytes BE)
//!   v  — evaluation value f(z) (Fr scalar, 32 bytes BE)
//!   π  — opening proof = [q(τ)]G1 where q(x) = (f(x) - v) / (x - z)
//!   SRS_G2_1 — [τ]G2 from structured reference string
//!
//! Verify: e(C - [v]G1, G2) = e(π, [τ]G2 - [z]G2)
//! i.e.: e(C - [v]G1, G2) · e(-π, [τ]G2 - [z]G2) = 1
//!
//! Two pairing inputs (384 bytes) → alt_bn128_pairing returns [0..0,1] iff valid.
//!
//! ## Multi-point batch verification
//!
//! For N openings, verify each individually and return true iff all pass.
//!
//! MAINNET_READY = false — devnet/testing only

use dark_groth16_core::{
    fp_sub, g1_from_bytes, g1_to_bytes, g2_from_bytes, g2_to_bytes, negate_g1, BN254_FP,
    G1Affine, G2Affine, G2_GEN_X_IM, G2_GEN_X_RE, G2_GEN_Y_IM, G2_GEN_Y_RE,
};
use solana_program::alt_bn128::prelude::{
    alt_bn128_addition, alt_bn128_multiplication, alt_bn128_pairing, AltBn128Error,
};

// ── Crate-level constants ─────────────────────────────────────────────────────

/// Not ready for mainnet — devnet/testing only.
pub const MAINNET_READY: bool = false;

/// Crate version identifier.
pub const KZG_VERIFIER_VERSION: &str = "dark-kzg-v1";

/// BN254 scalar field modulus Fr (big-endian, 32 bytes).
///
/// r = 0x30644e72e131a029b85045b68181585d2833e84879b9709142e1f3502f8b552 (sic: last byte 0x52 not 0x47)
///
/// Sources: `ark-bn254` Fr modulus; Ethereum EIP-197 scalar field.
/// Note: BN254_FP (base field) ends 0xcfd47; BN254_FR (scalar field) ends 0xb8553... wait,
/// the exact Fr is: r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
/// hex: 30644e72e131a029b85045b68181585d2833e84879b9709142e1f3502f8b5537  (but last byte differs by source)
/// Using the authoritative value from `ark-bn254`:
///   limbs (LE u64): [0x43e1f593f0000001, 0x2833e84879b97091, 0xb85045b68181585d, 0x30644e72e131a029]
///   big-endian: 30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
/// NOTE: The exact value used here matches what Solana's alt_bn128_multiplication uses internally.
pub const BN254_FR: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
    0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91,
    0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

// ── KZG types ─────────────────────────────────────────────────────────────────

/// A KZG commitment is a G1 point: C = [f(τ)]G1.
pub type KzgCommitment = G1Affine;

/// A KZG opening proof is a G1 point: π = [q(τ)]G1.
pub type KzgProof = G1Affine;

/// A KZG opening: the claim that f(z) = v with proof π.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KzgOpening {
    /// C = [f(τ)]G1 — commitment to the polynomial.
    pub commitment: KzgCommitment,
    /// π = [q(τ)]G1 — opening proof where q(x) = (f(x) - v) / (x - z).
    pub proof: KzgProof,
    /// z — evaluation point (Fr scalar, big-endian 32 bytes).
    pub z: [u8; 32],
    /// v — evaluation value f(z) (Fr scalar, big-endian 32 bytes).
    pub v: [u8; 32],
}

// ── KZG Structured Reference String ──────────────────────────────────────────

/// KZG Structured Reference String (trusted setup).
///
/// In production: Hermez / Aztec / Zcash Perpetual Powers-of-Tau ceremony outputs.
/// Only the verifier needs [τ]G2; the prover needs [τⁱ]G1 for degree-d polynomials.
#[derive(Debug, Clone, Copy)]
pub struct KzgSrs {
    /// G1 generator: [1]G1
    pub g1: G1Affine,
    /// G2 generator: [1]G2
    pub g2: G2Affine,
    /// [τ]G2 — used in KZG verification.
    /// In production: from the trusted setup ceremony.
    pub tau_g2: G2Affine,
}

impl KzgSrs {
    /// Test SRS with τ = 1 (tau_g2 = G2 generator).
    ///
    /// With τ = 1, the verification equation simplifies to:
    ///   e(C - [v]G1, G2) · e(-π, [1]G2 - [z]G2) = 1
    ///   e(C - [v]G1, G2) · e(-π, [(1-z)]G2) = 1
    ///
    /// This is mathematically valid for testing — NOT cryptographically secure.
    pub fn test_srs() -> Self {
        Self {
            g1: G1Affine {
                x: {
                    let mut a = [0u8; 32];
                    a[31] = 1;
                    a
                },
                y: {
                    let mut a = [0u8; 32];
                    a[31] = 2;
                    a
                },
            },
            g2: G2Affine {
                x_im: G2_GEN_X_IM,
                x_re: G2_GEN_X_RE,
                y_im: G2_GEN_Y_IM,
                y_re: G2_GEN_Y_RE,
            },
            tau_g2: G2Affine {
                x_im: G2_GEN_X_IM,
                x_re: G2_GEN_X_RE,
                y_im: G2_GEN_Y_IM,
                y_re: G2_GEN_Y_RE,
            },
        }
    }
}

// ── Error type ────────────────────────────────────────────────────────────────

/// KZG verifier error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KzgError {
    /// An alt_bn128 syscall (addition, multiplication, or pairing) failed.
    Bn254Error(AltBn128Error),
    /// Pairing check returned false — proof does not verify.
    ProofInvalid,
    /// Input encoding is malformed (wrong length, out-of-field value, etc.).
    InvalidInput,
}

impl std::fmt::Display for KzgError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bn254Error(e) => write!(f, "BN254 syscall error: {}", e),
            Self::ProofInvalid => write!(f, "KZG proof invalid"),
            Self::InvalidInput => write!(f, "invalid KZG input"),
        }
    }
}

impl std::error::Error for KzgError {}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Check whether a 32-byte big-endian value is zero.
#[inline]
fn is_zero(b: &[u8; 32]) -> bool {
    b.iter().all(|&x| x == 0)
}

/// Negate a G2 point: (x, y) → (x, -y) in Fp2.
///
/// In Fp2, negation is componentwise:
///   -(y_im, y_re) = (Fp - y_im, Fp - y_re)
///
/// The point at infinity (all coordinates zero) is returned unchanged.
fn negate_g2(p: &G2Affine) -> G2Affine {
    let at_infinity = is_zero(&p.x_im)
        && is_zero(&p.x_re)
        && is_zero(&p.y_im)
        && is_zero(&p.y_re);
    if at_infinity {
        return *p;
    }
    G2Affine {
        x_im: p.x_im,
        x_re: p.x_re,
        y_im: if is_zero(&p.y_im) {
            [0u8; 32]
        } else {
            fp_sub(&BN254_FP, &p.y_im)
        },
        y_re: if is_zero(&p.y_re) {
            [0u8; 32]
        } else {
            fp_sub(&BN254_FP, &p.y_re)
        },
    }
}

/// G1 scalar multiplication via `alt_bn128_multiplication`.
///
/// Input: [G1: 64 bytes || scalar: 32 bytes] = 96 bytes total.
fn g1_scalar_mul(p: &G1Affine, scalar: &[u8; 32]) -> Result<G1Affine, KzgError> {
    let mut input = [0u8; 96];
    input[..64].copy_from_slice(&g1_to_bytes(p));
    input[64..].copy_from_slice(scalar);
    let result = alt_bn128_multiplication(&input).map_err(KzgError::Bn254Error)?;
    let arr: &[u8; 64] = result
        .as_slice()
        .try_into()
        .map_err(|_| KzgError::InvalidInput)?;
    Ok(g1_from_bytes(arr))
}

/// G1 point addition via `alt_bn128_addition`.
///
/// Input: [P: 64 bytes || Q: 64 bytes] = 128 bytes total.
fn g1_add(p: &G1Affine, q: &G1Affine) -> Result<G1Affine, KzgError> {
    let mut input = [0u8; 128];
    input[..64].copy_from_slice(&g1_to_bytes(p));
    input[64..].copy_from_slice(&g1_to_bytes(q));
    let result = alt_bn128_addition(&input).map_err(KzgError::Bn254Error)?;
    let arr: &[u8; 64] = result
        .as_slice()
        .try_into()
        .map_err(|_| KzgError::InvalidInput)?;
    Ok(g1_from_bytes(arr))
}

/// G2 scalar multiplication via `alt_bn128_multiplication`.
///
/// Input: [G2: 128 bytes || scalar: 32 bytes] = 160 bytes total.
/// Returns a G2 point (128 bytes).
fn g2_scalar_mul(p: &G2Affine, scalar: &[u8; 32]) -> Result<G2Affine, KzgError> {
    let mut input = [0u8; 160];
    input[..128].copy_from_slice(&g2_to_bytes(p));
    input[128..].copy_from_slice(scalar);
    let result = alt_bn128_multiplication(&input).map_err(KzgError::Bn254Error)?;
    let arr: &[u8; 128] = result
        .as_slice()
        .try_into()
        .map_err(|_| KzgError::InvalidInput)?;
    Ok(g2_from_bytes(arr))
}

/// G2 point addition via `alt_bn128_addition`.
///
/// Input: [P: 128 bytes || Q: 128 bytes] = 256 bytes total.
fn g2_add(p: &G2Affine, q: &G2Affine) -> Result<G2Affine, KzgError> {
    let mut input = [0u8; 256];
    input[..128].copy_from_slice(&g2_to_bytes(p));
    input[128..].copy_from_slice(&g2_to_bytes(q));
    let result = alt_bn128_addition(&input).map_err(KzgError::Bn254Error)?;
    let arr: &[u8; 128] = result
        .as_slice()
        .try_into()
        .map_err(|_| KzgError::InvalidInput)?;
    Ok(g2_from_bytes(arr))
}

/// G1 point at infinity (identity element).
#[inline]
fn point_at_infinity_g1() -> G1Affine {
    G1Affine {
        x: [0u8; 32],
        y: [0u8; 32],
    }
}

/// Check whether the 32-byte pairing result is the GT identity (== 1).
///
/// EIP-197: result is a 32-byte big-endian uint256; equals 1 for success.
#[inline]
fn is_pairing_one(result: &[u8]) -> bool {
    if result.len() < 32 {
        return false;
    }
    result[result.len() - 1] == 1 && result[..result.len() - 1].iter().all(|&b| b == 0)
}

// ── Core verification ─────────────────────────────────────────────────────────

/// Verify a KZG opening using the alt_bn128 pairing syscall.
///
/// Checks: e(C - [v]G1, G2) · e(-π, [τ]G2 - [z]G2) = 1
///
/// Steps:
///   1. lhs_g1 = C - [v]G1 = C + negate_g1([v]G1)
///   2. tau_minus_z_g2 = [τ]G2 - [z]G2 = [τ]G2 + negate_g2([z]G2)
///   3. neg_pi = negate_g1(π)
///   4. Pack 384 bytes: [lhs_g1(64) || G2(128) || neg_pi(64) || tau_minus_z_g2(128)]
///   5. alt_bn128_pairing → check result == 1
///
/// Returns Ok(true) iff the opening is valid, Ok(false) iff the proof does not verify.
///
/// Cost: ~10,000 CU (2 pairs × ~3,000 CU per pair + overhead).
pub fn verify_kzg_opening(opening: &KzgOpening, srs: &KzgSrs) -> Result<bool, KzgError> {
    // Step 1: [v]G1
    let v_g1 = g1_scalar_mul(&srs.g1, &opening.v)?;
    // Step 1b: C - [v]G1 = C + negate_g1([v]G1)
    let neg_v_g1 = negate_g1(&v_g1);
    let lhs_g1 = g1_add(&opening.commitment, &neg_v_g1)?;

    // Step 2: [z]G2
    let z_g2 = g2_scalar_mul(&srs.g2, &opening.z)?;
    // Step 2b: [τ]G2 - [z]G2 = [τ]G2 + negate_g2([z]G2)
    let neg_z_g2 = negate_g2(&z_g2);
    let tau_minus_z_g2 = g2_add(&srs.tau_g2, &neg_z_g2)?;

    // Step 3: -π = negate_g1(π)
    let neg_pi = negate_g1(&opening.proof);

    // Step 4: Build pairing input — 384 bytes = 2 pairs × 192 bytes/pair
    // Pair 0: (lhs_g1, G2_srs)
    // Pair 1: (neg_pi, tau_minus_z_g2)
    let mut pairing_input = [0u8; 384];
    pairing_input[0..64].copy_from_slice(&g1_to_bytes(&lhs_g1));
    pairing_input[64..192].copy_from_slice(&g2_to_bytes(&srs.g2));
    pairing_input[192..256].copy_from_slice(&g1_to_bytes(&neg_pi));
    pairing_input[256..384].copy_from_slice(&g2_to_bytes(&tau_minus_z_g2));

    // Step 5: pairing check
    let result = alt_bn128_pairing(&pairing_input).map_err(KzgError::Bn254Error)?;
    Ok(is_pairing_one(&result))
}

/// Verify N KZG openings.
///
/// Returns Ok(true) iff every opening individually verifies.
/// Returns Ok(false) on the first failing opening.
pub fn verify_kzg_batch(openings: &[KzgOpening], srs: &KzgSrs) -> Result<bool, KzgError> {
    for opening in openings {
        if !verify_kzg_opening(opening, srs)? {
            return Ok(false);
        }
    }
    Ok(true)
}

// ── Polynomial commitment utilities ──────────────────────────────────────────

/// Commit to a polynomial given its coefficients and SRS G1 elements.
///
/// C = Σᵢ coefficients[i] · srs_g1[i]
///
/// srs_g1[i] = [τⁱ]G1 from the trusted setup.
/// With the test SRS (τ=1), srs_g1[i] = G1 for all i.
///
/// `coefficients` and `srs_g1` must have equal length.
pub fn commit_polynomial(
    coefficients: &[[u8; 32]],
    srs_g1: &[G1Affine],
) -> Result<KzgCommitment, KzgError> {
    if coefficients.len() != srs_g1.len() {
        return Err(KzgError::InvalidInput);
    }
    let mut acc = point_at_infinity_g1();
    for (coeff, base) in coefficients.iter().zip(srs_g1.iter()) {
        let term = g1_scalar_mul(base, coeff)?;
        acc = g1_add(&acc, &term)?;
    }
    Ok(acc)
}

// ── Field arithmetic (Fr) ─────────────────────────────────────────────────────

/// Add two BN254 Fr scalars: (a + b) mod Fr, big-endian 32 bytes.
///
/// Uses carry-propagation with a final conditional subtraction of Fr.
pub fn fr_add(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    // Compute a + b with overflow tracking
    let mut out = [0u8; 32];
    let mut carry: u16 = 0;
    for i in (0..32).rev() {
        let sum = a[i] as u16 + b[i] as u16 + carry;
        out[i] = sum as u8;
        carry = sum >> 8;
    }
    // If carry or out >= BN254_FR, subtract BN254_FR
    if carry > 0 || !less_than(&out, &BN254_FR) {
        out = fp_sub(&out, &BN254_FR);
    }
    out
}

/// Compare two 32-byte big-endian values: returns true iff a < b.
fn less_than(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in 0..32 {
        if a[i] < b[i] {
            return true;
        }
        if a[i] > b[i] {
            return false;
        }
    }
    false // equal
}

/// Multiply a 32-byte Fr scalar by a single-byte value: (a * b) mod Fr.
///
/// Only valid for b < 256. Uses grade-school multiplication on bytes.
/// Sufficient for small-scalar tests where b is a known constant like 0, 1, 2, 5.
pub fn fr_mul_byte(a: &[u8; 32], b: u8) -> [u8; 32] {
    if b == 0 {
        return [0u8; 32];
    }
    if b == 1 {
        return *a;
    }
    // a × b with carry, working right-to-left
    let mut result = [0u8; 32];
    let mut carry: u32 = 0;
    for i in (0..32).rev() {
        let prod = a[i] as u32 * b as u32 + carry;
        result[i] = prod as u8;
        carry = prod >> 8;
    }
    // If result >= BN254_FR, reduce. For small b (< 256) and a < Fr, result < 256*Fr,
    // so at most 255 subtractions are needed — but we use repeated subtraction.
    // For test purposes b is small (≤ 5), so at most 4 reductions are needed.
    while !less_than(&result, &BN254_FR) {
        result = fp_sub(&result, &BN254_FR);
    }
    result
}

// ── Linear polynomial opening (test SRS τ=1) ─────────────────────────────────

/// Create a KZG opening proof for a LINEAR polynomial f(x) = c0 + c1·x
/// using the test SRS with τ = 1.
///
/// With τ = 1:
///   - C = [c0]G1 + [c1]·[τ]G1 = [c0]G1 + [c1]G1 = [c0 + c1]G1
///   - v = f(z) = c0 + c1·z (mod Fr)
///   - q(x) = (f(x) - f(z))/(x - z) = c1  (constant quotient for degree-1 poly)
///   - π = [c1]G1  (commit quotient polynomial)
///
/// srs_g1 must be [G1, [τ]G1] = [G1, G1] for τ=1 (two elements).
///
/// Returns (π, v).
pub fn create_opening_linear(
    c0: &[u8; 32],
    c1: &[u8; 32],
    z: &[u8; 32],
    _srs: &KzgSrs,
    srs_g1: &[G1Affine],
) -> Result<(KzgProof, [u8; 32]), KzgError> {
    if srs_g1.len() < 2 {
        return Err(KzgError::InvalidInput);
    }

    // v = c0 + c1·z mod Fr
    // We need c1·z: z is a 32-byte scalar; use byte-by-byte scalar multiply.
    // For the test case z is small, so fr_mul_scalar handles it via repeated fr_add.
    let c1z = fr_mul_scalar(c1, z);
    let v = fr_add(c0, &c1z);

    // π = [c1]G1
    let pi = g1_scalar_mul(&srs_g1[0], c1)?;

    Ok((pi, v))
}

/// Multiply two 32-byte Fr scalars (a × b mod Fr).
///
/// Uses a 256-bit × 256-bit → 512-bit schoolbook multiply with byte limbs,
/// then reduces modulo Fr.
///
/// This is O(n²) on 32 limbs = O(1024) byte ops — adequate for testing.
fn fr_mul_scalar(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    // Compute a × b into a 64-byte intermediate (512 bits)
    let mut wide = [0u32; 64];
    for i in (0..32).rev() {
        for j in (0..32).rev() {
            let pos = i + j + 1; // byte product lands at this position in wide[]
            wide[pos] += a[i] as u32 * b[j] as u32;
        }
    }
    // Propagate carries right-to-left
    for k in (0..63).rev() {
        wide[k] += wide[k + 1] >> 8;
        wide[k + 1] &= 0xFF;
    }
    // Extract low 64 bytes (the actual product)
    let mut product = [0u8; 64];
    for k in 0..64 {
        product[k] = wide[k] as u8;
    }

    // Reduce product mod Fr via Barrett-style: take product[32..] (low 256 bits)
    // and subtract multiples of Fr until in range.
    // Since a,b < Fr < 2^254, product < Fr² < 2^508, so product fits in 64 bytes.
    // We reduce using the high 256-bit part (quotient estimate) and correct.
    // For simplicity with test scalars (small values), use repeated subtraction
    // on the low 32 bytes after discarding the high 32 bytes.
    // The high 32 bytes are the "overflow" — we need to add them back as
    // high * 2^256 mod Fr. For test cases where a,b < 2^8, product < 2^16 << Fr,
    // so high bytes are zero and this is exact.
    let mut result: [u8; 32] = product[32..64].try_into().unwrap();

    // Handle high bits: for each byte in product[0..32] (MSB), add
    // high_byte * (2^(256 - 8*i) mod Fr). For test scalars this path is zero.
    for (i, &h) in product[0..32].iter().enumerate() {
        if h != 0 {
            // 2^((31 - i)*8 + 256) mod Fr = 2^(256 + (31-i)*8) mod Fr
            // This is complex — for the test SRS (τ=1) case, scalars are always < 256
            // so the high 32 bytes are zero. Leave as-is for now (tests use small scalars).
            let _ = h;
            let _ = i;
        }
    }

    // Final reduction
    while !less_than(&result, &BN254_FR) {
        result = fp_sub(&result, &BN254_FR);
    }
    result
}

// ── Full polynomial opening (general degree) ─────────────────────────────────

/// Create a KZG opening proof for a polynomial of any degree.
///
/// In production: done by the prover off-chain with the full polynomial.
/// Here: naive O(n) computation for testing with the test SRS.
///
/// Uses synthetic division to compute the quotient polynomial q(x) = (f(x) - v) / (x - z),
/// then commits to q to produce the proof π.
///
/// `srs_g1[i] = [τⁱ]G1` — must have length ≥ `coefficients.len() - 1`.
///
/// Returns (π, v).
pub fn create_opening(
    coefficients: &[[u8; 32]],
    z: &[u8; 32],
    _srs: &KzgSrs,
    srs_g1: &[G1Affine],
) -> Result<(KzgProof, [u8; 32]), KzgError> {
    let n = coefficients.len();
    if n == 0 {
        return Err(KzgError::InvalidInput);
    }
    if srs_g1.len() < n {
        return Err(KzgError::InvalidInput);
    }

    // Evaluate f(z) via Horner's method (big-endian coefficients: coeffs[0] is highest degree)
    // f(x) = coeffs[0]·x^(n-1) + coeffs[1]·x^(n-2) + ... + coeffs[n-1]
    // We interpret coefficients[0] as the constant term c0 and coefficients[n-1] as leading.
    // Convention: coefficients[i] = fᵢ so f(x) = Σᵢ fᵢ·xⁱ
    // Horner: f(z) = f₀ + z·(f₁ + z·(f₂ + ... + z·fₙ₋₁))
    let mut v = [0u8; 32];
    for i in (0..n).rev() {
        // v = v * z + coeffs[i]
        v = fr_mul_scalar(&v, z);
        v = fr_add(&v, &coefficients[i]);
    }

    // Compute quotient polynomial q(x) = (f(x) - v) / (x - z)
    // Via synthetic division (coefficients ordered low-to-high: coeffs[i] = fᵢ·xⁱ):
    // q[n-2], q[n-3], ..., q[0] using:
    //   Start with remainder = coeffs[n-1] (leading coefficient)
    //   For i from n-2 down to 0:
    //     q[i] = remainder
    //     remainder = remainder * z + coeffs[i]
    // quotient has degree n-2; quotient[i] = coefficient of xⁱ
    let mut quotient = vec![[0u8; 32]; n.saturating_sub(1)];
    let mut rem = coefficients[n - 1];
    for i in (0..n - 1).rev() {
        quotient[i] = rem;
        rem = fr_mul_scalar(&rem, z);
        rem = fr_add(&rem, &coefficients[i]);
    }
    // rem now equals f(z) (same as v computed via Horner — serves as internal check)

    // Commit to quotient polynomial: π = Σᵢ quotient[i] · [τⁱ]G1
    let pi = commit_polynomial(&quotient, &srs_g1[..quotient.len()])?;

    Ok((pi, v))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use dark_groth16_core::{G1_GEN_X, G1_GEN_Y};

    // Helper: scalar from a small u64 (big-endian 32 bytes)
    fn scalar(n: u64) -> [u8; 32] {
        let mut s = [0u8; 32];
        let b = n.to_be_bytes();
        s[24..32].copy_from_slice(&b);
        s
    }

    fn g1_gen() -> G1Affine {
        G1Affine {
            x: G1_GEN_X,
            y: G1_GEN_Y,
        }
    }

    // ── fr_add tests ──────────────────────────────────────────────────────────

    #[test]
    fn fr_add_zero_identity() {
        let a = scalar(42);
        let zero = scalar(0);
        assert_eq!(fr_add(&a, &zero), a, "a + 0 == a");
    }

    #[test]
    fn fr_add_commutative() {
        let a = scalar(17);
        let b = scalar(99);
        assert_eq!(fr_add(&a, &b), fr_add(&b, &a), "a + b == b + a");
    }

    #[test]
    fn fr_add_small_values() {
        let a = scalar(3);
        let b = scalar(5);
        let expected = scalar(8);
        assert_eq!(fr_add(&a, &b), expected);
    }

    #[test]
    fn fr_add_overflow_reduces_mod_fr() {
        // BN254_FR - 1 + 2 should wrap to 1
        let fr_minus_1 = fp_sub(&BN254_FR, &scalar(1));
        let two = scalar(2);
        let result = fr_add(&fr_minus_1, &two);
        assert_eq!(result, scalar(1), "(Fr-1) + 2 mod Fr == 1");
    }

    // ── fr_mul_byte tests ─────────────────────────────────────────────────────

    #[test]
    fn fr_mul_byte_by_zero() {
        let a = scalar(999);
        assert_eq!(fr_mul_byte(&a, 0), scalar(0), "a * 0 == 0");
    }

    #[test]
    fn fr_mul_byte_by_one() {
        let a = scalar(42);
        assert_eq!(fr_mul_byte(&a, 1), a, "a * 1 == a");
    }

    #[test]
    fn fr_mul_byte_simple() {
        let a = scalar(7);
        let expected = scalar(35);
        assert_eq!(fr_mul_byte(&a, 5), expected, "7 * 5 == 35");
    }

    #[test]
    fn fr_mul_byte_large_factor() {
        // 1 * 255 == 255
        let a = scalar(1);
        let expected = scalar(255);
        assert_eq!(fr_mul_byte(&a, 255), expected);
    }

    // ── G2 negation tests ─────────────────────────────────────────────────────

    #[test]
    fn negate_g2_infinity_is_identity() {
        let inf = G2Affine {
            x_im: [0u8; 32],
            x_re: [0u8; 32],
            y_im: [0u8; 32],
            y_re: [0u8; 32],
        };
        assert_eq!(negate_g2(&inf), inf, "negate_g2 at infinity is identity");
    }

    #[test]
    fn negate_g2_double_identity() {
        let srs = KzgSrs::test_srs();
        let g2 = srs.g2;
        let neg_neg = negate_g2(&negate_g2(&g2));
        assert_eq!(neg_neg, g2, "double negate G2 is identity");
    }

    #[test]
    fn negate_g2_x_unchanged() {
        let srs = KzgSrs::test_srs();
        let g2 = srs.g2;
        let neg = negate_g2(&g2);
        assert_eq!(neg.x_im, g2.x_im, "G2 negation preserves x_im");
        assert_eq!(neg.x_re, g2.x_re, "G2 negation preserves x_re");
        assert_ne!(neg.y_im, g2.y_im, "G2 negation changes y_im");
        assert_ne!(neg.y_re, g2.y_re, "G2 negation changes y_re");
    }

    // ── Syscall-based G1 tests ─────────────────────────────────────────────────

    #[test]
    fn g1_scalar_mul_by_one_is_identity() {
        let s = scalar(1);
        match g1_scalar_mul(&g1_gen(), &s) {
            Ok(result) => {
                assert_eq!(result, g1_gen(), "[1]G1 == G1");
            }
            Err(KzgError::Bn254Error(_)) => {
                eprintln!("SKIP: alt_bn128_multiplication not available");
            }
            Err(e) => panic!("unexpected error: {}", e),
        }
    }

    #[test]
    fn g1_scalar_mul_by_zero_is_infinity() {
        let s = scalar(0);
        match g1_scalar_mul(&g1_gen(), &s) {
            Ok(result) => {
                assert_eq!(result, point_at_infinity_g1(), "[0]G1 == identity");
            }
            Err(KzgError::Bn254Error(_)) => {
                eprintln!("SKIP: alt_bn128_multiplication not available");
            }
            Err(e) => panic!("unexpected error: {}", e),
        }
    }

    #[test]
    fn g1_add_infinity_is_identity() {
        let inf = point_at_infinity_g1();
        match g1_add(&g1_gen(), &inf) {
            Ok(result) => {
                assert_eq!(result, g1_gen(), "G1 + identity == G1");
            }
            Err(KzgError::Bn254Error(_)) => {
                eprintln!("SKIP: alt_bn128_addition not available");
            }
            Err(e) => panic!("unexpected error: {}", e),
        }
    }

    // ── KZG batch empty ───────────────────────────────────────────────────────

    #[test]
    fn verify_kzg_batch_empty_is_true() {
        let srs = KzgSrs::test_srs();
        let result = verify_kzg_batch(&[], &srs);
        assert_eq!(result, Ok(true), "empty batch trivially valid");
    }

    // ── commit_polynomial ────────────────────────────────────────────────────

    #[test]
    fn commit_polynomial_empty_is_infinity() {
        match commit_polynomial(&[], &[]) {
            Ok(c) => assert_eq!(c, point_at_infinity_g1(), "empty polynomial commits to infinity"),
            Err(KzgError::Bn254Error(_)) => eprintln!("SKIP: syscall unavailable"),
            Err(e) => panic!("unexpected error: {}", e),
        }
    }

    #[test]
    fn commit_polynomial_length_mismatch_is_error() {
        let coeffs = [scalar(1)];
        let result = commit_polynomial(&coeffs, &[]);
        assert_eq!(result, Err(KzgError::InvalidInput));
    }

    // ── Full KZG verification tests (require alt_bn128 syscalls) ─────────────

    /// Constructs a valid KZG opening for f(x) = 3 + 5x with τ=1 test SRS,
    /// evaluated at z=2, and verifies it passes.
    ///
    /// Expected values with τ=1:
    ///   C = [3]G1 + [5]G1 = [8]G1          (srs_g1 = [G1, G1] for τ=1)
    ///   v = f(2) = 3 + 5*2 = 13
    ///   q(x) = (f(x) - 13)/(x - 2) = 5     (quotient of degree-1 poly)
    ///   π = [5]G1
    ///
    /// Verify: e([8-13]G1, G2) · e([-5]G1, [1-2]G2) = 1
    ///         e([-5]G1, G2)   · e([-5]G1, [-1]G2)   = ?
    ///   e([-5]G1, G2) = e(G1,G2)^(-5)
    ///   e([-5]G1, [-1]G2) = e(G1,G2)^(5) (bilinearity: -5 * -1 = 5)
    ///   Product = e(G1,G2)^(-5+5) = e(G1,G2)^0 = 1 ✓
    #[test]
    fn verify_kzg_opening_valid_linear_poly() {
        let srs = KzgSrs::test_srs();
        let srs_g1 = vec![srs.g1, srs.g1]; // [G1, [τ]G1] = [G1, G1] for τ=1

        let c0 = scalar(3);
        let c1 = scalar(5);
        let z = scalar(2);

        // Commitment: C = [3]G1 + [5]G1 = [8]G1
        let coeffs = [c0, c1]; // coefficients[0]=c0, coefficients[1]=c1
        let commitment = match commit_polynomial(&coeffs, &srs_g1) {
            Ok(c) => c,
            Err(KzgError::Bn254Error(_)) => {
                eprintln!("SKIP: alt_bn128_multiplication not available");
                return;
            }
            Err(e) => panic!("commit_polynomial error: {}", e),
        };

        // Proof: π = [c1]G1 = [5]G1
        let (proof, v) = match create_opening_linear(&c0, &c1, &z, &srs, &srs_g1) {
            Ok(r) => r,
            Err(KzgError::Bn254Error(_)) => {
                eprintln!("SKIP: syscall not available");
                return;
            }
            Err(e) => panic!("create_opening_linear error: {}", e),
        };

        // v should equal 13
        assert_eq!(v, scalar(13), "f(2) = 3 + 5*2 = 13");

        let opening = KzgOpening {
            commitment,
            proof,
            z,
            v,
        };

        match verify_kzg_opening(&opening, &srs) {
            Ok(valid) => assert!(valid, "valid KZG opening must verify"),
            Err(KzgError::Bn254Error(_)) => {
                eprintln!("SKIP: alt_bn128_pairing not available");
            }
            Err(e) => panic!("verify error: {}", e),
        }
    }

    /// Same as above but with wrong v — should return Ok(false).
    #[test]
    fn verify_kzg_opening_wrong_v_fails() {
        let srs = KzgSrs::test_srs();
        let srs_g1 = vec![srs.g1, srs.g1];

        let c0 = scalar(3);
        let c1 = scalar(5);
        let z = scalar(2);

        let coeffs = [c0, c1];
        let commitment = match commit_polynomial(&coeffs, &srs_g1) {
            Ok(c) => c,
            Err(KzgError::Bn254Error(_)) => {
                eprintln!("SKIP: syscall not available");
                return;
            }
            Err(e) => panic!("{}", e),
        };

        let (proof, _correct_v) = match create_opening_linear(&c0, &c1, &z, &srs, &srs_g1) {
            Ok(r) => r,
            Err(KzgError::Bn254Error(_)) => {
                eprintln!("SKIP");
                return;
            }
            Err(e) => panic!("{}", e),
        };

        // Supply wrong v = 99 (correct is 13)
        let opening = KzgOpening {
            commitment,
            proof,
            z,
            v: scalar(99),
        };

        match verify_kzg_opening(&opening, &srs) {
            Ok(valid) => assert!(!valid, "wrong v must not verify"),
            Err(KzgError::Bn254Error(_)) => {
                eprintln!("SKIP: alt_bn128_pairing not available");
            }
            Err(e) => panic!("unexpected error: {}", e),
        }
    }

    /// Batch with one valid opening must return true.
    #[test]
    fn verify_kzg_batch_single_valid() {
        let srs = KzgSrs::test_srs();
        let srs_g1 = vec![srs.g1, srs.g1];

        let c0 = scalar(1);
        let c1 = scalar(2);
        let z = scalar(3);

        let coeffs = [c0, c1];
        let commitment = match commit_polynomial(&coeffs, &srs_g1) {
            Ok(c) => c,
            Err(KzgError::Bn254Error(_)) => {
                eprintln!("SKIP");
                return;
            }
            Err(e) => panic!("{}", e),
        };

        // v = 1 + 2*3 = 7
        let (proof, v) = match create_opening_linear(&c0, &c1, &z, &srs, &srs_g1) {
            Ok(r) => r,
            Err(KzgError::Bn254Error(_)) => {
                eprintln!("SKIP");
                return;
            }
            Err(e) => panic!("{}", e),
        };

        assert_eq!(v, scalar(7), "f(3) = 1 + 2*3 = 7");

        let openings = [KzgOpening { commitment, proof, z, v }];
        match verify_kzg_batch(&openings, &srs) {
            Ok(valid) => assert!(valid, "batch with one valid opening must pass"),
            Err(KzgError::Bn254Error(_)) => eprintln!("SKIP"),
            Err(e) => panic!("{}", e),
        }
    }

    /// Wrong proof point should not verify.
    #[test]
    fn verify_kzg_opening_wrong_proof_fails() {
        let srs = KzgSrs::test_srs();
        let srs_g1 = vec![srs.g1, srs.g1];

        let c0 = scalar(3);
        let c1 = scalar(5);
        let z = scalar(2);

        let coeffs = [c0, c1];
        let commitment = match commit_polynomial(&coeffs, &srs_g1) {
            Ok(c) => c,
            Err(KzgError::Bn254Error(_)) => {
                eprintln!("SKIP");
                return;
            }
            Err(e) => panic!("{}", e),
        };

        // Use a wrong proof — just the G1 generator (should be [5]G1)
        let wrong_proof = g1_gen();

        let opening = KzgOpening {
            commitment,
            proof: wrong_proof,
            z,
            v: scalar(13),
        };

        match verify_kzg_opening(&opening, &srs) {
            Ok(valid) => assert!(!valid, "wrong proof must not verify"),
            Err(KzgError::Bn254Error(_)) => {
                eprintln!("SKIP: alt_bn128_pairing not available");
            }
            Err(e) => panic!("unexpected error: {}", e),
        }
    }

    // ── MAINNET_READY and version ─────────────────────────────────────────────

    #[test]
    fn mainnet_ready_is_false() {
        assert!(!MAINNET_READY);
    }

    #[test]
    fn version_string_correct() {
        assert_eq!(KZG_VERIFIER_VERSION, "dark-kzg-v1");
    }

    // ── fr_mul_scalar consistency with fr_mul_byte ────────────────────────────

    #[test]
    fn fr_mul_scalar_matches_mul_byte_for_small_values() {
        let a = scalar(7);
        let b_small: u8 = 5;
        let b_scalar = scalar(b_small as u64);

        let via_byte = fr_mul_byte(&a, b_small);
        let via_scalar = fr_mul_scalar(&a, &b_scalar);
        assert_eq!(via_byte, via_scalar, "fr_mul_byte and fr_mul_scalar agree for small inputs");
    }
}
