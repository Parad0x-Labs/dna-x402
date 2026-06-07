use solana_program::{account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, msg, pubkey::Pubkey};

use dark_groth16_core::{
    g1_from_bytes, g2_from_bytes, groth16_verify,
    track_record_vk::{track_record_vk, NR_PUBLIC_INPUTS},
    Groth16Proof,
};

entrypoint!(process_instruction);

/// Instruction data layout — track_record circuit, 6 public inputs:
///   proof[256]                — BN254 Groth16 proof (A:64 B:128 C:64)
///   root[32]                  — anchored receipt Merkle root (must match on-chain receipt_anchor)
///   min_count[32]             — required receipt count (the requested tier bar)
///   min_volume[32]            — required total settled volume
///   window_start[32]          — earliest acceptable receipt timestamp (e.g. now - 90d)
///   reputation_nullifier[32]  — Poseidon(DOMAIN_REP, secret, epoch); single-use via dark_nullifier_record
///   agent_commitment[32]      — Poseidon(secret, agent_id); same identity as dark_x402_access_gate
///
/// Total: 256 + 6×32 = 448 bytes
///
/// Proves the agent owns >= min_count distinct receipts in the anchored tree, each within the
/// window, totalling >= min_volume — WITHOUT revealing any receipt's amount, time, counterparty,
/// or id. Verifier: alt_bn128_pairing syscall.
pub const INSTRUCTION_DATA_LEN: usize = 448;

const OFF_PROOF:        usize = 0;
const OFF_ROOT:         usize = 256;
const OFF_MIN_COUNT:    usize = 288;
const OFF_MIN_VOLUME:   usize = 320;
const OFF_WINDOW_START: usize = 352;
const OFF_REP_NULL:     usize = 384;
const OFF_AGENT_COMMIT: usize = 416;

fn parse32(data: &[u8], off: usize) -> [u8; 32] {
    data[off..off + 32].try_into().unwrap_or([0u8; 32])
}

fn process_instruction(_program_id: &Pubkey, _accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // 1. Length check
    if data.len() != INSTRUCTION_DATA_LEN {
        msg!("dark_reputation_gate: expected {} bytes, got {}", INSTRUCTION_DATA_LEN, data.len());
        return Err(solana_program::program_error::ProgramError::InvalidInstructionData);
    }

    // 2. Parse proof + public inputs
    let proof_bytes: &[u8; 256] = data[OFF_PROOF..OFF_PROOF + 256].try_into()
        .map_err(|_| solana_program::program_error::ProgramError::InvalidInstructionData)?;

    let root         = parse32(data, OFF_ROOT);
    let min_count    = parse32(data, OFF_MIN_COUNT);
    let min_volume   = parse32(data, OFF_MIN_VOLUME);
    let window_start = parse32(data, OFF_WINDOW_START);
    let rep_null     = parse32(data, OFF_REP_NULL);
    let agent_commit = parse32(data, OFF_AGENT_COMMIT);

    // 3. Public inputs — circuit order: root, min_count, min_volume, window_start, nullifier, commitment
    let public_inputs: [[u8; 32]; NR_PUBLIC_INPUTS] =
        [root, min_count, min_volume, window_start, rep_null, agent_commit];

    // 4. VK
    let vk = track_record_vk();

    // 5. Parse proof points
    let a_bytes: [u8; 64]  = proof_bytes[0..64].try_into().unwrap_or([0u8; 64]);
    let b_bytes: [u8; 128] = proof_bytes[64..192].try_into().unwrap_or([0u8; 128]);
    let c_bytes: [u8; 64]  = proof_bytes[192..256].try_into().unwrap_or([0u8; 64]);
    let proof = Groth16Proof {
        a: g1_from_bytes(&a_bytes),
        b: g2_from_bytes(&b_bytes),
        c: g1_from_bytes(&c_bytes),
    };

    // 6. Verify on-chain via alt_bn128_pairing
    let verified = groth16_verify(&vk, &proof, &public_inputs)
        .map_err(|_| solana_program::program_error::ProgramError::Custom(1))?;
    if !verified {
        return Err(solana_program::program_error::ProgramError::Custom(1));
    }

    // 7. Caller is responsible for recording `reputation_nullifier` in dark_nullifier_record
    //    (single-use) and asserting `root` == the live on-chain receipt_anchor root.
    msg!("dark_reputation_gate: track-record proof verified (>= min_count receipts, >= min_volume)");
    Ok(())
}
