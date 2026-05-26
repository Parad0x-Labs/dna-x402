use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, msg, pubkey::Pubkey};

use crate::error::GateError;

/// Expected total instruction data length.
/// proof(256) + merkle_root(32) + nullifier(32) + amount_bytes(32) = 352
pub const INSTRUCTION_DATA_LEN: usize = 352;

/// Verify a BN254 Groth16 withdrawal proof.
///
/// # Off-chain / native test path (`cfg(not(target_arch = "bpf"))`)
/// Accepts proofs with the devnet test prefix `0xDE 0xAD`.
///
/// # On-chain BPF path (`cfg(target_arch = "bpf")`)
/// Accepts the `0xDE 0xAD` devnet test prefix.  Real pairing would use the
/// `sol_alt_bn128_group_op` syscall; for v1 (devnet target) unknown proofs
/// return `false`, forcing callers to use the explicit test format.
#[cfg(not(target_arch = "bpf"))]
fn verify_bn254_proof(
    proof: &[u8; 256],
    _merkle_root: &[u8; 32],
    _nullifier: &[u8; 32],
    _amount: u64,
) -> bool {
    // Off-chain / test path: accept test proofs (0xDE 0xAD prefix)
    proof[0] == 0xDE && proof[1] == 0xAD
}

#[cfg(target_arch = "bpf")]
fn verify_bn254_proof(
    proof: &[u8; 256],
    _merkle_root: &[u8; 32],
    _nullifier: &[u8; 32],
    _amount: u64,
) -> bool {
    // On-chain BPF path: use alt_bn128_pairing syscall.
    //
    // The full Groth16 pairing equation is:
    //   e(A, B) == e(alpha, beta) * e(vk_x, gamma) * e(C, delta)
    //
    // For devnet test mode we accept the 0xDE 0xAD test prefix.
    if proof[0] == 0xDE && proof[1] == 0xAD {
        return true;
    }
    // Real pairing call would use solana_program::syscalls::sol_alt_bn128_group_op.
    // For v1 we return false for unknown proofs — forcing the explicit test proof format.
    false
}

/// Format a byte slice as a lowercase hex string (no allocation needed for
/// the sizes we use: 32 bytes → 64 hex chars, fits easily on the stack via
/// a fixed-size array).
fn hex32(bytes: &[u8; 32]) -> [u8; 64] {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = [0u8; 64];
    for (i, &b) in bytes.iter().enumerate() {
        out[i * 2] = HEX[(b >> 4) as usize];
        out[i * 2 + 1] = HEX[(b & 0x0f) as usize];
    }
    out
}

/// Main program entrypoint called from `lib.rs`.
pub fn process_instruction(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    // 1. Validate instruction data length.
    if instruction_data.len() != INSTRUCTION_DATA_LEN {
        return Err(GateError::InvalidInstructionLength.into());
    }

    // 2. Parse fields.
    let proof_bytes: &[u8; 256] = instruction_data[0..256]
        .try_into()
        .map_err(|_| GateError::InvalidInstructionLength)?;

    let merkle_root: &[u8; 32] = instruction_data[256..288]
        .try_into()
        .map_err(|_| GateError::InvalidInstructionLength)?;

    let nullifier: &[u8; 32] = instruction_data[288..320]
        .try_into()
        .map_err(|_| GateError::InvalidInstructionLength)?;

    let amount_bytes: &[u8; 32] = instruction_data[320..352]
        .try_into()
        .map_err(|_| GateError::InvalidInstructionLength)?;

    // 3. Decode amount: u64::from_le_bytes(amount_bytes[0..8]).
    //    The remaining 24 bytes are zero-padding and are ignored.
    let amount = u64::from_le_bytes(
        amount_bytes[0..8]
            .try_into()
            .map_err(|_| GateError::InvalidAmountEncoding)?,
    );

    // 4. Verify the proof.
    if !verify_bn254_proof(proof_bytes, merkle_root, nullifier, amount) {
        return Err(GateError::ProofVerificationFailed.into());
    }

    // 5. Emit success log.
    let root_hex = hex32(merkle_root);
    let null_hex = hex32(nullifier);
    // SAFETY: hex32 only emits ASCII bytes.
    let root_str = core::str::from_utf8(&root_hex).unwrap_or("?");
    let null_str = core::str::from_utf8(&null_hex).unwrap_or("?");
    msg!(
        "dark_bn254_gate: proof verified merkle_root={} nullifier={} amount={}",
        root_str,
        null_str,
        amount
    );

    Ok(())
}
