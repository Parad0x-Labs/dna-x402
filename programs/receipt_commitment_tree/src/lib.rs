//! receipt_commitment_tree — incremental Poseidon Merkle tree of x402 receipt commitments.
//!
//! The settlement layer (an authorized writer) inserts a leaf
//!   leaf = Poseidon(agent_commitment, amount, ts, counterparty, nonce)
//! on each settled payment. The tree keeps only the frontier + a rolling root history
//! on-chain (NOT the leaves) — so cost is constant regardless of receipt count.
//!
//! The root produced here is the same root dark_reputation_gate verifies track-record
//! proofs against (Poseidon Bn254X5 == circomlib == poseidon-lite). One global tree (POC).
//!
//! Instructions:
//!   0x00 Initialize { authority[32] }   accounts: [payer(s,w), tree_pda(w), system]
//!   0x01 InsertLeaf { leaf[32] }        accounts: [authority(s), tree_pda(w)]

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    poseidon::{hashv, Endianness, Parameters},
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

entrypoint!(process_instruction);

const DEPTH: usize = 10; // POC depth — matches track_record.circom (1,024 receipts)
const ROOT_HISTORY: usize = 8; // recent roots accepted by the gate
const TREE_SEED: &[u8] = b"receipt_tree";

const O_AUTH: usize = 0; // [32] authorized writer (settlement signer)
const O_NEXT: usize = 32; // [8]  next leaf index (u64 le)
const O_RIDX: usize = 40; // [1]  current root-history index
const O_BUMP: usize = 41; // [1]
const O_FILLED: usize = 42; // [DEPTH*32] frontier
const O_ZEROS: usize = O_FILLED + DEPTH * 32; // [DEPTH*32] empty-subtree hashes
const O_ROOTS: usize = O_ZEROS + DEPTH * 32; // [ROOT_HISTORY*32] rolling roots
const TREE_LEN: usize = O_ROOTS + ROOT_HISTORY * 32;

fn poseidon2(a: &[u8; 32], b: &[u8; 32]) -> Result<[u8; 32], ProgramError> {
    hashv(Parameters::Bn254X5, Endianness::BigEndian, &[a.as_slice(), b.as_slice()])
        .map(|h| h.to_bytes())
        .map_err(|_| ProgramError::Custom(20))
}

fn rd32(d: &[u8], o: usize) -> [u8; 32] {
    d[o..o + 32].try_into().unwrap_or([0u8; 32])
}

fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (tag, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    match tag {
        0x00 => initialize(program_id, accounts, rest),
        0x01 => insert_leaf(program_id, accounts, rest),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], rest: &[u8]) -> ProgramResult {
    if rest.len() < 40 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let tree_id: [u8; 8] = rest[0..8].try_into().unwrap();
    let authority: [u8; 32] = rest[8..40].try_into().unwrap();

    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let tree = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;
    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (pda, bump) = Pubkey::find_program_address(&[TREE_SEED, &tree_id], program_id);
    if tree.key != &pda {
        return Err(ProgramError::InvalidArgument);
    }
    if !tree.data_is_empty() {
        return Err(ProgramError::Custom(21)); // already initialized
    }
    let rent = Rent::get()?.minimum_balance(TREE_LEN);
    invoke_signed(
        &system_instruction::create_account(payer.key, &pda, rent, TREE_LEN as u64, program_id),
        &[payer.clone(), tree.clone(), system_program.clone()],
        &[&[TREE_SEED, &tree_id, &[bump]]],
    )?;

    let mut d = tree.try_borrow_mut_data()?;
    d[O_AUTH..O_AUTH + 32].copy_from_slice(&authority);
    d[O_BUMP] = bump;

    // zeros[0]=0; zeros[i+1]=Poseidon(zeros[i],zeros[i]); filled[i]=zeros[i].
    let mut zero = [0u8; 32];
    for i in 0..DEPTH {
        d[O_ZEROS + i * 32..O_ZEROS + i * 32 + 32].copy_from_slice(&zero);
        d[O_FILLED + i * 32..O_FILLED + i * 32 + 32].copy_from_slice(&zero);
        zero = poseidon2(&zero, &zero)?;
    }
    // initial root = zeros[DEPTH] = root of the empty tree.
    d[O_ROOTS..O_ROOTS + 32].copy_from_slice(&zero);
    msg!("receipt_commitment_tree: initialized depth={}", DEPTH);
    Ok(())
}

fn insert_leaf(program_id: &Pubkey, accounts: &[AccountInfo], rest: &[u8]) -> ProgramResult {
    if rest.len() < 40 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let tree_id: [u8; 8] = rest[0..8].try_into().unwrap();
    let leaf: [u8; 32] = rest[8..40].try_into().unwrap();

    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let tree = next_account_info(iter)?;
    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (pda, _bump) = Pubkey::find_program_address(&[TREE_SEED, &tree_id], program_id);
    if tree.key != &pda {
        return Err(ProgramError::InvalidArgument);
    }
    let mut d = tree.try_borrow_mut_data()?;
    if d.len() != TREE_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    if d[O_AUTH..O_AUTH + 32] != authority.key.to_bytes() {
        return Err(ProgramError::Custom(22)); // not the authorized writer
    }
    let next = u64::from_le_bytes(d[O_NEXT..O_NEXT + 8].try_into().unwrap_or([0u8; 8]));
    if next >= (1u64 << DEPTH) {
        return Err(ProgramError::Custom(23)); // tree full
    }

    // incremental insert at index `next`
    let mut current = leaf;
    let mut idx = next;
    for i in 0..DEPTH {
        let (left, right) = if idx & 1 == 0 {
            let z = rd32(&d, O_ZEROS + i * 32);
            d[O_FILLED + i * 32..O_FILLED + i * 32 + 32].copy_from_slice(&current);
            (current, z)
        } else {
            (rd32(&d, O_FILLED + i * 32), current)
        };
        current = poseidon2(&left, &right)?;
        idx >>= 1;
    }

    let ridx = ((d[O_RIDX] as usize) + 1) % ROOT_HISTORY;
    d[O_RIDX] = ridx as u8;
    d[O_ROOTS + ridx * 32..O_ROOTS + ridx * 32 + 32].copy_from_slice(&current);
    d[O_NEXT..O_NEXT + 8].copy_from_slice(&(next + 1).to_le_bytes());

    let leaf_hex = u64::from_be_bytes(current[24..32].try_into().unwrap_or([0u8; 8]));
    msg!("receipt_commitment_tree: inserted leaf #{} root..{:x}", next, leaf_hex);
    Ok(())
}
