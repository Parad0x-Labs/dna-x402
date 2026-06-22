use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
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
    track_record_vk::{track_record_vk, NR_PUBLIC_INPUTS},
    Groth16Proof,
};

entrypoint!(process_instruction);

// ─── canonical receipt tree binding (audit HIGH fix) ────────────────────────────
// The track-record proof opens against a Merkle `root`. That root MUST be the root of
// the AUTHORITATIVE on-chain receipt tree — otherwise an attacker builds their own tree
// off-chain with fabricated receipt leaves, proves against it, and forges reputation
// (Sybil). We therefore require the caller to pass the canonical receipt_commitment_tree
// PDA and we accept `root` only if it matches one of that tree's recent roots.
//
// DEVNET program id of dark_receipt_commitment_tree. Mainnet redeploy MUST update this
// (matches the existing convention of hardcoding sibling program ids).
const RECEIPT_TREE_PROGRAM: Pubkey =
    solana_program::pubkey!("H9nL9tErFXFmr2ZGkgFVz2NpjAsAeDBXDgS85qBWFGAe");
const RECEIPT_TREE_SEED: &[u8] = b"receipt_tree";
/// Canonical reputation tree id (the one settlement writes receipts into). Devnet POC = 0.
const CANONICAL_TREE_ID: [u8; 8] = [0u8; 8];
// receipt_commitment_tree account layout (see that program): DEPTH=10, ROOT_HISTORY=8.
const RT_ROOT_HISTORY: usize = 8;
const RT_O_ROOTS: usize = 682; // O_ZEROS(42+10*32) + DEPTH*32 = 682
const RT_TREE_LEN: usize = RT_O_ROOTS + RT_ROOT_HISTORY * 32; // 938

/// Self-owned single-use nullifier PDA seed (no external program dependency — the prior
/// external-CPI design used a wrong/foreign program id and let anyone front-run the
/// nullifier via the permissionless record program; we now own it here, like x402_access).
const REP_NULLIFIER_SEED: &[u8] = b"rep_nullifier";

/// Instruction data layout — track_record circuit, 6 public inputs (448 bytes):
///   proof[256]                — BN254 Groth16 proof (A:64 B:128 C:64)
///   root[32]                  — anchored receipt Merkle root (MUST match the canonical tree)
///   min_count[32]             — required receipt count (tier bar)
///   min_volume[32]            — required total settled volume
///   window_start[32]          — earliest acceptable receipt timestamp
///   reputation_nullifier[32]  — Poseidon(DOMAIN_REP, secret, epoch); recorded single-use
///   agent_commitment[32]      — Poseidon(secret, agent_id); same identity as dark_x402_access_gate
///
/// Accounts:
///   0. payer                 [signer, writable] — funds the nullifier PDA rent
///   1. receipt_tree          []                 — canonical PDA(["receipt_tree", 0]) @ RECEIPT_TREE_PROGRAM
///   2. nullifier_record_pda  [writable]         — PDA(["rep_nullifier", reputation_nullifier]) @ this program
///   3. system_program        []
pub const INSTRUCTION_DATA_LEN: usize = 480; // 256 proof + 7 public inputs * 32

const OFF_PROOF: usize = 0;
const OFF_ROOT: usize = 256;
const OFF_MIN_COUNT: usize = 288;
const OFF_MIN_VOLUME: usize = 320;
const OFF_WINDOW_START: usize = 352;
const OFF_REP_NULL: usize = 384;
const OFF_AGENT_COMMIT: usize = 416;
const OFF_EPOCH: usize = 448;

/// Epoch window length in seconds. The reputation_nullifier is Poseidon(DOMAIN_REP, secret,
/// epoch), and the gate requires epoch == floor(Clock.unix_timestamp / EPOCH_LEN), so one
/// identity can mint at most one reputation_nullifier per window. 86_400 = 1 day (GhostScore
/// daily rate-limit). Cheap to retune — it lives only here and in the prover, not the circuit.
const EPOCH_LEN: i64 = 86_400;

fn parse32(data: &[u8], off: usize) -> [u8; 32] {
    data[off..off + 32].try_into().unwrap_or([0u8; 32])
}

/// True iff `epoch` (a BN254-Fr big-endian 32-byte field element) equals the CURRENT clock
/// window `floor(now / EPOCH_LEN)`. The window fits in u64, so the high 24 bytes must be zero;
/// `now` must be non-negative. Current bucket only — no carry — so an identity can present at
/// most one reputation_nullifier per EPOCH_LEN (anti-Sybil rate-limit).
fn epoch_in_window(epoch: &[u8; 32], now: i64) -> bool {
    if epoch[..24] != [0u8; 24] || now < 0 {
        return false;
    }
    let epoch_val = u64::from_be_bytes(epoch[24..32].try_into().unwrap());
    epoch_val == (now / EPOCH_LEN) as u64
}

fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
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
    let epoch        = parse32(data, OFF_EPOCH);

    // ── HIGH fix (anti-Sybil): bind the public `epoch` to the on-chain clock window ─────
    // epoch is folded into reputation_nullifier = Poseidon(DOMAIN_REP, secret, epoch) and is
    // now a PUBLIC circuit input. Previously it was a prover-chosen free witness, so one
    // identity minted unlimited nullifiers across self-picked epochs (zero rate-limit). We
    // require epoch == floor(now / EPOCH_LEN) — the CURRENT bucket only — capping each
    // identity to one reputation spend per EPOCH_LEN. Checked before the expensive pairing so a
    // stale/forged epoch is rejected cheaply.
    if !epoch_in_window(&epoch, Clock::get()?.unix_timestamp) {
        return Err(ProgramError::Custom(12)); // StaleOrForgedEpoch / out-of-range
    }

    let iter = &mut accounts.iter();
    let payer           = next_account_info(iter)?;
    let receipt_tree    = next_account_info(iter)?;
    let nullifier_record = next_account_info(iter)?;
    let system_program  = next_account_info(iter)?;

    // ── HIGH fix: bind `root` to the canonical on-chain receipt tree ────────────
    // Reject unless `receipt_tree` is the canonical PDA owned by the receipt tree program,
    // and `root` equals one of its recent (ROOT_HISTORY) roots. This stops an attacker from
    // initialising their own tree (also owned by that program) with fabricated leaves.
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
        // Reject the zero root explicitly: a freshly-initialised tree leaves history slots
        // 1..8 all-zero (only slot 0 holds the non-zero empty-tree root), so without this an
        // attacker could pass root=0 and match an unwritten slot. The circuit already makes
        // this unprovable (no Poseidon path hashes to 0), but don't rely on it on-chain.
        // Mirrors dark-shielded-pool-core::merkle (root==[0;32] => reject).
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

    // circuit public-input order (epoch appended last — must match track_record.circom)
    let public_inputs: [[u8; 32]; NR_PUBLIC_INPUTS] =
        [root, min_count, min_volume, window_start, rep_null, agent_commit, epoch];

    // ── verify the Groth16 track-record proof ──────────────────────────────────
    let vk = track_record_vk();
    // Fail closed on a non-trustless VK (audit MEDIUM: this guard was missing here).
    // Devnet ships a single-party VK; `--features devnet` skips this. Mainnet omits the
    // feature → guard active (fail-closed). Mirrors dark_shielded_pool / dark_x402_access_gate.
    #[cfg(not(feature = "devnet"))]
    if !vk.mainnet_ready {
        return Err(ProgramError::Custom(2));
    }
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

    // ── single-use nullifier: SELF-OWNED PDA (no external program) ──────────────
    // [b"rep_nullifier", reputation_nullifier] under THIS program id. Present => replay.
    let (np, nbump) = Pubkey::find_program_address(&[REP_NULLIFIER_SEED, &rep_null], program_id);
    if nullifier_record.key != &np {
        return Err(ProgramError::InvalidArgument);
    }
    // Spent iff we created+initialized it (owned here, non-empty). NOT lamports (front-run safe).
    if nullifier_record.owner == program_id && !nullifier_record.data_is_empty() {
        return Err(ProgramError::Custom(10)); // AlreadyRecorded
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
    let seeds: &[&[u8]] = &[REP_NULLIFIER_SEED, &rep_null, &[nbump]];
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
    nullifier_record.try_borrow_mut_data()?[0] = nbump;

    msg!("dark_reputation_gate: track-record proof verified (root bound to canonical tree) + nullifier recorded");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{epoch_in_window, EPOCH_LEN};

    // big-endian 32-byte field element from a u64 (matches the circuit/gate epoch encoding)
    fn be32(v: u64) -> [u8; 32] {
        let mut b = [0u8; 32];
        b[24..32].copy_from_slice(&v.to_be_bytes());
        b
    }

    #[test]
    fn current_window_is_accepted() {
        let now = 5 * EPOCH_LEN + 123; // somewhere inside bucket 5
        assert!(epoch_in_window(&be32(5), now));
    }

    #[test]
    fn future_epoch_is_rejected() {
        let now = 5 * EPOCH_LEN + 123;
        assert!(!epoch_in_window(&be32(6), now)); // pre-minting a future window must fail
    }

    #[test]
    fn stale_epoch_is_rejected() {
        let now = 5 * EPOCH_LEN + 123;
        assert!(!epoch_in_window(&be32(4), now)); // no carry — previous window is rejected
    }

    #[test]
    fn the_sybil_attack_is_closed() {
        // The vuln: same identity mints nullifiers under self-chosen epochs. Now only the one
        // bucket matching the clock is accepted, so every other self-chosen epoch is rejected.
        let now = 100 * EPOCH_LEN;
        let cur = 100u64;
        let mut accepted = 0;
        for e in (cur - 3)..=(cur + 3) {
            if epoch_in_window(&be32(e), now) {
                accepted += 1;
            }
        }
        assert_eq!(accepted, 1, "exactly one epoch (the current bucket) may be accepted");
    }

    #[test]
    fn out_of_u64_range_epoch_is_rejected() {
        let now = 5 * EPOCH_LEN;
        let mut e = be32(5);
        e[0] = 1; // set a high byte -> field element exceeds u64 window
        assert!(!epoch_in_window(&e, now));
    }

    #[test]
    fn negative_clock_is_rejected() {
        assert!(!epoch_in_window(&be32(0), -1));
    }
}
