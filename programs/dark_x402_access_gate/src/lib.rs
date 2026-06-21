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
    x402_access_v2_vk::{x402_access_v2_vk, NR_PUBLIC_INPUTS},
    Groth16Proof,
};

entrypoint!(process_instruction);

// ─── canonical receipt tree binding (closes the v1 free-witness tautology) ──────────
// v1 (x402_access.circom) proved `balance >= threshold` over a FREE witness `balance`
// bound to nothing — any caller set balance := threshold and a verifying proof existed.
// v2 (x402_access_v2.circom) proves `amount >= threshold` where `amount` is opened from a
// leaf the prover proves is a member of the anchored receipt tree. That membership only
// holds against the AUTHORITATIVE on-chain tree's root — otherwise an attacker builds a
// tree of fabricated leaves off-chain and proves against it. So, exactly like
// dark_reputation_gate, we pin `root` to the canonical receipt_commitment_tree PDA.
//
// DEVNET program id of dark_receipt_commitment_tree (shared with dark_reputation_gate so
// both gates bind the SAME tree). Mainnet redeploy MUST update this.
// NOTE: ghostscore.md documents the receipt tree as 8jC8QGi… while the gates hardcode
// H9nL9tErF… — that doc/id drift is tracked for cleanup; the gate constant is canonical.
const RECEIPT_TREE_PROGRAM: Pubkey =
    solana_program::pubkey!("H9nL9tErFXFmr2ZGkgFVz2NpjAsAeDBXDgS85qBWFGAe");
const RECEIPT_TREE_SEED: &[u8] = b"receipt_tree";
/// Canonical reputation/receipt tree id (the one settlement writes receipts into). Devnet POC = 0.
const CANONICAL_TREE_ID: [u8; 8] = [0u8; 8];
// receipt_commitment_tree account layout (see that program): DEPTH=10, ROOT_HISTORY=8.
const RT_ROOT_HISTORY: usize = 8;
const RT_O_ROOTS: usize = 682; // O_ZEROS(42 + 10*32) + DEPTH*32 = 682
const RT_TREE_LEN: usize = RT_O_ROOTS + RT_ROOT_HISTORY * 32; // 938

/// Self-owned single-use nullifier PDA seed (distinct from dark_reputation_gate's).
const X402_NULLIFIER_SEED: &[u8] = b"x402_nullifier";

/// Instruction data layout — x402_access_v2 circuit, 6 public inputs (448 bytes):
///   proof[256]          — BN254 Groth16 proof (A:64 B:128 C:64)
///   root[32]            — anchored receipt Merkle root (MUST match the canonical tree)
///   threshold[32]       — minimum settled amount the resource requires
///   scope_hash[32]      — BN254-Fr reduction of the x402 resource scope (binds proof to THIS resource)
///   epoch[32]           — rate-limit window
///   nullifier[32]       — Poseidon(DOMAIN_ACCESS, secret, scope_hash, epoch); recorded single-use
///   agent_commitment[32]— Poseidon(secret, agent_id); same identity as dark_reputation_gate
///
/// Accounts:
///   0. payer                 [signer, writable] — funds the nullifier PDA rent
///   1. receipt_tree          []                 — canonical PDA(["receipt_tree", 0]) @ RECEIPT_TREE_PROGRAM
///   2. nullifier_record_pda  [writable]         — PDA(["x402_nullifier", nullifier]) @ this program
///   3. system_program        []
///
/// Proves WITHOUT revealing: wallet, the receipt's amount/counterparty/timestamp, or identity.
/// Verifier: alt_bn128_pairing syscall (~150k CU).
pub const INSTRUCTION_DATA_LEN: usize = 448;

const OFF_PROOF: usize = 0;
const OFF_ROOT: usize = 256;
const OFF_THRESHOLD: usize = 288;
const OFF_SCOPE: usize = 320;
const OFF_EPOCH: usize = 352;
const OFF_NULLIFIER: usize = 384;
const OFF_AGENT_COMMIT: usize = 416;

fn parse32(data: &[u8], off: usize) -> [u8; 32] {
    data[off..off + 32].try_into().unwrap_or([0u8; 32])
}

fn hex32(bytes: &[u8; 32]) -> [u8; 64] {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = [0u8; 64];
    for (i, &b) in bytes.iter().enumerate() {
        out[i * 2] = HEX[(b >> 4) as usize];
        out[i * 2 + 1] = HEX[(b & 0x0f) as usize];
    }
    out
}

fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // 1. Length check
    if data.len() != INSTRUCTION_DATA_LEN {
        msg!("dark_x402_access_gate: expected {} bytes, got {}", INSTRUCTION_DATA_LEN, data.len());
        return Err(ProgramError::InvalidInstructionData);
    }

    // 2. Parse proof + public inputs
    let proof_bytes: &[u8; 256] = data[OFF_PROOF..OFF_PROOF + 256].try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    let root         = parse32(data, OFF_ROOT);
    let threshold    = parse32(data, OFF_THRESHOLD);
    let scope_hash   = parse32(data, OFF_SCOPE);
    let epoch        = parse32(data, OFF_EPOCH);
    let nullifier    = parse32(data, OFF_NULLIFIER);
    let agent_commit = parse32(data, OFF_AGENT_COMMIT);

    let iter = &mut accounts.iter();
    let payer            = next_account_info(iter)?;
    let receipt_tree     = next_account_info(iter)?;
    let nullifier_record = next_account_info(iter)?;
    let system_program   = next_account_info(iter)?;

    // 3. Bind `root` to the canonical on-chain receipt tree (mirrors dark_reputation_gate).
    //    Without this, a prover substitutes a self-built tree of fabricated leaves and the
    //    Merkle membership in the circuit is satisfiable against THAT root — re-opening the
    //    tautology at the data layer. Pin the PDA, owner, reject root=0, require a known root.
    let (tree_pda, _tb) =
        Pubkey::find_program_address(&[RECEIPT_TREE_SEED, &CANONICAL_TREE_ID], &RECEIPT_TREE_PROGRAM);
    if receipt_tree.key != &tree_pda {
        return Err(ProgramError::InvalidArgument);
    }
    if receipt_tree.owner != &RECEIPT_TREE_PROGRAM {
        return Err(ProgramError::IllegalOwner);
    }
    {
        let td = receipt_tree.try_borrow_data()?;
        if td.len() < RT_TREE_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        // Reject the zero root: a fresh tree leaves history slots 1..8 all-zero. The circuit
        // already makes root=0 unprovable (no Poseidon path hashes to 0), but don't rely on it.
        if root == [0u8; 32] {
            return Err(ProgramError::Custom(11));
        }
        let mut known = false;
        for i in 0..RT_ROOT_HISTORY {
            let off = RT_O_ROOTS + i * 32;
            if td[off..off + 32] == root[..] {
                known = true;
                break;
            }
        }
        if !known {
            return Err(ProgramError::Custom(11)); // UnknownRoot — not the canonical tree's root
        }
    }

    // 4. Build public inputs array — MUST match x402_access_v2.circom's `public [...]` order.
    let public_inputs: [[u8; 32]; NR_PUBLIC_INPUTS] =
        [root, threshold, scope_hash, epoch, nullifier, agent_commit];

    // 5. Load v2 VK; fail closed on a non-trustless VK (devnet builds pass `--features devnet`).
    let vk = x402_access_v2_vk();
    #[cfg(not(feature = "devnet"))]
    if !vk.mainnet_ready {
        return Err(ProgramError::Custom(2));
    }

    // 6. Verify Groth16 proof on-chain via alt_bn128_pairing syscall
    let proof_a_bytes: [u8; 64]  = proof_bytes[0..64].try_into().unwrap_or([0u8; 64]);
    let proof_b_bytes: [u8; 128] = proof_bytes[64..192].try_into().unwrap_or([0u8; 128]);
    let proof_c_bytes: [u8; 64]  = proof_bytes[192..256].try_into().unwrap_or([0u8; 64]);
    let proof = Groth16Proof {
        a: g1_from_bytes(&proof_a_bytes),
        b: g2_from_bytes(&proof_b_bytes),
        c: g1_from_bytes(&proof_c_bytes),
    };
    let verified = groth16_verify(&vk, &proof, &public_inputs)
        .map_err(|_| ProgramError::Custom(1))?;
    if !verified {
        return Err(ProgramError::Custom(1));
    }

    // 7. Single-use nullifier — replay protection. PDA [b"x402_nullifier", nullifier] under
    //    THIS program. Present (owned here, non-empty) => replay (reject); absent => create.
    //    Same front-run-safe pattern as dark_reputation_gate / dark_shielded_pool.
    let (expected_pda, bump) =
        Pubkey::find_program_address(&[X402_NULLIFIER_SEED, &nullifier], program_id);
    if expected_pda != *nullifier_record.key {
        return Err(ProgramError::InvalidArgument);
    }
    if nullifier_record.owner == program_id && !nullifier_record.data_is_empty() {
        return Err(ProgramError::Custom(3)); // AlreadyRecorded — replay
    }
    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *system_program.key != solana_program::system_program::id() {
        return Err(ProgramError::IncorrectProgramId);
    }
    let rent = Rent::get()?;
    let space: usize = 1; // 1-byte marker (stores the bump)
    let needed = rent.minimum_balance(space);
    let seeds: &[&[u8]] = &[X402_NULLIFIER_SEED, &nullifier, &[bump]];
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
    let comm_hex = hex32(&agent_commit);
    msg!(
        "dark_x402_access_gate v2: merkle-bound access proof verified (root canonical) agent={} nullifier={}",
        core::str::from_utf8(&comm_hex).unwrap_or("?"),
        core::str::from_utf8(&null_hex).unwrap_or("?")
    );

    Ok(())
}
