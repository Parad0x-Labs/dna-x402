use crate::error::ShieldedPoolError;
use crate::instruction::PoolInstruction;
use crate::state::{
    NoteLeaf, NullifierRecord, PoolConfig, NOTE_LEAF_LEN, NULLIFIER_RECORD_LEN, POOL_CONFIG_LEN,
    POOL_CONFIG_VERSION,
};
use dark_groth16_core::shielded_withdraw_v3_vk::shielded_withdraw_v3_vk;
use dark_groth16_core::{groth16_verify, proof_from_bytes};
use dark_poseidon_real::{
    commitment as poseidon_commitment, merkle_node, nullifier as poseidon_nullifier,
    reduce_be_to_field,
};
use dark_shielded_pool_core::TREE_DEPTH;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    program_pack::{IsInitialized, Pack},
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

// ─── hash helpers (v2 — real circomlib-matching Poseidon) ────────────────────
//
// All hashing delegates to `dark-poseidon-real`, which on SBF uses the
// `sol_poseidon` Bn254X5/BigEndian syscall and byte-matches the circom circuit:
//   commitment = Poseidon(3)(DOMAIN_COMMIT=1, secret, leaf_index)
//   nullifier  = Poseidon(3)(DOMAIN_NULLIF=2, secret, pool_key_field)
//   merkle     = Poseidon(2)(left, right)
// A real Groth16 proof for shielded_withdraw_v2 therefore verifies against the
// state this program computes.

/// `commitment = Poseidon(3)(1, secret, leaf_index)`. Matches the circuit.
pub fn commitment_hash(secret: &[u8; 32], leaf_index: u64) -> [u8; 32] {
    poseidon_commitment(secret, leaf_index)
}

/// `nullifier = Poseidon(3)(2, secret, pool_key_field)`. `pool_key` is reduced
/// into the BN254 scalar field first (a raw PDA can exceed `r`).
pub fn nullifier_hash(secret: &[u8; 32], pool_key: &[u8; 32]) -> [u8; 32] {
    poseidon_nullifier(secret, &reduce_be_to_field(pool_key))
}

/// `node = Poseidon(2)(left, right)` — one internal Merkle node.
pub fn merkle_node_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    merkle_node(left, right)
}

/// Zero-subtree hashes: `zeros[0] = 0`, `zeros[i] = Poseidon(zeros[i-1], zeros[i-1])`.
/// `zeros[i]` is the root of an empty subtree of height `i` — used to pad the
/// right side of the incremental tree exactly as the circuit pads empty leaves.
///
/// Heap-allocated (`Box`) so the 672-byte table never lands on the 4 KB SBF stack.
pub fn zero_hashes() -> Box<[[u8; 32]; TREE_DEPTH + 1]> {
    let mut zeros = Box::new([[0u8; 32]; TREE_DEPTH + 1]);
    let mut i = 1;
    while i <= TREE_DEPTH {
        zeros[i] = merkle_node(&zeros[i - 1], &zeros[i - 1]);
        i += 1;
    }
    zeros
}

/// Insert `leaf` at `leaf_index` into the incremental tree represented by
/// `filled_subtrees`, returning the new root and mutating `filled_subtrees` in
/// place. O(TREE_DEPTH) Poseidon syscalls — no leaf PDAs are read back.
///
/// Standard Tornado incremental-Merkle insertion: walk up from the leaf; at a
/// left child store the running hash in `filled_subtrees[level]` and pair with
/// the zero-subtree on the right; at a right child pair with the stored left.
pub fn insert_leaf(
    filled_subtrees: &mut [[u8; 32]; TREE_DEPTH],
    zeros: &[[u8; 32]],
    leaf_index: u64,
    leaf: [u8; 32],
) -> [u8; 32] {
    let mut current_index = leaf_index;
    let mut current_hash = leaf;
    let mut i = 0;
    while i < TREE_DEPTH {
        let (left, right) = if current_index & 1 == 0 {
            filled_subtrees[i] = current_hash;
            (current_hash, zeros[i])
        } else {
            (filled_subtrees[i], current_hash)
        };
        current_hash = merkle_node(&left, &right);
        current_index >>= 1;
        i += 1;
    }
    current_hash
}

// ─── Groth16 verification (v3 circuit, 7 public inputs) ──────────────────────

/// Convert a u64 lamport value to a 32-byte big-endian field element (matches the
/// circuit, which takes `fee`/`denomination` as plain field-element decimals).
fn u64_to_field(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..32].copy_from_slice(&v.to_be_bytes());
    out
}

/// Verify a shielded_withdraw_v3 Groth16 proof against the devnet VK using the real
/// BN254 `alt_bn128` pairing syscall (DARK RELAY RAIL — relayer + fee bound).
///
/// Public inputs, in the circuit's `public [...]` order:
///   [0] nullifier, [1] merkle_root, [2] recipient (reduced), [3] pool_id (reduced),
///   [4] relayer (reduced), [5] fee, [6] denomination
///
/// `recipient`, `pool_id`, `relayer` are reduced into the BN254 scalar field so a
/// raw 32-byte pubkey that exceeds `r` still maps to the same scalar the prover used.
/// `fee` and `denomination` are small u64 values mapped to big-endian field elements.
#[allow(clippy::too_many_arguments)]
pub fn verify_proof_groth16(
    proof: &[u8; 256],
    nullifier: &[u8; 32],
    merkle_root: &[u8; 32],
    recipient: &[u8; 32],
    pool_id: &[u8; 32],
    relayer: &[u8; 32],
    fee: u64,
    denomination: u64,
) -> bool {
    let vk = shielded_withdraw_v3_vk();
    // gamma_abc.len() must be 8 (7 public inputs + constant term).
    if vk.gamma_abc.len() != 8 {
        return false;
    }
    let public_inputs = [
        *nullifier,
        *merkle_root,
        reduce_be_to_field(recipient),
        reduce_be_to_field(pool_id),
        reduce_be_to_field(relayer),
        u64_to_field(fee),
        u64_to_field(denomination),
    ];
    let parsed = proof_from_bytes(proof);
    matches!(groth16_verify(&vk, &parsed, &public_inputs), Ok(true))
}

// ─── PDA seeds ────────────────────────────────────────────────────────────────

pub const POOL_CONFIG_SEED: &[u8] = b"pool_config";
pub const POOL_VAULT_SEED: &[u8] = b"pool_vault";
pub const NOTE_LEAF_SEED: &[u8] = b"note_leaf";
pub const NULLIFIER_SEED: &[u8] = b"nullifier";

// ─── entrypoint dispatcher ────────────────────────────────────────────────────

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let ix = PoolInstruction::unpack(data)?;
    match ix {
        PoolInstruction::InitPool { denomination } => {
            process_init_pool(program_id, accounts, denomination)
        }
        PoolInstruction::Deposit { commitment } => {
            process_deposit(program_id, accounts, commitment)
        }
        PoolInstruction::Withdraw {
            nullifier,
            root,
            proof,
            recipient,
            relayer,
            fee,
        } => process_withdraw(
            program_id, accounts, nullifier, root, proof, recipient, relayer, fee,
        ),
        PoolInstruction::PausePool => process_pause(program_id, accounts, true),
        PoolInstruction::ResumePool => process_pause(program_id, accounts, false),
    }
}

// ─── InitPool ─────────────────────────────────────────────────────────────────

#[inline(never)]
fn process_init_pool(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    denomination: u64,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let pool_config_info = next_account_info(iter)?;
    let pool_vault_info = next_account_info(iter)?;
    let authority_info = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    if denomination == 0 {
        return Err(ShieldedPoolError::ZeroDenomination.into());
    }

    let (pool_config_key, config_bump) = Pubkey::find_program_address(
        &[POOL_CONFIG_SEED, authority_info.key.as_ref()],
        program_id,
    );
    if pool_config_key != *pool_config_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    let (pool_vault_key, vault_bump) = Pubkey::find_program_address(
        &[POOL_VAULT_SEED, pool_config_info.key.as_ref()],
        program_id,
    );
    if pool_vault_key != *pool_vault_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    let rent = Rent::get()?;

    let config_lamports = rent.minimum_balance(POOL_CONFIG_LEN);
    invoke_signed(
        &system_instruction::create_account(
            authority_info.key,
            pool_config_info.key,
            config_lamports,
            POOL_CONFIG_LEN as u64,
            program_id,
        ),
        &[
            authority_info.clone(),
            pool_config_info.clone(),
            system_program.clone(),
        ],
        &[&[POOL_CONFIG_SEED, authority_info.key.as_ref(), &[config_bump]]],
    )?;

    let vault_lamports = rent.minimum_balance(0);
    invoke_signed(
        &system_instruction::create_account(
            authority_info.key,
            pool_vault_info.key,
            vault_lamports,
            0,
            program_id,
        ),
        &[
            authority_info.clone(),
            pool_vault_info.clone(),
            system_program.clone(),
        ],
        &[&[POOL_VAULT_SEED, pool_config_info.key.as_ref(), &[vault_bump]]],
    )?;

    // Empty incremental tree: filled_subtrees[i] = zeros[i], root = zeros[DEPTH].
    let zeros = zero_hashes();
    let mut config: Box<PoolConfig> = Box::new(PoolConfig::default());
    config.version = POOL_CONFIG_VERSION;
    config.bump = config_bump;
    config.is_initialized = true;
    config.is_paused = false;
    config.authority = authority_info.key.to_bytes();
    config.denomination = denomination;
    config.merkle_root = zeros[TREE_DEPTH];
    config.note_count = 0;
    for (i, slot) in config.filled_subtrees.iter_mut().enumerate() {
        *slot = zeros[i];
    }
    // Seed the ring with the empty root so a withdrawal proof can never be
    // accepted against a zero root, but the genuine empty root is known.
    config.push_recent_root(zeros[TREE_DEPTH]);

    PoolConfig::pack_boxed(&config, &mut pool_config_info.data.borrow_mut());

    msg!("ShieldedPool v2: initialized denomination={}", denomination);
    Ok(())
}

// ─── Deposit ──────────────────────────────────────────────────────────────────

#[inline(never)]
fn process_deposit(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    commitment: [u8; 32],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let pool_config_info = next_account_info(iter)?;
    let pool_vault_info = next_account_info(iter)?;
    let note_leaf_info = next_account_info(iter)?;
    let depositor_info = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    let mut config = PoolConfig::unpack_boxed(&pool_config_info.data.borrow())?;
    if !config.is_initialized() {
        return Err(ShieldedPoolError::NotInitialized.into());
    }
    if config.is_paused {
        return Err(ShieldedPoolError::PoolPaused.into());
    }
    if commitment == [0u8; 32] {
        return Err(ShieldedPoolError::ZeroCommitment.into());
    }
    if config.denomination < crate::MINIMUM_DEPOSIT_LAMPORTS {
        return Err(ShieldedPoolError::BelowMinimumDeposit.into());
    }

    let leaf_index = config.note_count;
    let clock = Clock::get()?;
    let rent = Rent::get()?;

    let (note_leaf_key, leaf_bump) = Pubkey::find_program_address(
        &[
            NOTE_LEAF_SEED,
            pool_config_info.key.as_ref(),
            &leaf_index.to_le_bytes(),
        ],
        program_id,
    );
    if note_leaf_key != *note_leaf_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    invoke_signed(
        &system_instruction::create_account(
            depositor_info.key,
            note_leaf_info.key,
            rent.minimum_balance(NOTE_LEAF_LEN),
            NOTE_LEAF_LEN as u64,
            program_id,
        ),
        &[
            depositor_info.clone(),
            note_leaf_info.clone(),
            system_program.clone(),
        ],
        &[&[
            NOTE_LEAF_SEED,
            pool_config_info.key.as_ref(),
            &leaf_index.to_le_bytes(),
            &[leaf_bump],
        ]],
    )?;

    invoke_signed(
        &system_instruction::transfer(
            depositor_info.key,
            pool_vault_info.key,
            config.denomination,
        ),
        &[
            depositor_info.clone(),
            pool_vault_info.clone(),
            system_program.clone(),
        ],
        &[],
    )?;

    let leaf = NoteLeaf {
        bump: leaf_bump,
        commitment,
        leaf_index,
        deposited_at: clock.unix_timestamp,
    };
    NoteLeaf::pack(leaf, &mut note_leaf_info.data.borrow_mut())?;

    // Insert the commitment into the REAL incremental Poseidon Merkle tree.
    let zeros = zero_hashes();
    let new_root = insert_leaf(&mut config.filled_subtrees, &zeros[..], leaf_index, commitment);
    config.merkle_root = new_root;
    config.push_recent_root(new_root);
    config.note_count = config
        .note_count
        .checked_add(1)
        .ok_or(ShieldedPoolError::ArithmeticOverflow)?;
    PoolConfig::pack_boxed(&config, &mut pool_config_info.data.borrow_mut());

    msg!("ShieldedPool v2: deposit leaf_index={}", leaf_index);
    Ok(())
}

// ─── Withdraw ────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn process_withdraw(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    nullifier: [u8; 32],
    proven_root: [u8; 32],
    proof: [u8; 256],
    recipient: Pubkey,
    relayer: Pubkey,
    fee: u64,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let pool_config_info = next_account_info(iter)?;
    let pool_vault_info = next_account_info(iter)?;
    let nullifier_rec_info = next_account_info(iter)?;
    let recipient_info = next_account_info(iter)?;
    // Fee-payer (relayer) — funds the nullifier-record PDA rent, signs the tx, AND
    // is reimbursed `fee` lamports from the pool. The recipient never has to sign or
    // pre-fund anything; the proof binds the recipient AND the relayer + fee, so a
    // relayer cannot redirect the funds or inflate its own reimbursement.
    let fee_payer_info = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    if !fee_payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let config = PoolConfig::unpack_boxed(&pool_config_info.data.borrow())?;
    if !config.is_initialized() {
        return Err(ShieldedPoolError::NotInitialized.into());
    }
    if config.is_paused {
        return Err(ShieldedPoolError::PoolPaused.into());
    }
    if recipient != *recipient_info.key {
        return Err(ProgramError::InvalidArgument);
    }
    // The relayer bound in the proof MUST be the signer reimbursing itself. This
    // ties the proof's relayer public input to the account that actually receives
    // `fee`, so a third party cannot replay someone else's proof and pocket the fee.
    if relayer != *fee_payer_info.key {
        return Err(ProgramError::InvalidArgument);
    }
    // Defense-in-depth: the circuit already enforces fee <= MAX_FEE and fee <=
    // denomination, but reject an over-denomination fee here too so a malformed
    // instruction never underflows the payout before the proof is even checked.
    if fee > config.denomination {
        return Err(ShieldedPoolError::FeeExceedsDenomination.into());
    }

    // The proven root (from instruction data) must be the current root or one of
    // the recent roots — prevents proving against a forged/never-existed root.
    if !config.knows_root(&proven_root) {
        return Err(ShieldedPoolError::UnknownRoot.into());
    }

    // Nullifier PDA existence = already spent.
    let (nullifier_key, null_bump) = Pubkey::find_program_address(
        &[NULLIFIER_SEED, pool_config_info.key.as_ref(), &nullifier],
        program_id,
    );
    if nullifier_key != *nullifier_rec_info.key {
        return Err(ProgramError::InvalidArgument);
    }
    if nullifier_rec_info.data_len() > 0 {
        return Err(ShieldedPoolError::NullifierAlreadySpent.into());
    }

    // Verify the ZK proof against the PROVEN root. The v3 proof binds recipient,
    // pool_id, relayer, fee, and the pool's denomination — so the payout split
    // (recipient gets denom - fee, relayer gets fee) is fixed by the proof.
    let recipient_field: [u8; 32] = recipient_info.key.to_bytes();
    let pool_id_field: [u8; 32] = pool_config_info.key.to_bytes();
    let relayer_field: [u8; 32] = fee_payer_info.key.to_bytes();
    if !verify_proof_groth16(
        &proof,
        &nullifier,
        &proven_root,
        &recipient_field,
        &pool_id_field,
        &relayer_field,
        fee,
        config.denomination,
    ) {
        return Err(ShieldedPoolError::ProofInvalid.into());
    }

    let rent = Rent::get()?;
    let clock = Clock::get()?;

    let vault_balance = pool_vault_info.lamports();
    if vault_balance < config.denomination {
        return Err(ShieldedPoolError::InsufficientFunds.into());
    }

    // Fee-payer funds the nullifier-record PDA (recipient need not sign/pre-fund).
    invoke_signed(
        &system_instruction::create_account(
            fee_payer_info.key,
            nullifier_rec_info.key,
            rent.minimum_balance(NULLIFIER_RECORD_LEN),
            NULLIFIER_RECORD_LEN as u64,
            program_id,
        ),
        &[
            fee_payer_info.clone(),
            nullifier_rec_info.clone(),
            system_program.clone(),
        ],
        &[&[
            NULLIFIER_SEED,
            pool_config_info.key.as_ref(),
            &nullifier,
            &[null_bump],
        ]],
    )?;

    let record = NullifierRecord {
        bump: null_bump,
        nullifier,
        spent_at: clock.unix_timestamp,
    };
    NullifierRecord::pack(record, &mut nullifier_rec_info.data.borrow_mut())?;

    // DARK RELAY RAIL 2-way payout (proof-bound split): pool_vault →
    //   recipient += denomination - fee
    //   relayer   += fee
    // The fee <= denomination invariant is enforced by the circuit AND re-checked
    // above, so the subtraction never underflows.
    let payout = config
        .denomination
        .checked_sub(fee)
        .ok_or(ShieldedPoolError::FeeExceedsDenomination)?;
    **pool_vault_info.lamports.borrow_mut() -= config.denomination;
    **recipient_info.lamports.borrow_mut() += payout;
    **fee_payer_info.lamports.borrow_mut() += fee;

    msg!(
        "ShieldedPool v3: withdraw denom={} payout={} fee={} recipient={} relayer={}",
        config.denomination,
        payout,
        fee,
        recipient,
        relayer
    );
    Ok(())
}

// ─── PausePool / ResumePool ──────────────────────────────────────────────────

fn process_pause(_program_id: &Pubkey, accounts: &[AccountInfo], pause: bool) -> ProgramResult {
    let iter = &mut accounts.iter();
    let pool_config_info = next_account_info(iter)?;
    let authority_info = next_account_info(iter)?;

    // Direct byte access (offset 4..36 = authority, offset 3 = is_paused). The
    // full PoolConfig is ~1 KB; unpacking it onto the SBF stack here would blow
    // the 4 KB frame, so we touch only the two fields we need.
    let mut data = pool_config_info.data.borrow_mut();
    if data.len() < POOL_CONFIG_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    if data[4..36] != authority_info.key.to_bytes()[..] {
        return Err(ProgramError::InvalidArgument);
    }
    if !authority_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    data[3] = pause as u8;
    msg!("ShieldedPool: paused={}", pause);
    Ok(())
}
