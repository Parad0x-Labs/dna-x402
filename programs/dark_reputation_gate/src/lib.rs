use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
};

use dark_groth16_core::{
    g1_from_bytes, g2_from_bytes, groth16_verify,
    track_record_vk::{track_record_vk, NR_PUBLIC_INPUTS},
    Groth16Proof,
};

entrypoint!(process_instruction);

/// dark_nullifier_record (same id on devnet + mainnet) — single-use enforcement.
const NULLIFIER_RECORD_PROGRAM: Pubkey =
    solana_program::pubkey!("24tmjEd1DhPW2QuPV6BzkFFHrq2PtELoLqv5cuv2Xu65");
/// PDA seed prefix used by dark_nullifier_record.
const NULL_RECORD_SEED: &[u8] = b"null_record";
/// RecordNullifier discriminator in dark_nullifier_record.
const IX_RECORD_NULLIFIER: u8 = 0x00;

/// Instruction data layout — track_record circuit, 6 public inputs (448 bytes):
///   proof[256]                — BN254 Groth16 proof (A:64 B:128 C:64)
///   root[32]                  — anchored receipt Merkle root
///   min_count[32]             — required receipt count (tier bar)
///   min_volume[32]            — required total settled volume
///   window_start[32]          — earliest acceptable receipt timestamp
///   reputation_nullifier[32]  — Poseidon(DOMAIN_REP, secret, epoch); recorded single-use
///   agent_commitment[32]      — Poseidon(secret, agent_id); same identity as dark_x402_access_gate
///
/// Accounts:
///   0. payer                     [signer, writable] — funds the nullifier PDA rent
///   1. dark_nullifier_record     []                 — must equal NULLIFIER_RECORD_PROGRAM
///   2. nullifier_record_pda      [writable]         — PDA(["null_record", reputation_nullifier])
///   3. system_program            []
///
/// Verifies the track-record proof, then records `reputation_nullifier` in
/// dark_nullifier_record (CPI). A replayed proof fails because the nullifier PDA already
/// exists (Custom(10) AlreadyRecorded) — so each proof is single-use.
pub const INSTRUCTION_DATA_LEN: usize = 448;

const OFF_PROOF: usize = 0;
const OFF_ROOT: usize = 256;
const OFF_MIN_COUNT: usize = 288;
const OFF_MIN_VOLUME: usize = 320;
const OFF_WINDOW_START: usize = 352;
const OFF_REP_NULL: usize = 384;
const OFF_AGENT_COMMIT: usize = 416;

fn parse32(data: &[u8], off: usize) -> [u8; 32] {
    data[off..off + 32].try_into().unwrap_or([0u8; 32])
}

fn process_instruction(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != INSTRUCTION_DATA_LEN {
        msg!("dark_reputation_gate: expected {} bytes, got {}", INSTRUCTION_DATA_LEN, data.len());
        return Err(ProgramError::InvalidInstructionData);
    }

    // ── proof + public inputs ──────────────────────────────────────────────────
    let proof_bytes: &[u8; 256] = data[OFF_PROOF..OFF_PROOF + 256].try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    let root         = parse32(data, OFF_ROOT);
    let min_count    = parse32(data, OFF_MIN_COUNT);
    let min_volume   = parse32(data, OFF_MIN_VOLUME);
    let window_start = parse32(data, OFF_WINDOW_START);
    let rep_null     = parse32(data, OFF_REP_NULL);
    let agent_commit = parse32(data, OFF_AGENT_COMMIT);

    // circuit public-input order
    let public_inputs: [[u8; 32]; NR_PUBLIC_INPUTS] =
        [root, min_count, min_volume, window_start, rep_null, agent_commit];

    // ── verify the Groth16 track-record proof ──────────────────────────────────
    let vk = track_record_vk();
    let a_bytes: [u8; 64]  = proof_bytes[0..64].try_into().unwrap_or([0u8; 64]);
    let b_bytes: [u8; 128] = proof_bytes[64..192].try_into().unwrap_or([0u8; 128]);
    let c_bytes: [u8; 64]  = proof_bytes[192..256].try_into().unwrap_or([0u8; 64]);
    let proof = Groth16Proof {
        a: g1_from_bytes(&a_bytes),
        b: g2_from_bytes(&b_bytes),
        c: g1_from_bytes(&c_bytes),
    };
    let verified = groth16_verify(&vk, &proof, &public_inputs)
        .map_err(|_| ProgramError::Custom(1))?;
    if !verified {
        return Err(ProgramError::Custom(1));
    }

    // ── record reputation_nullifier (single-use) via dark_nullifier_record CPI ──
    let iter = &mut accounts.iter();
    let payer          = next_account_info(iter)?;
    let null_program   = next_account_info(iter)?;
    let record_pda     = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    if null_program.key != &NULLIFIER_RECORD_PROGRAM {
        return Err(ProgramError::IncorrectProgramId);
    }
    // PDA must be the genuine record account for THIS nullifier — no spoofing.
    let (expected_pda, _bump) =
        Pubkey::find_program_address(&[NULL_RECORD_SEED, &rep_null], null_program.key);
    if record_pda.key != &expected_pda {
        return Err(ProgramError::InvalidArgument);
    }

    let mut ix_data = [0u8; 33];
    ix_data[0] = IX_RECORD_NULLIFIER;
    ix_data[1..33].copy_from_slice(&rep_null);
    let ix = Instruction {
        program_id: NULLIFIER_RECORD_PROGRAM,
        accounts: vec![
            AccountMeta::new(*payer.key, true),
            AccountMeta::new(*record_pda.key, false),
            AccountMeta::new_readonly(*system_program.key, false),
        ],
        data: ix_data.to_vec(),
    };
    // Fails with Custom(10) AlreadyRecorded if this proof was already used → single-use.
    invoke(&ix, &[payer.clone(), record_pda.clone(), system_program.clone()])?;

    msg!("dark_reputation_gate: track-record proof verified + nullifier recorded (single-use)");
    Ok(())
}
