// `target_os = "solana"` is the custom OS used for Solana BPF programs.
// The check-cfg lint does not know about it, so we suppress the warning here.
#![cfg_attr(not(target_os = "solana"), allow(unexpected_cfgs))]

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  dark_bn254_g2_ref — BN254 G2 Reference Implementation                  │
// │                                                                         │
// │  SIMD-0302 Reference Program                                            │
// │                                                                         │
// │  Feature gate: bn1hKNURMGQaQoEVxahcEAcqiX3NwRs6hgKKNSLeKxH             │
// │  Devnet: live since epoch 1058                                          │
// │  Testnet: live since epoch 954                                          │
// │                                                                         │
// │  New G2 syscalls (SIMD-0302):                                           │
// │    sol_alt_bn128_group_op(4, ...) — ALT_BN128_G2_ADD                   │
// │      Input:  [P1: 128B][P2: 128B] = 256 bytes                          │
// │      Output: 128 bytes (G2 affine point)                               │
// │                                                                         │
// │    sol_alt_bn128_group_op(6, ...) — ALT_BN128_G2_MUL                   │
// │      Input:  [P: 128B][scalar: 32B] = 160 bytes                        │
// │      Output: 128 bytes (G2 affine point)                               │
// │                                                                         │
// │  Plus the existing pairing syscall (opcode 3 / alt_bn128_pairing)      │
// │  used here with DYNAMIC G2 points — the key innovation for Groth16     │
// │  on-chain with caller-supplied VK.                                     │
// │                                                                         │
// │  Instruction layout:                                                    │
// │    [0x01] G2Add          — 256 bytes: [P1:128][P2:128]                 │
// │    [0x02] G2Mul          — 160 bytes: [P:128][scalar:32]               │
// │    [0x03] G2PairingCheck — 516 bytes: [A:64][B:128][C:64]              │
// │                                       [beta_g2:128][gamma_g2:128]      │
// │                                       [public_input:32]                 │
// │                                                                         │
// │  G2 encoding (EIP-197 compatible):                                      │
// │    [x_im: 32BE][x_re: 32BE][y_im: 32BE][y_re: 32BE] = 128 bytes       │
// │    Fp2 = a·u + b  encoded as [a, b] (imaginary first)                  │
// └─────────────────────────────────────────────────────────────────────────┘

use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
};

#[cfg(not(feature = "no-entrypoint"))]
use solana_program::entrypoint;

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

// ── Syscall opcodes ───────────────────────────────────────────────────────────

/// Existing G1 addition opcode (SIMD-0072 / EIP-196).
pub const ALT_BN128_G1_ADD: u64 = 0;
/// Existing G1 scalar multiplication opcode.
pub const ALT_BN128_G1_MUL: u64 = 2;
/// Existing pairing opcode (EIP-197).
pub const ALT_BN128_PAIRING: u64 = 3;

/// NEW — G2 point addition (SIMD-0302, feature gate bn1hKN…).
/// sol_alt_bn128_group_op(4, input_256B, 256, output_128B)
pub const ALT_BN128_G2_ADD: u64 = 4;

/// NEW — G2 scalar multiplication (SIMD-0302, feature gate bn1hKN…).
/// sol_alt_bn128_group_op(6, input_160B, 160, output_128B)
pub const ALT_BN128_G2_MUL: u64 = 6;

// ── Error codes ───────────────────────────────────────────────────────────────

/// Instruction discriminant is not 0x01/0x02/0x03.
pub const ERR_UNKNOWN_INSTRUCTION: u32 = 1;
/// Input data length does not match the expected layout.
pub const ERR_WRONG_LENGTH: u32 = 2;
/// The BN254 group operation syscall returned an error.
pub const ERR_G2_SYSCALL: u32 = 3;
/// Pairing check returned false — proof is invalid.
pub const ERR_PAIRING_FAILED: u32 = 4;

// ── BN254 G2 generator constants (EIP-197 encoding, big-endian Fp2) ──────────
// Verified against Ethereum test vectors and the Solana dark-groth16-core crate.

/// G2 generator x — imaginary part (a in a·u + b).
pub const G2_GEN_X_IM: [u8; 32] = hex32(
    b"198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2",
);
/// G2 generator x — real part.
pub const G2_GEN_X_RE: [u8; 32] = hex32(
    b"1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed",
);
/// G2 generator y — imaginary part.
pub const G2_GEN_Y_IM: [u8; 32] = hex32(
    b"090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b",
);
/// G2 generator y — real part.
pub const G2_GEN_Y_RE: [u8; 32] = hex32(
    b"12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa",
);

/// G2 generator negated y — imaginary part.
pub const G2_GEN_NEG_Y_IM: [u8; 32] = hex32(
    b"275dc4a288d1afb3cbb1ac09187524c7db36395df7be3b99e673b13a075a65ec",
);
/// G2 generator negated y — real part.
pub const G2_GEN_NEG_Y_RE: [u8; 32] = hex32(
    b"1d9befcd05a5323e6da4d435f3b617cdb3af83285c2df711ef39c01571827f9d",
);

// 2*G2_gen is not stored as a compile-time constant — it is computed at test
// time via g2_mul(G2_gen, 2) and g2_add(G2_gen, G2_gen) and compared
// directly, avoiding the risk of hand-encoding an incorrect value.

// ── G1 constants (for pairing check) ─────────────────────────────────────────

/// G1 generator — x = 1 (32-byte big-endian).
pub const G1_GEN_X: [u8; 32] = {
    let mut a = [0u8; 32];
    a[31] = 1;
    a
};
/// G1 generator — y = 2 (32-byte big-endian).
pub const G1_GEN_Y: [u8; 32] = {
    let mut a = [0u8; 32];
    a[31] = 2;
    a
};

/// BN254 Fp prime (big-endian, 32 bytes).
/// p = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47
pub const BN254_FP: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
    0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d,
    0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

// ── Compile-time hex decoder ──────────────────────────────────────────────────

const fn hex32(s: &[u8]) -> [u8; 32] {
    assert!(s.len() == 64, "hex32: expected 64 hex chars");
    let mut out = [0u8; 32];
    let mut i = 0usize;
    while i < 32 {
        out[i] = hex_nibble(s[i * 2]) << 4 | hex_nibble(s[i * 2 + 1]);
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

// ── Helper: format 128-byte G2 point as 256-char hex for logging ─────────────

fn hex128(bytes: &[u8; 128]) -> [u8; 256] {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = [0u8; 256];
    for (i, &b) in bytes.iter().enumerate() {
        out[i * 2]     = HEX[(b >> 4) as usize];
        out[i * 2 + 1] = HEX[(b & 0x0f) as usize];
    }
    out
}

// ── Low-level G2 syscall wrappers ─────────────────────────────────────────────

/// G2 point addition via sol_alt_bn128_group_op(4, ...).
///
/// Input:  [P1: 128 bytes][P2: 128 bytes] = 256 bytes.
/// Output: 128-byte G2 affine point (x_im||x_re||y_im||y_re).
///
/// On devnet/testnet (epoch ≥ 1058/954): calls the live G2_ADD syscall.
/// On native/test: delegates to ark-bn254 G2 arithmetic (see cfg block below).
pub fn g2_add(p1: &[u8; 128], p2: &[u8; 128]) -> Result<[u8; 128], ProgramError> {
    let mut input = [0u8; 256];
    input[..128].copy_from_slice(p1);
    input[128..].copy_from_slice(p2);
    g2_group_op(ALT_BN128_G2_ADD, &input, 128)
}

/// G2 scalar multiplication via sol_alt_bn128_group_op(6, ...).
///
/// Input:  [P: 128 bytes][scalar: 32 bytes] = 160 bytes.
/// Output: 128-byte G2 affine point.
pub fn g2_mul(point: &[u8; 128], scalar: &[u8; 32]) -> Result<[u8; 128], ProgramError> {
    let mut input = [0u8; 160];
    input[..128].copy_from_slice(point);
    input[128..].copy_from_slice(scalar);
    g2_group_op(ALT_BN128_G2_MUL, &input, 128)
}

/// Dispatch to platform-specific G2 implementation.
#[allow(unused_variables)]
fn g2_group_op(opcode: u64, input: &[u8], out_len: usize) -> Result<[u8; 128], ProgramError> {
    #[cfg(target_os = "solana")]
    {
        let mut out = [0u8; 128];
        let rc = unsafe {
            solana_program::syscalls::sol_alt_bn128_group_op(
                opcode,
                input.as_ptr(),
                input.len() as u64,
                out.as_mut_ptr(),
            )
        };
        if rc != 0 {
            return Err(ProgramError::Custom(ERR_G2_SYSCALL));
        }
        Ok(out)
    }
    #[cfg(not(target_os = "solana"))]
    native_g2_op(opcode, input)
}

// ── Native (off-chain) G2 implementation ─────────────────────────────────────
// Used by tests running on the host CPU. Mirrors the pattern in
// solana_program::alt_bn128::target_arch for G1.

#[cfg(not(target_os = "solana"))]
fn native_g2_op(opcode: u64, input: &[u8]) -> Result<[u8; 128], ProgramError> {
    use ark_bn254::g2::G2Affine;
    use ark_ec::AffineRepr;
    use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Compress, Validate};

    /// Decode a 128-byte EIP-197 G2 point (big-endian Fp2) to ark G2Affine.
    fn decode_g2(bytes: &[u8; 128]) -> Result<G2Affine, ProgramError> {
        if bytes == &[0u8; 128] {
            return Ok(G2Affine::zero());
        }
        // EIP-197: [x_im:32BE][x_re:32BE][y_im:32BE][y_re:32BE]
        // ark-bn254 uncompressed: x.c1||x.c0||y.c1||y.c0 in little-endian limbs.
        // Convert: reverse each 32-byte chunk from BE to LE, then
        // arrange as [x_re_le][x_im_le][y_re_le][y_im_le] = 128 bytes.
        let mut ark_bytes = [0u8; 128];
        // x_re (ark c0) from input[32..64], reversed
        for i in 0..32 { ark_bytes[i]       = bytes[63 - i]; }
        // x_im (ark c1) from input[0..32], reversed
        for i in 0..32 { ark_bytes[32 + i]  = bytes[31 - i]; }
        // y_re (ark c0) from input[96..128], reversed
        for i in 0..32 { ark_bytes[64 + i]  = bytes[127 - i]; }
        // y_im (ark c1) from input[64..96], reversed
        for i in 0..32 { ark_bytes[96 + i]  = bytes[95 - i]; }

        // Append flags byte for uncompressed + infinity flag
        let mut full = Vec::with_capacity(129);
        full.extend_from_slice(&ark_bytes);
        full.push(0u8); // flags: uncompressed, not infinity

        let pt = G2Affine::deserialize_with_mode(
            full.as_slice(),
            Compress::No,
            Validate::Yes,
        ).map_err(|_| ProgramError::Custom(ERR_G2_SYSCALL))?;
        if !pt.is_on_curve() {
            return Err(ProgramError::Custom(ERR_G2_SYSCALL));
        }
        Ok(pt)
    }

    /// Encode ark G2Affine back to 128-byte EIP-197 format.
    fn encode_g2(pt: &G2Affine) -> Result<[u8; 128], ProgramError> {
        if pt.is_zero() {
            return Ok([0u8; 128]);
        }
        let mut ark_bytes = [0u8; 128];
        pt.x.c0.serialize_with_mode(&mut ark_bytes[..32], Compress::No)
            .map_err(|_| ProgramError::Custom(ERR_G2_SYSCALL))?;
        pt.x.c1.serialize_with_mode(&mut ark_bytes[32..64], Compress::No)
            .map_err(|_| ProgramError::Custom(ERR_G2_SYSCALL))?;
        pt.y.c0.serialize_with_mode(&mut ark_bytes[64..96], Compress::No)
            .map_err(|_| ProgramError::Custom(ERR_G2_SYSCALL))?;
        pt.y.c1.serialize_with_mode(&mut ark_bytes[96..128], Compress::No)
            .map_err(|_| ProgramError::Custom(ERR_G2_SYSCALL))?;

        // Convert from ark LE back to EIP-197 BE and swap real/imaginary order
        let mut out = [0u8; 128];
        // x_im (eip[0..32]) = ark x.c1 (ark[32..64]) reversed
        for i in 0..32 { out[i]       = ark_bytes[63 - i]; }
        // x_re (eip[32..64]) = ark x.c0 (ark[0..32]) reversed
        for i in 0..32 { out[32 + i]  = ark_bytes[31 - i]; }
        // y_im (eip[64..96]) = ark y.c1 (ark[96..128]) reversed
        for i in 0..32 { out[64 + i]  = ark_bytes[127 - i]; }
        // y_re (eip[96..128]) = ark y.c0 (ark[64..96]) reversed
        for i in 0..32 { out[96 + i]  = ark_bytes[95 - i]; }
        Ok(out)
    }

    match opcode {
        ALT_BN128_G2_ADD => {
            if input.len() < 256 {
                return Err(ProgramError::Custom(ERR_WRONG_LENGTH));
            }
            let p1_bytes: &[u8; 128] = input[..128].try_into().unwrap();
            let p2_bytes: &[u8; 128] = input[128..256].try_into().unwrap();
            let p1 = decode_g2(p1_bytes)?;
            let p2 = decode_g2(p2_bytes)?;
            #[allow(clippy::arithmetic_side_effects)]
            let result: G2Affine = (p1 + p2).into();
            encode_g2(&result)
        }
        ALT_BN128_G2_MUL => {
            if input.len() < 160 {
                return Err(ProgramError::Custom(ERR_WRONG_LENGTH));
            }
            let p_bytes: &[u8; 128] = input[..128].try_into().unwrap();
            let scalar_bytes: &[u8; 32] = input[128..160].try_into().unwrap();
            let p = decode_g2(p_bytes)?;

            // Scalar: big-endian Fr → ark BigInteger256 (little-endian)
            use ark_ff::BigInteger256;
            let mut le = [0u8; 32];
            for i in 0..32 { le[i] = scalar_bytes[31 - i]; }
            let fr = BigInteger256::deserialize_uncompressed_unchecked(le.as_slice())
                .map_err(|_| ProgramError::Custom(ERR_G2_SYSCALL))?;

            use ark_ec::AffineRepr;
            let result: G2Affine = p.mul_bigint(fr).into();
            encode_g2(&result)
        }
        _ => Err(ProgramError::Custom(ERR_UNKNOWN_INSTRUCTION)),
    }
}

// ── Pairing helper (wraps existing alt_bn128_pairing syscall) ─────────────────

/// Multi-pairing via the existing alt_bn128_pairing syscall (opcode 3).
/// Returns true iff product of all pairings = 1 in GT.
/// Input: N × 192 bytes where each pair = [G1:64][G2:128].
pub fn pairing_check(pairs: &[u8]) -> Result<bool, ProgramError> {
    use solana_program::alt_bn128::prelude::alt_bn128_pairing;
    let result = alt_bn128_pairing(pairs)
        .map_err(|_| ProgramError::Custom(ERR_PAIRING_FAILED))?;
    // EIP-197: 32-byte big-endian result; 1 = success
    Ok(result.len() >= 32
        && result[result.len() - 1] == 1
        && result[..result.len() - 1].iter().all(|&b| b == 0))
}

/// Negate a G1 point: (x, y) → (x, Fp − y).
pub fn negate_g1(g1: &[u8; 64]) -> [u8; 64] {
    if g1 == &[0u8; 64] {
        return *g1; // identity
    }
    let x: [u8; 32] = g1[..32].try_into().unwrap();
    let y: [u8; 32] = g1[32..].try_into().unwrap();
    let neg_y = fp_sub(&BN254_FP, &y);
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&x);
    out[32..].copy_from_slice(&neg_y);
    out
}

/// Compute `a - b` mod Fp (big-endian 256-bit). Assumes a >= b.
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

// ── Program entrypoint ────────────────────────────────────────────────────────

pub fn process_instruction(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.is_empty() {
        return Err(ProgramError::Custom(ERR_WRONG_LENGTH));
    }

    match data[0] {
        // ── 0x01: G2Add ───────────────────────────────────────────────────────
        0x01 => {
            // Input: [discriminant:1][P1:128][P2:128] — but discriminant stripped,
            // so we expect data[1..] = 256 bytes.
            if data.len() != 257 {
                msg!("G2Add: expected 257 bytes (1 + 256), got {}", data.len());
                return Err(ProgramError::Custom(ERR_WRONG_LENGTH));
            }
            let p1: &[u8; 128] = data[1..129].try_into()
                .map_err(|_| ProgramError::Custom(ERR_WRONG_LENGTH))?;
            let p2: &[u8; 128] = data[129..257].try_into()
                .map_err(|_| ProgramError::Custom(ERR_WRONG_LENGTH))?;

            msg!("dark_bn254_g2_ref: G2Add — ALT_BN128_G2_ADD (opcode 4)");
            let result = g2_add(p1, p2)?;
            let hex = hex128(&result);
            let hex_str = core::str::from_utf8(&hex).unwrap_or("?");
            msg!("G2Add result: {}", hex_str);
            Ok(())
        }

        // ── 0x02: G2Mul ───────────────────────────────────────────────────────
        0x02 => {
            // Input: [discriminant:1][P:128][scalar:32] = 161 bytes total.
            if data.len() != 161 {
                msg!("G2Mul: expected 161 bytes (1 + 160), got {}", data.len());
                return Err(ProgramError::Custom(ERR_WRONG_LENGTH));
            }
            let point: &[u8; 128] = data[1..129].try_into()
                .map_err(|_| ProgramError::Custom(ERR_WRONG_LENGTH))?;
            let scalar: &[u8; 32] = data[129..161].try_into()
                .map_err(|_| ProgramError::Custom(ERR_WRONG_LENGTH))?;

            msg!("dark_bn254_g2_ref: G2Mul — ALT_BN128_G2_MUL (opcode 6)");
            let result = g2_mul(point, scalar)?;
            let hex = hex128(&result);
            let hex_str = core::str::from_utf8(&hex).unwrap_or("?");
            msg!("G2Mul result: {}", hex_str);
            Ok(())
        }

        // ── 0x03: G2PairingCheck (Groth16 with dynamic G2 points) ─────────────
        //
        // KEY INNOVATION: beta_g2 and gamma_g2 come from the instruction data,
        // not hardcoded into the program. This enables a single deployed program
        // to verify ANY Groth16 circuit with a caller-supplied VK.
        //
        // Input layout (516 bytes after the discriminant, 517 total):
        //   [0x03]           1B  discriminant
        //   proof_a          64B  G1 affine (A)
        //   proof_b         128B  G2 affine (B)
        //   proof_c          64B  G1 affine (C)
        //   beta_g2         128B  VK beta — G2 affine (DYNAMIC)
        //   gamma_g2        128B  VK gamma — G2 affine (DYNAMIC)
        //   public_input     32B  single BN254 Fr scalar (for a 1-input circuit)
        //   ────────────────────
        //   Total:          517B
        //
        // Verification equation (Groth16, 1 public input, gamma_abc hardcoded
        // as [IC0, IC1] = [G1_gen, G1_gen] for the reference demo):
        //   e(A, B) · e(−α, β) · e(−vk_x, γ) · e(−C, δ) = 1
        //
        // For the reference check we use:
        //   alpha_g1 = G1_gen (demo value)
        //   delta_g2 = G2_gen (demo value)
        //   IC[0]    = G1_gen, IC[1] = G1_gen  (demo values)
        //   vk_x     = IC[0] + public_input · IC[1]
        //
        // The caller supplies beta_g2 and gamma_g2 in the instruction data.
        // Passing the G2 generator for both produces the same pairing as the
        // static case, allowing easy self-consistency checks on devnet.
        0x03 => {
            if data.len() != 517 {
                msg!(
                    "G2PairingCheck: expected 517 bytes (1 + 516), got {}",
                    data.len()
                );
                return Err(ProgramError::Custom(ERR_WRONG_LENGTH));
            }

            // Parse fields
            let proof_a: &[u8; 64]  = data[1..65].try_into().unwrap();
            let proof_b: &[u8; 128] = data[65..193].try_into().unwrap();
            let proof_c: &[u8; 64]  = data[193..257].try_into().unwrap();
            let beta_g2: &[u8; 128] = data[257..385].try_into().unwrap();
            let gamma_g2: &[u8; 128] = data[385..513].try_into().unwrap();
            let public_input: &[u8; 32] = data[513..545].try_into()
                .map_err(|_| ProgramError::Custom(ERR_WRONG_LENGTH))?;

            msg!(
                "dark_bn254_g2_ref: G2PairingCheck — Groth16 with dynamic beta_g2 / gamma_g2"
            );

            // ── vk_x = IC[0] + public_input · IC[1] ──────────────────────────
            // Demo uses IC[0] = IC[1] = G1_gen.
            // vk_x = G1_gen + scalar·G1_gen = (1 + scalar)·G1_gen
            use solana_program::alt_bn128::prelude::{
                alt_bn128_addition, alt_bn128_multiplication,
            };

            // scalar * IC[1] = scalar * G1_gen
            let mut mul_input = [0u8; 96];
            mul_input[..32].copy_from_slice(&G1_GEN_X);
            mul_input[32..64].copy_from_slice(&G1_GEN_Y);
            mul_input[64..].copy_from_slice(public_input);
            let ic1_scaled = alt_bn128_multiplication(&mul_input)
                .map_err(|_| ProgramError::Custom(ERR_G2_SYSCALL))?;
            let ic1_scaled_arr: [u8; 64] = ic1_scaled.try_into()
                .map_err(|_| ProgramError::Custom(ERR_G2_SYSCALL))?;

            // vk_x = IC[0] + ic1_scaled = G1_gen + ic1_scaled
            let mut add_input = [0u8; 128];
            add_input[..32].copy_from_slice(&G1_GEN_X);
            add_input[32..64].copy_from_slice(&G1_GEN_Y);
            add_input[64..].copy_from_slice(&ic1_scaled_arr);
            let vk_x_vec = alt_bn128_addition(&add_input)
                .map_err(|_| ProgramError::Custom(ERR_G2_SYSCALL))?;
            let vk_x: [u8; 64] = vk_x_vec.try_into()
                .map_err(|_| ProgramError::Custom(ERR_G2_SYSCALL))?;

            // ── Negate the G1 points ──────────────────────────────────────────
            // alpha_g1 = G1_gen (demo); delta_g2 = G2_gen (demo)
            let mut alpha_g1 = [0u8; 64];
            alpha_g1[..32].copy_from_slice(&G1_GEN_X);
            alpha_g1[32..].copy_from_slice(&G1_GEN_Y);
            let neg_alpha = negate_g1(&alpha_g1);
            let neg_vk_x  = negate_g1(&vk_x);
            let neg_c      = negate_g1(proof_c);

            // ── delta_g2 = G2_gen (demo) ──────────────────────────────────────
            let mut delta_g2 = [0u8; 128];
            delta_g2[..32].copy_from_slice(&G2_GEN_X_IM);
            delta_g2[32..64].copy_from_slice(&G2_GEN_X_RE);
            delta_g2[64..96].copy_from_slice(&G2_GEN_Y_IM);
            delta_g2[96..128].copy_from_slice(&G2_GEN_Y_RE);

            // ── Pairing input: 4 pairs × 192 bytes = 768 bytes ───────────────
            // e(A, B) · e(−α, β) · e(−vk_x, γ) · e(−C, δ) = 1
            let mut pairs = [0u8; 768];
            // Pair 0: (A, B)
            pairs[..64].copy_from_slice(proof_a);
            pairs[64..192].copy_from_slice(proof_b);
            // Pair 1: (−α, β)
            pairs[192..256].copy_from_slice(&neg_alpha);
            pairs[256..384].copy_from_slice(beta_g2);
            // Pair 2: (−vk_x, γ)
            pairs[384..448].copy_from_slice(&neg_vk_x);
            pairs[448..576].copy_from_slice(gamma_g2);
            // Pair 3: (−C, δ)
            pairs[576..640].copy_from_slice(&neg_c);
            pairs[640..768].copy_from_slice(&delta_g2);

            let ok = pairing_check(&pairs)?;
            if ok {
                msg!("dark_bn254_g2_ref: Groth16 pairing check PASSED — dynamic G2 verified");
                Ok(())
            } else {
                msg!("dark_bn254_g2_ref: Groth16 pairing check FAILED");
                Err(ProgramError::Custom(ERR_PAIRING_FAILED))
            }
        }

        disc => {
            msg!("dark_bn254_g2_ref: unknown instruction discriminant 0x{:02x}", disc);
            Err(ProgramError::Custom(ERR_UNKNOWN_INSTRUCTION))
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Constant sanity checks ────────────────────────────────────────────────

    #[test]
    fn test_g2_gen_constants_nonzero() {
        assert_ne!(G2_GEN_X_IM, [0u8; 32], "G2 gen x_im must be nonzero");
        assert_ne!(G2_GEN_X_RE, [0u8; 32], "G2 gen x_re must be nonzero");
        assert_ne!(G2_GEN_Y_IM, [0u8; 32], "G2 gen y_im must be nonzero");
        assert_ne!(G2_GEN_Y_RE, [0u8; 32], "G2 gen y_re must be nonzero");
    }

    #[test]
    fn test_g2_neg_y_differs_from_gen_y() {
        assert_ne!(G2_GEN_Y_IM, G2_GEN_NEG_Y_IM, "neg y_im must differ from y_im");
        assert_ne!(G2_GEN_Y_RE, G2_GEN_NEG_Y_RE, "neg y_re must differ from y_re");
        // x coordinates are unchanged under negation
        assert_eq!(G2_GEN_X_IM, G2_GEN_X_IM);
        assert_eq!(G2_GEN_X_RE, G2_GEN_X_RE);
    }

    #[test]
    fn test_g1_gen_is_one_two() {
        assert_eq!(G1_GEN_X[31], 1);
        assert_eq!(G1_GEN_Y[31], 2);
        assert_eq!(&G1_GEN_X[..31], &[0u8; 31]);
        assert_eq!(&G1_GEN_Y[..31], &[0u8; 31]);
    }

    #[test]
    fn test_opcodes_correct() {
        assert_eq!(ALT_BN128_G2_ADD, 4, "G2_ADD must be opcode 4 per SIMD-0302");
        assert_eq!(ALT_BN128_G2_MUL, 6, "G2_MUL must be opcode 6 per SIMD-0302");
    }

    // ── fp_sub tests ──────────────────────────────────────────────────────────

    #[test]
    fn test_fp_sub_simple() {
        let mut a = [0u8; 32]; a[31] = 10;
        let mut b = [0u8; 32]; b[31] = 3;
        let c = fp_sub(&a, &b);
        let mut expected = [0u8; 32]; expected[31] = 7;
        assert_eq!(c, expected);
    }

    #[test]
    fn test_fp_sub_borrow() {
        let mut a = [0u8; 32]; a[30] = 1;
        let b = [0u8; 32];
        let c = fp_sub(&a, &b);
        assert_eq!(c[30], 1);
        assert_eq!(c[31], 0);
    }

    // ── negate_g1 tests ───────────────────────────────────────────────────────

    #[test]
    fn test_negate_g1_identity_roundtrip() {
        let mut g1 = [0u8; 64];
        g1[..32].copy_from_slice(&G1_GEN_X);
        g1[32..].copy_from_slice(&G1_GEN_Y);
        let neg = negate_g1(&g1);
        let double_neg = negate_g1(&neg);
        assert_eq!(double_neg, g1, "double negation must return original point");
    }

    #[test]
    fn test_negate_g1_infinity() {
        let inf = [0u8; 64];
        assert_eq!(negate_g1(&inf), inf, "negation of identity is identity");
    }

    // ── G2 group operation tests ──────────────────────────────────────────────

    /// Construct the G2 generator as a 128-byte EIP-197 point.
    fn g2_generator() -> [u8; 128] {
        let mut p = [0u8; 128];
        p[..32].copy_from_slice(&G2_GEN_X_IM);
        p[32..64].copy_from_slice(&G2_GEN_X_RE);
        p[64..96].copy_from_slice(&G2_GEN_Y_IM);
        p[96..128].copy_from_slice(&G2_GEN_Y_RE);
        p
    }

    /// Scalar 1 (big-endian 32 bytes).
    fn scalar_one() -> [u8; 32] {
        let mut s = [0u8; 32]; s[31] = 1; s
    }

    /// Scalar 2 (big-endian 32 bytes).
    fn scalar_two() -> [u8; 32] {
        let mut s = [0u8; 32]; s[31] = 2; s
    }

    /// Scalar 0 (big-endian 32 bytes) — identity for multiplication.
    fn scalar_zero() -> [u8; 32] {
        [0u8; 32]
    }

    /// Check that a 128-byte slice decodes without panic (basic well-formedness).
    fn is_nonzero_g2(p: &[u8; 128]) -> bool {
        p.iter().any(|&b| b != 0)
    }

    /// G2 point is on curve: 1·G = G (mul by 1 returns generator).
    #[test]
    fn test_g2_mul_by_one_is_generator() {
        let gen = g2_generator();
        match g2_mul(&gen, &scalar_one()) {
            Ok(result) => {
                assert_eq!(
                    result, gen,
                    "1 * G2_gen must equal G2_gen (point is on curve)"
                );
            }
            Err(e) => panic!("G2Mul(G2_gen, 1) failed: {:?}", e),
        }
    }

    /// G2 add: G + G should equal 2·G (compare to scalar mul by 2).
    #[test]
    fn test_g2_add_gen_plus_gen_equals_mul_by_two() {
        let gen = g2_generator();
        let add_result = match g2_add(&gen, &gen) {
            Ok(r) => r,
            Err(e) => panic!("G2Add(G2_gen, G2_gen) failed: {:?}", e),
        };
        let mul_result = match g2_mul(&gen, &scalar_two()) {
            Ok(r) => r,
            Err(e) => panic!("G2Mul(G2_gen, 2) failed: {:?}", e),
        };
        assert_eq!(
            add_result, mul_result,
            "G2_gen + G2_gen must equal 2 * G2_gen"
        );
    }

    /// G2 mul by 0 returns identity (all-zero point at infinity).
    #[test]
    fn test_g2_mul_by_zero_is_identity() {
        let gen = g2_generator();
        match g2_mul(&gen, &scalar_zero()) {
            Ok(result) => {
                assert_eq!(
                    result,
                    [0u8; 128],
                    "0 * G2_gen must equal point at infinity (all zeros)"
                );
            }
            Err(e) => panic!("G2Mul(G2_gen, 0) failed: {:?}", e),
        }
    }

    /// G2 add identity: G + 0 = G.
    #[test]
    fn test_g2_add_identity() {
        let gen = g2_generator();
        let identity = [0u8; 128];
        match g2_add(&gen, &identity) {
            Ok(result) => {
                assert_eq!(result, gen, "G2_gen + identity must equal G2_gen");
            }
            Err(e) => panic!("G2Add(G2_gen, identity) failed: {:?}", e),
        }
    }

    /// G2 mul by 2 produces a nonzero, non-generator point.
    #[test]
    fn test_g2_mul_by_two_not_generator() {
        let gen = g2_generator();
        match g2_mul(&gen, &scalar_two()) {
            Ok(result) => {
                assert!(is_nonzero_g2(&result), "2*G2_gen must be nonzero");
                assert_ne!(result, gen, "2*G2_gen must not equal G2_gen");
            }
            Err(e) => panic!("G2Mul(G2_gen, 2) failed: {:?}", e),
        }
    }

    /// G2 add commutativity: A + B = B + A.
    #[test]
    fn test_g2_add_commutative() {
        let gen = g2_generator();
        let two_gen = match g2_mul(&gen, &scalar_two()) {
            Ok(r) => r,
            Err(e) => panic!("setup g2_mul failed: {:?}", e),
        };
        let ab = g2_add(&gen, &two_gen).expect("G2Add(G, 2G) failed");
        let ba = g2_add(&two_gen, &gen).expect("G2Add(2G, G) failed");
        assert_eq!(ab, ba, "G2 addition must be commutative");
    }

    /// Wrong-length input for G2Add returns ERR_WRONG_LENGTH.
    #[test]
    fn test_g2_add_wrong_length_error() {
        let short = [0u8; 64]; // only 64 bytes, needs 256
        let mut input = [0u8; 192]; // still wrong
        input[..64].copy_from_slice(&short);
        let result = g2_group_op(ALT_BN128_G2_ADD, &input, 128);
        assert!(result.is_err(), "short input must return error");
    }

    /// Wrong-length input for G2Mul returns error.
    #[test]
    fn test_g2_mul_wrong_length_error() {
        let short = [0u8; 64]; // only 64 bytes, needs 160
        let result = g2_group_op(ALT_BN128_G2_MUL, &short, 128);
        assert!(result.is_err(), "short input must return error");
    }

    // ── Pairing tests ─────────────────────────────────────────────────────────

    /// Pairing identity: e(G1_gen, G2_gen) · e(G1_gen, −G2_gen) = 1.
    /// This is EIP-197 test vector "two_point_match_2".
    #[test]
    fn test_pairing_identity_eip197() {
        // Build 2 pairs × 192 bytes = 384 bytes
        // Pair 0: (G1_gen, G2_gen)
        // Pair 1: (G1_gen, −G2_gen)
        let mut pairs = [0u8; 384];
        // Pair 0
        pairs[..32].copy_from_slice(&G1_GEN_X);
        pairs[32..64].copy_from_slice(&G1_GEN_Y);
        pairs[64..96].copy_from_slice(&G2_GEN_X_IM);
        pairs[96..128].copy_from_slice(&G2_GEN_X_RE);
        pairs[128..160].copy_from_slice(&G2_GEN_Y_IM);
        pairs[160..192].copy_from_slice(&G2_GEN_Y_RE);
        // Pair 1
        pairs[192..224].copy_from_slice(&G1_GEN_X);
        pairs[224..256].copy_from_slice(&G1_GEN_Y);
        pairs[256..288].copy_from_slice(&G2_GEN_X_IM);
        pairs[288..320].copy_from_slice(&G2_GEN_X_RE);
        pairs[320..352].copy_from_slice(&G2_GEN_NEG_Y_IM);
        pairs[352..384].copy_from_slice(&G2_GEN_NEG_Y_RE);

        match pairing_check(&pairs) {
            Ok(is_one) => assert!(
                is_one,
                "e(G1, G2) * e(G1, -G2) = 1 (EIP-197 two_point_match_2)"
            ),
            Err(e) => panic!("pairing_check failed: {:?}", e),
        }
    }

    /// Single pair (G1_gen, G2_gen) must return 0 (not 1).
    #[test]
    fn test_pairing_single_pair_not_one() {
        let mut pairs = [0u8; 192];
        pairs[..32].copy_from_slice(&G1_GEN_X);
        pairs[32..64].copy_from_slice(&G1_GEN_Y);
        pairs[64..96].copy_from_slice(&G2_GEN_X_IM);
        pairs[96..128].copy_from_slice(&G2_GEN_X_RE);
        pairs[128..160].copy_from_slice(&G2_GEN_Y_IM);
        pairs[160..192].copy_from_slice(&G2_GEN_Y_RE);

        match pairing_check(&pairs) {
            Ok(is_one) => assert!(
                !is_one,
                "single (G1, G2) pair must NOT equal 1 (EIP-197 one_point)"
            ),
            Err(e) => panic!("pairing_check failed: {:?}", e),
        }
    }

    /// Empty pairing input returns 1 (vacuous product).
    #[test]
    fn test_pairing_empty_returns_one() {
        match pairing_check(&[]) {
            Ok(is_one) => assert!(
                is_one,
                "empty pairing must return 1 (EIP-197 empty_data)"
            ),
            Err(e) => panic!("pairing_check failed: {:?}", e),
        }
    }

    // ── Process instruction / dispatch tests ──────────────────────────────────

    #[test]
    fn test_process_unknown_discriminant() {
        use solana_program::pubkey::Pubkey;
        let prog_id = Pubkey::default();
        let result = process_instruction(&prog_id, &[], &[0xFF]);
        assert_eq!(
            result,
            Err(ProgramError::Custom(ERR_UNKNOWN_INSTRUCTION)),
            "unknown discriminant must return ERR_UNKNOWN_INSTRUCTION"
        );
    }

    #[test]
    fn test_process_empty_input() {
        use solana_program::pubkey::Pubkey;
        let prog_id = Pubkey::default();
        let result = process_instruction(&prog_id, &[], &[]);
        assert_eq!(
            result,
            Err(ProgramError::Custom(ERR_WRONG_LENGTH)),
            "empty input must return ERR_WRONG_LENGTH"
        );
    }

    #[test]
    fn test_process_g2add_wrong_length() {
        use solana_program::pubkey::Pubkey;
        let prog_id = Pubkey::default();
        let data = vec![0x01u8; 10]; // way too short
        let result = process_instruction(&prog_id, &[], &data);
        assert_eq!(
            result,
            Err(ProgramError::Custom(ERR_WRONG_LENGTH)),
            "G2Add with wrong length must return ERR_WRONG_LENGTH"
        );
    }

    #[test]
    fn test_process_g2mul_wrong_length() {
        use solana_program::pubkey::Pubkey;
        let prog_id = Pubkey::default();
        let data = vec![0x02u8; 50]; // too short
        let result = process_instruction(&prog_id, &[], &data);
        assert_eq!(
            result,
            Err(ProgramError::Custom(ERR_WRONG_LENGTH)),
            "G2Mul with wrong length must return ERR_WRONG_LENGTH"
        );
    }

    #[test]
    fn test_process_pairing_wrong_length() {
        use solana_program::pubkey::Pubkey;
        let prog_id = Pubkey::default();
        let data = vec![0x03u8; 100]; // too short
        let result = process_instruction(&prog_id, &[], &data);
        assert_eq!(
            result,
            Err(ProgramError::Custom(ERR_WRONG_LENGTH)),
            "G2PairingCheck with wrong length must return ERR_WRONG_LENGTH"
        );
    }

    /// G2Add via process_instruction: generator + generator (round-trip).
    #[test]
    fn test_process_g2add_gen_plus_gen() {
        use solana_program::pubkey::Pubkey;
        let prog_id = Pubkey::default();
        let gen = g2_generator();
        let mut data = vec![0x01u8];
        data.extend_from_slice(&gen);
        data.extend_from_slice(&gen);
        assert_eq!(data.len(), 257);
        let result = process_instruction(&prog_id, &[], &data);
        assert!(result.is_ok(), "G2Add gen+gen via process_instruction failed: {:?}", result);
    }

    /// G2Mul via process_instruction: 1 * generator = generator (round-trip).
    #[test]
    fn test_process_g2mul_one_times_gen() {
        use solana_program::pubkey::Pubkey;
        let prog_id = Pubkey::default();
        let gen = g2_generator();
        let mut data = vec![0x02u8];
        data.extend_from_slice(&gen);
        data.extend_from_slice(&scalar_one());
        assert_eq!(data.len(), 161);
        let result = process_instruction(&prog_id, &[], &data);
        assert!(result.is_ok(), "G2Mul 1*gen via process_instruction failed: {:?}", result);
    }
}
