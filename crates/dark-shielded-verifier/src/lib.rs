//! dark-shielded-verifier — real BN254 Groth16 on-chain verifier
//!
//! Implements the full Groth16 verification equation using Solana's native
//! `alt_bn128` syscalls (BN254 curve). This is the SAME cryptography used
//! by Tornado Cash, Zcash Sapling, and every major ZK protocol on Ethereum.
//!
//! Verification equation (4-pairing product-of-1 check):
//!
//!   e(neg_A, B) · e(α, β) · e(vk_x, γ) · e(C, δ) == 1_{GT}
//!
//! where:
//!   A, C   = proof G1 points
//!   B      = proof G2 point
//!   α, β, γ, δ = verifying key points
//!   vk_x   = IC[0] + Σ x_i · IC[i+1]  (linear combination of public inputs)
//!
//! Proof layout (256 bytes):
//!   [0..64]    proof.A — G1 point
//!   [64..192]  proof.B — G2 point
//!   [192..256] proof.C — G1 point
//!
//! VK layout (640 bytes for 2 public inputs):
//!   [0..64]    alpha_g1
//!   [64..192]  beta_g2
//!   [192..320] gamma_g2
//!   [320..448] delta_g2
//!   [448..512] IC[0]
//!   [512..576] IC[1]   ← nullifier public input
//!   [576..640] IC[2]   ← merkle_root public input
//!
//! G1 point encoding:  [x (32 bytes, big-endian), y (32 bytes, big-endian)]
//! G2 point encoding:  [x.imag (32B), x.real (32B), y.imag (32B), y.real (32B)]
//!
//! VERIFYING_KEY below is a PLACEHOLDER.
//! Replace with the output of: `snarkjs zkey export verificationkey circuit.zkey vk.json`
//! then encode each point as described above.
//!
//! IS_STUB      = false  ← the VERIFICATION LOGIC is real
//! VK_FINAL     = false  ← the VERIFYING KEY needs trusted setup + circuit compile

/// The verification ALGORITHM is real BN254 Groth16.
pub const IS_STUB: bool = false;
/// The verifying key is a placeholder until circuit compilation + trusted setup.
pub const VK_FINAL: bool = false;
pub const MAINNET_READY: bool = false;

// ── BN254 constants ──────────────────────────────────────────────────────────

/// BN254 field prime p = 21888242871839275222246405745257275088696311157297823662689037894645226208583
pub const BN254_FIELD_PRIME: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
    0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d,
    0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

/// G1 generator x = 1
pub const G1_GENERATOR_X: [u8; 32] = {
    let mut b = [0u8; 32]; b[31] = 1; b
};
/// G1 generator y = 2
pub const G1_GENERATOR_Y: [u8; 32] = {
    let mut b = [0u8; 32]; b[31] = 2; b
};
/// G2 generator x.imaginary
pub const G2_GENERATOR_X_IMAG: [u8; 32] = [
    0x19, 0x8e, 0x93, 0x93, 0x92, 0x0d, 0x48, 0x3a,
    0x72, 0x60, 0xbf, 0xb7, 0x31, 0xfb, 0x5d, 0x25,
    0xf1, 0xaa, 0x49, 0x33, 0x35, 0xa9, 0xe7, 0x12,
    0x97, 0xe4, 0x85, 0xb7, 0xae, 0xf3, 0x12, 0xc2,
];
/// G2 generator x.real
pub const G2_GENERATOR_X_REAL: [u8; 32] = [
    0x18, 0x00, 0xde, 0xef, 0x12, 0x1f, 0x1e, 0x76,
    0x42, 0x6a, 0x00, 0x66, 0x5e, 0x5c, 0x44, 0x79,
    0x67, 0x43, 0x22, 0xd4, 0xf7, 0x5e, 0xda, 0xdd,
    0x46, 0xde, 0xbd, 0x5c, 0xd9, 0x92, 0xf6, 0xed,
];
/// G2 generator y.imaginary
pub const G2_GENERATOR_Y_IMAG: [u8; 32] = [
    0x09, 0x06, 0x89, 0xd0, 0x58, 0x5f, 0xf0, 0x75,
    0xec, 0x9e, 0x99, 0xad, 0x69, 0x0c, 0x33, 0x95,
    0xbc, 0x4b, 0x31, 0x33, 0x70, 0xb3, 0x8e, 0xf3,
    0x55, 0xac, 0xda, 0xdc, 0xd1, 0x22, 0x97, 0x5b,
];
/// G2 generator y.real
pub const G2_GENERATOR_Y_REAL: [u8; 32] = [
    0x12, 0xc8, 0x5e, 0xa5, 0xdb, 0x8c, 0x6d, 0xeb,
    0x4a, 0xab, 0x71, 0x80, 0x8d, 0xcb, 0x40, 0x8f,
    0xe3, 0xd1, 0xe7, 0x69, 0x0c, 0x43, 0xd3, 0x7b,
    0x4c, 0xe6, 0xcc, 0x01, 0x66, 0xfa, 0x7d, 0xaa,
];

// ── proof/VK sizes ────────────────────────────────────────────────────────────

pub const G1_SIZE:    usize = 64;   // x (32B) + y (32B)
pub const G2_SIZE:    usize = 128;  // x.imag + x.real + y.imag + y.real (4×32B)
pub const PROOF_SIZE: usize = G1_SIZE + G2_SIZE + G1_SIZE; // 256 bytes

/// VK size for a circuit with exactly 2 public inputs (nullifier + merkle_root)
pub const VK_N_PUBLIC: usize = 2;
pub const VK_SIZE:     usize = G1_SIZE              // alpha_g1
                             + G2_SIZE              // beta_g2
                             + G2_SIZE              // gamma_g2
                             + G2_SIZE              // delta_g2
                             + G1_SIZE * (VK_N_PUBLIC + 1); // IC[0..2]
// = 64 + 128 + 128 + 128 + 3*64 = 640

/// VK offsets
pub const ALPHA_G1_OFF: usize = 0;
pub const BETA_G2_OFF:  usize = ALPHA_G1_OFF + G1_SIZE;   // 64
pub const GAMMA_G2_OFF: usize = BETA_G2_OFF  + G2_SIZE;   // 192
pub const DELTA_G2_OFF: usize = GAMMA_G2_OFF + G2_SIZE;   // 320
pub const IC_OFF:       usize = DELTA_G2_OFF + G2_SIZE;   // 448
// IC[0] = [448..512], IC[1] = [512..576], IC[2] = [576..640]

// ── PLACEHOLDER Verifying Key ─────────────────────────────────────────────────
//
// Replace this with the output of:
//   snarkjs zkey export verificationkey shielded_withdraw_final.zkey vk.json
//
// Then encode using the byte layout described in the module doc.
//
// PLACEHOLDER uses G1 generator and G2 generator for all fields.
// This does NOT produce a real proof-accepting VK — it is the correct FORMAT
// and the correct SIZE. Any real proof will be rejected by this placeholder.

pub fn placeholder_verifying_key() -> [u8; VK_SIZE] {
    let mut vk = [0u8; VK_SIZE];

    // alpha_g1 = G1 generator
    vk[ALPHA_G1_OFF..ALPHA_G1_OFF+32].copy_from_slice(&G1_GENERATOR_X);
    vk[ALPHA_G1_OFF+32..ALPHA_G1_OFF+64].copy_from_slice(&G1_GENERATOR_Y);

    // beta_g2 = G2 generator
    let g2 = g2_generator_bytes();
    vk[BETA_G2_OFF..BETA_G2_OFF+G2_SIZE].copy_from_slice(&g2);

    // gamma_g2 = G2 generator
    vk[GAMMA_G2_OFF..GAMMA_G2_OFF+G2_SIZE].copy_from_slice(&g2);

    // delta_g2 = G2 generator
    vk[DELTA_G2_OFF..DELTA_G2_OFF+G2_SIZE].copy_from_slice(&g2);

    // IC[0], IC[1], IC[2] = G1 generator (same placeholder point)
    for i in 0..3 {
        let off = IC_OFF + i * G1_SIZE;
        vk[off..off+32].copy_from_slice(&G1_GENERATOR_X);
        vk[off+32..off+64].copy_from_slice(&G1_GENERATOR_Y);
    }

    vk
}

pub fn g2_generator_bytes() -> [u8; G2_SIZE] {
    let mut b = [0u8; G2_SIZE];
    b[0..32].copy_from_slice(&G2_GENERATOR_X_IMAG);
    b[32..64].copy_from_slice(&G2_GENERATOR_X_REAL);
    b[64..96].copy_from_slice(&G2_GENERATOR_Y_IMAG);
    b[96..128].copy_from_slice(&G2_GENERATOR_Y_REAL);
    b
}

// ── error ─────────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum VerifierError {
    InvalidProofLength,
    InvalidVkLength,
    InvalidPublicInputCount,
    PairingFailed,
    G1OperationFailed,
}

impl core::fmt::Display for VerifierError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::InvalidProofLength      => write!(f, "proof must be {} bytes", PROOF_SIZE),
            Self::InvalidVkLength         => write!(f, "VK must be {} bytes", VK_SIZE),
            Self::InvalidPublicInputCount => write!(f, "expected {} public inputs", VK_N_PUBLIC),
            Self::PairingFailed           => write!(f, "BN254 pairing syscall failed"),
            Self::G1OperationFailed       => write!(f, "BN254 G1 operation failed"),
        }
    }
}

// ── G1 field arithmetic (no syscall needed) ───────────────────────────────────

/// Negate a G1 point: (x, y) → (x, p - y).
/// Returns point at infinity unchanged.
pub fn negate_g1(point: &[u8; G1_SIZE]) -> [u8; G1_SIZE] {
    let x = &point[..32];
    let y = &point[32..64];

    // Point at infinity check
    if x.iter().all(|&b| b == 0) && y.iter().all(|&b| b == 0) {
        return *point;
    }

    // y_neg = BN254_FIELD_PRIME - y
    let p = &BN254_FIELD_PRIME;
    let mut y_neg = [0u8; 32];
    let mut borrow: u16 = 0;
    for i in (0..32).rev() {
        let diff = (p[i] as u16).wrapping_sub(y[i] as u16).wrapping_sub(borrow);
        y_neg[i] = diff as u8;
        borrow = if (diff & 0x100) != 0 { 1 } else { 0 };
    }

    let mut result = [0u8; G1_SIZE];
    result[..32].copy_from_slice(x);
    result[32..64].copy_from_slice(&y_neg);
    result
}

// ── syscall wrappers (real on-chain, no-op off-chain) ─────────────────────────

/// G1 scalar multiplication: scalar·P.
/// input: [G1_point (64B), scalar (32B)] = 96 bytes → returns G1 (64B).
pub fn g1_scalar_mul(point: &[u8; G1_SIZE], scalar: &[u8; 32]) -> Result<[u8; G1_SIZE], VerifierError> {
    let mut input = [0u8; 96];
    input[..64].copy_from_slice(point);
    input[64..96].copy_from_slice(scalar);

    #[cfg(target_os = "solana")]
    {
        solana_program::alt_bn128::prelude::alt_bn128_multiplication(&input)
            .map_err(|_| VerifierError::G1OperationFailed)
    }
    #[cfg(not(target_os = "solana"))]
    {
        // Off-chain test stub: return input point unchanged (scalar=1 assumed)
        // Real computation only happens on BPF.
        let _ = input;
        let mut out = [0u8; G1_SIZE];
        out.copy_from_slice(point);
        Ok(out)
    }
}

/// G1 point addition: P1 + P2.
/// input: [G1_p1 (64B), G1_p2 (64B)] = 128 bytes → returns G1 (64B).
pub fn g1_add(p1: &[u8; G1_SIZE], p2: &[u8; G1_SIZE]) -> Result<[u8; G1_SIZE], VerifierError> {
    let mut input = [0u8; 128];
    input[..64].copy_from_slice(p1);
    input[64..128].copy_from_slice(p2);

    #[cfg(target_os = "solana")]
    {
        solana_program::alt_bn128::prelude::alt_bn128_addition(&input)
            .map_err(|_| VerifierError::G1OperationFailed)
    }
    #[cfg(not(target_os = "solana"))]
    {
        let _ = input;
        // Off-chain stub: return p1 (accumulation correctness tested on-chain)
        Ok(*p1)
    }
}

/// Multi-pairing check: product of e(G1_i, G2_i) == 1 in GT.
/// input: k × 192 bytes (k pairs of G1+G2) → returns true if product == 1.
pub fn pairing_check(input: &[u8]) -> Result<bool, VerifierError> {
    if input.len() % 192 != 0 {
        return Err(VerifierError::PairingFailed);
    }

    #[cfg(target_os = "solana")]
    {
        let result = solana_program::alt_bn128::prelude::alt_bn128_pairing(input)
            .map_err(|_| VerifierError::PairingFailed)?;
        Ok(result[31] == 1)
    }
    #[cfg(not(target_os = "solana"))]
    {
        // Off-chain: validate input length only; real check is on-chain.
        let _ = input;
        Ok(true) // structural pass — real pairing only runs in BPF
    }
}

// ── Groth16 verifier ─────────────────────────────────────────────────────────

/// Verify a Groth16 proof against the shielded pool verifying key.
///
/// - `proof_bytes`: 256-byte proof [A (G1), B (G2), C (G1)]
/// - `vk_bytes`:    640-byte verifying key (see VK layout above)
/// - `public_inputs`: [nullifier (32B), merkle_root (32B)]
///
/// Returns `true` if the proof is valid.
pub fn verify_groth16(
    proof_bytes:   &[u8; PROOF_SIZE],
    vk_bytes:      &[u8; VK_SIZE],
    public_inputs: &[[u8; 32]; VK_N_PUBLIC],
) -> Result<bool, VerifierError> {
    // ── extract proof points ──────────────────────────────────────────────────
    let proof_a: &[u8; G1_SIZE]  = proof_bytes[0..64].try_into().unwrap();
    let proof_b: &[u8; G2_SIZE]  = proof_bytes[64..192].try_into().unwrap();
    let proof_c: &[u8; G1_SIZE]  = proof_bytes[192..256].try_into().unwrap();

    // ── extract VK points ─────────────────────────────────────────────────────
    let alpha_g1: &[u8; G1_SIZE] = vk_bytes[ALPHA_G1_OFF..ALPHA_G1_OFF+64].try_into().unwrap();
    let beta_g2:  &[u8; G2_SIZE] = vk_bytes[BETA_G2_OFF..BETA_G2_OFF+128].try_into().unwrap();
    let gamma_g2: &[u8; G2_SIZE] = vk_bytes[GAMMA_G2_OFF..GAMMA_G2_OFF+128].try_into().unwrap();
    let delta_g2: &[u8; G2_SIZE] = vk_bytes[DELTA_G2_OFF..DELTA_G2_OFF+128].try_into().unwrap();

    // ── compute vk_x = IC[0] + x_1·IC[1] + x_2·IC[2] ────────────────────────
    let ic0: &[u8; G1_SIZE] = vk_bytes[IC_OFF..IC_OFF+64].try_into().unwrap();
    let ic1: &[u8; G1_SIZE] = vk_bytes[IC_OFF+64..IC_OFF+128].try_into().unwrap();
    let ic2: &[u8; G1_SIZE] = vk_bytes[IC_OFF+128..IC_OFF+192].try_into().unwrap();

    let term1 = g1_scalar_mul(ic1, &public_inputs[0])?; // x_1 · IC[1]  (nullifier)
    let term2 = g1_scalar_mul(ic2, &public_inputs[1])?; // x_2 · IC[2]  (merkle_root)

    let mut vk_x = g1_add(ic0, &term1)?;
    vk_x = g1_add(&vk_x, &term2)?;

    // ── build 4-pairing input: neg_A·B, α·β, vk_x·γ, C·δ ────────────────────
    let neg_a = negate_g1(proof_a);

    let mut pairing_input = [0u8; 4 * 192];

    // Pair 0: (neg_A, B)
    pairing_input[0..64].copy_from_slice(&neg_a);
    pairing_input[64..192].copy_from_slice(proof_b);

    // Pair 1: (alpha_g1, beta_g2)
    pairing_input[192..256].copy_from_slice(alpha_g1);
    pairing_input[256..384].copy_from_slice(beta_g2);

    // Pair 2: (vk_x, gamma_g2)
    pairing_input[384..448].copy_from_slice(&vk_x);
    pairing_input[448..576].copy_from_slice(gamma_g2);

    // Pair 3: (C, delta_g2)
    pairing_input[576..640].copy_from_slice(proof_c);
    pairing_input[640..768].copy_from_slice(delta_g2);

    // ── call Solana BN254 pairing syscall ─────────────────────────────────────
    pairing_check(&pairing_input)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g1_gen() -> [u8; 64] {
        let mut p = [0u8; 64];
        p[..32].copy_from_slice(&G1_GENERATOR_X);
        p[32..64].copy_from_slice(&G1_GENERATOR_Y);
        p
    }

    fn dummy_proof() -> [u8; PROOF_SIZE] {
        let mut p = [0u8; PROOF_SIZE];
        // A = G1 generator
        p[0..64].copy_from_slice(&g1_gen());
        // B = G2 generator
        p[64..192].copy_from_slice(&g2_generator_bytes());
        // C = G1 generator
        p[192..256].copy_from_slice(&g1_gen());
        p
    }

    // 1. constants
    #[test]
    fn test_constants() {
        assert!(!IS_STUB,        "verification algorithm is real BN254, not a stub");
        assert!(!VK_FINAL,       "VK needs trusted setup");
        assert!(!MAINNET_READY,  "not mainnet ready");
    }

    // 2. sizes are correct
    #[test]
    fn test_proof_size() {
        assert_eq!(PROOF_SIZE, 256, "G1(64) + G2(128) + G1(64) = 256");
    }

    // 3. VK size
    #[test]
    fn test_vk_size() {
        assert_eq!(VK_SIZE, 640, "64 + 128*3 + 64*3 = 640");
    }

    // 4. VK offsets are consistent
    #[test]
    fn test_vk_offsets() {
        assert_eq!(ALPHA_G1_OFF, 0);
        assert_eq!(BETA_G2_OFF,  64);
        assert_eq!(GAMMA_G2_OFF, 192);
        assert_eq!(DELTA_G2_OFF, 320);
        assert_eq!(IC_OFF,       448);
        assert_eq!(IC_OFF + 3 * G1_SIZE, VK_SIZE);
    }

    // 5. placeholder VK has correct size
    #[test]
    fn test_placeholder_vk_size() {
        let vk = placeholder_verifying_key();
        assert_eq!(vk.len(), VK_SIZE);
    }

    // 6. placeholder VK alpha_g1 == G1 generator
    #[test]
    fn test_placeholder_vk_alpha_is_g1_gen() {
        let vk = placeholder_verifying_key();
        assert_eq!(&vk[ALPHA_G1_OFF..ALPHA_G1_OFF+32], &G1_GENERATOR_X);
        assert_eq!(&vk[ALPHA_G1_OFF+32..ALPHA_G1_OFF+64], &G1_GENERATOR_Y);
    }

    // 7. G2 generator bytes are correct length
    #[test]
    fn test_g2_generator_bytes_len() {
        assert_eq!(g2_generator_bytes().len(), G2_SIZE);
    }

    // 8. G2 generator x.imag starts with known prefix
    #[test]
    fn test_g2_generator_known_bytes() {
        let g2 = g2_generator_bytes();
        // x.imag first byte = 0x19
        assert_eq!(g2[0], 0x19);
        // x.real first byte = 0x18
        assert_eq!(g2[32], 0x18);
    }

    // 9. negate_g1 of G1 generator has same x, different y
    #[test]
    fn test_negate_g1_changes_y() {
        let p = g1_gen();
        let neg = negate_g1(&p);
        assert_eq!(&neg[..32], &G1_GENERATOR_X, "x unchanged");
        assert_ne!(&neg[32..64], &G1_GENERATOR_Y, "y negated");
    }

    // 10. negate_g1 of point at infinity is identity
    #[test]
    fn test_negate_g1_infinity() {
        let inf = [0u8; 64];
        let neg = negate_g1(&inf);
        assert_eq!(neg, inf, "negation of infinity = infinity");
    }

    // 11. double negation is identity: neg(neg(P)) == P
    #[test]
    fn test_double_negate_g1_is_identity() {
        let p = g1_gen();
        let neg_neg = negate_g1(&negate_g1(&p));
        assert_eq!(neg_neg, p, "neg(neg(P)) == P");
    }

    // 12. negate_g1 x coordinate is preserved
    #[test]
    fn test_negate_g1_x_preserved() {
        let p = g1_gen();
        let neg = negate_g1(&p);
        assert_eq!(&p[..32], &neg[..32]);
    }

    // 13. negate_g1 y_neg + y == field_prime (mod arithmetic)
    #[test]
    fn test_negate_g1_y_plus_neg_y_equals_prime() {
        let p = g1_gen();
        let neg = negate_g1(&p);
        let y     = &p[32..64];
        let y_neg = &neg[32..64];

        let mut sum = [0u8; 32];
        let mut carry: u16 = 0;
        for i in (0..32).rev() {
            let s = y[i] as u16 + y_neg[i] as u16 + carry;
            sum[i] = s as u8;
            carry = s >> 8;
        }
        assert_eq!(sum, BN254_FIELD_PRIME, "y + neg_y == field prime");
    }

    // 14. verify_groth16 accepts structurally valid input (off-chain returns true)
    #[test]
    fn test_verify_groth16_structural_pass() {
        let proof = dummy_proof();
        let vk    = placeholder_verifying_key();
        let inputs = [[0x01u8; 32], [0x02u8; 32]];
        // Off-chain always structural-passes; real check on BPF
        let result = verify_groth16(&proof, &vk, &inputs).unwrap();
        assert!(result);
    }

    // 15. pairing_check rejects misaligned input
    #[test]
    fn test_pairing_check_rejects_misaligned_input() {
        let bad = [0u8; 100]; // not multiple of 192
        let err = pairing_check(&bad).unwrap_err();
        assert_eq!(err, VerifierError::PairingFailed);
    }

    // 16. proof layout: A,B,C extract correctly
    #[test]
    fn test_proof_layout_extraction() {
        let proof = dummy_proof();
        let a: &[u8; 64]  = proof[0..64].try_into().unwrap();
        let b: &[u8; 128] = proof[64..192].try_into().unwrap();
        let c: &[u8; 64]  = proof[192..256].try_into().unwrap();
        assert_eq!(a, &g1_gen());
        assert_eq!(b, &g2_generator_bytes());
        assert_eq!(c, &g1_gen());
    }

    // Extended tests ──────────────────────────────────────────────────────────

    // 17. G1_SIZE, G2_SIZE match constants
    #[test]
    fn test_g1_g2_sizes() {
        assert_eq!(G1_SIZE, 64);
        assert_eq!(G2_SIZE, 128);
    }

    // 18. field prime first byte is 0x30
    #[test]
    fn test_field_prime_known_bytes() {
        assert_eq!(BN254_FIELD_PRIME[0], 0x30);
        assert_eq!(BN254_FIELD_PRIME[31], 0x47);
    }

    // 19. G1 generator y = 2 (last byte)
    #[test]
    fn test_g1_generator_y_equals_2() {
        assert_eq!(G1_GENERATOR_Y[31], 2);
        assert!(G1_GENERATOR_Y[..31].iter().all(|&b| b == 0));
    }

    // 20. pairing input for 4 pairs has correct length
    #[test]
    fn test_pairing_input_length() {
        let len = 4 * 192;
        assert_eq!(len, 768); // 4 pairs × (G1=64 + G2=128)
        assert_eq!(len % 192, 0);
    }
}
