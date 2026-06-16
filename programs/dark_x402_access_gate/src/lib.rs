use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

use dark_groth16_core::{
    g1_from_bytes, g2_from_bytes, groth16_verify,
    x402_access_vk::{x402_access_vk, NR_PUBLIC_INPUTS},
    Groth16Proof,
};

entrypoint!(process_instruction);

/// Instruction data layout — x402_access circuit, 3 public inputs:
///   proof[256]        — BN254 Groth16 proof (A:64 B:128 C:64)
///   commitment[32]    — Poseidon(secret, agent_id) — agent binding
///   threshold[32]     — minimum balance required for tier access
///   nullifier[32]     — Poseidon(secret, nonce) — single-use anti-replay
///
/// Total: 256 + 3×32 = 352 bytes
///
/// Proves WITHOUT revealing: wallet, actual balance, or agent identity.
/// Verifier: alt_bn128_pairing syscall (~150k CU).
pub const INSTRUCTION_DATA_LEN: usize = 352;

const OFF_PROOF:      usize = 0;
const OFF_COMMITMENT: usize = 256;
const OFF_THRESHOLD:  usize = 288;
const OFF_NULLIFIER:  usize = 320;

fn parse32(data: &[u8], off: usize) -> [u8; 32] {
    data[off..off + 32].try_into().unwrap_or([0u8; 32])
}

fn hex32(bytes: &[u8; 32]) -> [u8; 64] {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = [0u8; 64];
    for (i, &b) in bytes.iter().enumerate() {
        out[i * 2]     = HEX[(b >> 4) as usize];
        out[i * 2 + 1] = HEX[(b & 0x0f) as usize];
    }
    out
}

fn process_instruction(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    // 1. Length check
    if data.len() != INSTRUCTION_DATA_LEN {
        msg!("dark_x402_access_gate: expected {} bytes, got {}", INSTRUCTION_DATA_LEN, data.len());
        return Err(ProgramError::InvalidInstructionData);
    }

    // 2. Parse proof components
    let proof_bytes: &[u8; 256] = data[OFF_PROOF..OFF_PROOF + 256].try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    let commitment = parse32(data, OFF_COMMITMENT);
    let threshold  = parse32(data, OFF_THRESHOLD);
    let nullifier  = parse32(data, OFF_NULLIFIER);

    // 3. Build public inputs array (circuit order: commitment, threshold, nullifier)
    let public_inputs: [[u8; 32]; NR_PUBLIC_INPUTS] = [commitment, threshold, nullifier];

    // 4. Load x402_access VK
    let vk = x402_access_vk();
    // Fail closed on a non-trustless VK (audit HIGH: mainnet_ready was comment-only).
    // Devnet ships a single-party (mainnet_ready=false) VK, so `--features devnet` skips
    // this; a mainnet build omits the feature → non-ceremony VK rejected. Safe default: ON.
    #[cfg(not(feature = "devnet"))]
    if !vk.mainnet_ready {
        return Err(ProgramError::Custom(2));
    }

    // 5. Parse proof
    let proof_a_bytes: [u8; 64]  = proof_bytes[0..64].try_into().unwrap_or([0u8; 64]);
    let proof_b_bytes: [u8; 128] = proof_bytes[64..192].try_into().unwrap_or([0u8; 128]);
    let proof_c_bytes: [u8; 64]  = proof_bytes[192..256].try_into().unwrap_or([0u8; 64]);

    let proof = Groth16Proof {
        a: g1_from_bytes(&proof_a_bytes),
        b: g2_from_bytes(&proof_b_bytes),
        c: g1_from_bytes(&proof_c_bytes),
    };

    // 6. Verify Groth16 proof on-chain via alt_bn128_pairing syscall
    let verified = groth16_verify(&vk, &proof, &public_inputs)
        .map_err(|_| ProgramError::Custom(1))?;

    if !verified {
        return Err(ProgramError::Custom(1));
    }

    // 7. Single-use nullifier — replay protection (audit HIGH). The gate previously
    //    verified the proof and recorded nothing, so a valid (proof, nullifier) could be
    //    replayed forever. Bind acceptance to a one-time PDA [b"x402_nullifier", nullifier]:
    //    present => replay (reject); absent => create it (mark spent).
    //    Accounts: [0]=nullifier_record (w, PDA), [1]=payer (signer, w), [2]=system_program.
    let iter = &mut accounts.iter();
    let nullifier_record = next_account_info(iter)?;
    let payer            = next_account_info(iter)?;
    let system_program   = next_account_info(iter)?;

    let (expected_pda, bump) =
        Pubkey::find_program_address(&[b"x402_nullifier", &nullifier], program_id);
    if expected_pda != *nullifier_record.key {
        return Err(ProgramError::InvalidArgument);
    }
    // Already spent IFF we created+initialized it: owned by this program with non-empty data.
    // Do NOT infer "spent" from lamports() — anyone can front-run a 1-lamport System transfer
    // to the PDA, which would phantom-trigger replay (Custom 3) and brick the nullifier.
    // Mirror dark_shielded_pool's data check (processor.rs: data_len()>0).
    if nullifier_record.owner == program_id && !nullifier_record.data_is_empty() {
        return Err(ProgramError::Custom(3));
    }
    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *system_program.key != solana_program::system_program::id() {
        return Err(ProgramError::IncorrectProgramId);
    }
    // Create the single-use PDA. A griefer can pre-fund the address (System transfer) so a
    // plain create_account fails ("account already in use"); tolerate that by topping up to
    // rent-exempt then allocate + assign under the PDA seeds, so the spend cannot be bricked.
    let rent = Rent::get()?;
    let space: usize = 1; // 1-byte marker (stores the bump)
    let needed = rent.minimum_balance(space);
    let seeds: &[&[u8]] = &[b"x402_nullifier", &nullifier, &[bump]];
    if nullifier_record.lamports() == 0 {
        invoke_signed(
            &system_instruction::create_account(payer.key, nullifier_record.key, needed, space as u64, program_id),
            &[payer.clone(), nullifier_record.clone(), system_program.clone()],
            &[seeds],
        )?;
    } else {
        let have = nullifier_record.lamports();
        if have < needed {
            invoke(
                &system_instruction::transfer(payer.key, nullifier_record.key, needed - have),
                &[payer.clone(), nullifier_record.clone(), system_program.clone()],
            )?;
        }
        invoke_signed(&system_instruction::allocate(nullifier_record.key, space as u64),
            &[nullifier_record.clone(), system_program.clone()], &[seeds])?;
        invoke_signed(&system_instruction::assign(nullifier_record.key, program_id),
            &[nullifier_record.clone(), system_program.clone()], &[seeds])?;
    }
    nullifier_record.try_borrow_mut_data()?[0] = bump;

    // 8. Log success
    let null_hex = hex32(&nullifier);
    let null_str = core::str::from_utf8(&null_hex).unwrap_or("?");
    let comm_hex = hex32(&commitment);
    let comm_str = core::str::from_utf8(&comm_hex).unwrap_or("?");
    msg!(
        "dark_x402_access_gate: x402 access proof verified commitment={} nullifier={}",
        comm_str,
        null_str
    );

    Ok(())
}
