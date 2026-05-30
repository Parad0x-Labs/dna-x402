use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, msg, pubkey::Pubkey};

use dark_groth16_core::{
    g1_from_bytes, g1_generator, g2_from_bytes, g2_generator, negate_g1, pairing_check, G1Affine,
    VerificationKey,
};

use crate::error::GateError;

/// Expected instruction data length.
/// proof(256) + merkle_root(32) + nullifier(32) + amount_bytes(32) = 352 bytes.
pub const INSTRUCTION_DATA_LEN: usize = 352;

// ── Devnet verification key ────────────────────────────────────────────────────
//
// This is a PLACEHOLDER VK for devnet testing.
// In production it would be replaced by a VK from a trusted setup ceremony.
//
// For the devnet VK we use a trivial configuration:
//   alpha = G1_gen,  beta = G2_gen,  gamma = G2_gen,  delta = G2_gen
//   gamma_abc = [G1_infinity]  (0 public inputs)
//
// The ONLY proofs that pass this VK are:
//   1. 0xDE 0xAD prefix (explicit devnet test mode — bypasses pairing)
//   2. A real Groth16 proof generated for this exact VK
//
// mainnet_ready = false — no production circuit is compiled against this VK.

fn devnet_vk() -> VerificationKey {
    VerificationKey {
        alpha_g1: g1_generator(),
        beta_g2: g2_generator(),
        gamma_g2: g2_generator(),
        delta_g2: g2_generator(),
        // 0 public inputs → gamma_abc has length 1 (constant term only)
        gamma_abc: alloc::vec![G1Affine {
            x: [0u8; 32],
            y: [0u8; 32]
        }],
        mainnet_ready: false,
    }
}

extern crate alloc;

/// Verify a BN254 Groth16 withdrawal proof.
///
/// # Verification modes
///
/// 1. **Devnet test mode** (`proof[0..2] == [0xDE, 0xAD]`):
///    Accepted unconditionally — **only when compiled with the `devnet-test`
///    feature**. A standard `cargo build-sbf` (the mainnet artifact) does NOT
///    contain this branch, so the sentinel can never bypass verification on a
///    deployed binary.
///
/// 2. **Real proof path** (all other proofs):
///    - Parses `proof[0..256]` as `Groth16Proof { A: G1(64B), B: G2(128B), C: G1(64B) }`.
///    - Negates A, vk_x, C.
///    - Runs `alt_bn128_pairing` with 4 pairs (768 bytes).
///    - Returns `true` iff the pairing product equals 1.
///
/// # Fail-closed invariant
///
/// `devnet_vk()` is a placeholder from no trusted setup and is cryptographically
/// forgeable (alpha = beta = delta = generators, gamma_abc = [infinity] → an
/// attacker can pick `A = G1 + C`, `B = G2` to satisfy the pairing). Until a real
/// ceremony VK is wired and `mainnet_ready` is `true`, this function rejects every
/// proof. This makes "held back until audit" an enforced code property, not a
/// policy note.
fn verify_bn254_proof(
    proof: &[u8; 256],
    _merkle_root: &[u8; 32],
    _nullifier: &[u8; 32],
    _amount: u64,
) -> bool {
    // ── Devnet test mode (feature-gated; absent from mainnet artifacts) ───────
    #[cfg(feature = "devnet-test")]
    {
        if proof[0] == 0xDE && proof[1] == 0xAD {
            return true;
        }
    }

    let vk = devnet_vk();

    // ── Fail closed: no production trusted-setup VK is wired yet ──────────────
    if !vk.mainnet_ready {
        return false;
    }

    // ── Real Groth16 pairing path (unreachable until a mainnet_ready VK) ──────
    // Parse proof: [A: 64, B: 128, C: 64]
    let a_bytes: [u8; 64] = proof[0..64].try_into().unwrap_or([0u8; 64]);
    let b_bytes: [u8; 128] = proof[64..192].try_into().unwrap_or([0u8; 128]);
    let c_bytes: [u8; 64] = proof[192..256].try_into().unwrap_or([0u8; 64]);

    let a = g1_from_bytes(&a_bytes);
    let b = g2_from_bytes(&b_bytes);
    let c = g1_from_bytes(&c_bytes);

    // vk_x = gamma_abc[0] (0 public inputs — constant term only)
    let vk_x = vk.gamma_abc[0];

    // e(A,B) · e(−α, β) · e(−vk_x, γ) · e(−C, δ) = 1
    let neg_alpha = negate_g1(&vk.alpha_g1);
    let neg_vk_x = negate_g1(&vk_x);
    let neg_c = negate_g1(&c);

    match pairing_check(&[
        (a, b),
        (neg_alpha, vk.beta_g2),
        (neg_vk_x, vk.gamma_g2),
        (neg_c, vk.delta_g2),
    ]) {
        Ok(result) => result,
        Err(_) => false,
    }
}

/// Format a [u8;32] as hex for msg! logging (no allocation needed).
fn hex32(bytes: &[u8; 32]) -> [u8; 64] {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = [0u8; 64];
    for (i, &b) in bytes.iter().enumerate() {
        out[i * 2] = HEX[(b >> 4) as usize];
        out[i * 2 + 1] = HEX[(b & 0x0f) as usize];
    }
    out
}

/// Main program entrypoint.
pub fn process_instruction(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // 1. Validate length
    if data.len() != INSTRUCTION_DATA_LEN {
        return Err(GateError::InvalidInstructionLength.into());
    }

    // 2. Parse fields
    let proof_bytes: &[u8; 256] = data[0..256]
        .try_into()
        .map_err(|_| GateError::InvalidInstructionLength)?;
    let merkle_root: &[u8; 32] = data[256..288]
        .try_into()
        .map_err(|_| GateError::InvalidInstructionLength)?;
    let nullifier: &[u8; 32] = data[288..320]
        .try_into()
        .map_err(|_| GateError::InvalidInstructionLength)?;
    let amount_bytes: &[u8; 32] = data[320..352]
        .try_into()
        .map_err(|_| GateError::InvalidInstructionLength)?;

    let amount = u64::from_le_bytes(
        amount_bytes[0..8]
            .try_into()
            .map_err(|_| GateError::InvalidAmountEncoding)?,
    );

    // 3. Verify proof (real BN254 Groth16 pairing; sentinel only under devnet-test)
    #[cfg(feature = "devnet-test")]
    let mode = if proof_bytes[0] == 0xDE && proof_bytes[1] == 0xAD {
        "devnet-test"
    } else {
        "groth16-bn254"
    };
    #[cfg(not(feature = "devnet-test"))]
    let mode = "groth16-bn254";

    if !verify_bn254_proof(proof_bytes, merkle_root, nullifier, amount) {
        return Err(GateError::ProofVerificationFailed.into());
    }

    // 4. Emit success log
    let root_hex = hex32(merkle_root);
    let null_hex = hex32(nullifier);
    let root_str = core::str::from_utf8(&root_hex).unwrap_or("?");
    let null_str = core::str::from_utf8(&null_hex).unwrap_or("?");
    msg!(
        "dark_bn254_gate: {} proof verified root={} nullifier={} amount={}",
        mode,
        root_str,
        null_str,
        amount
    );

    Ok(())
}
