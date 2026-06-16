//! receipt_commitment_tree — incremental Poseidon Merkle tree of x402 receipt commitments.
//!
//! SERVERLESS receipt rail. A leaf
//!   leaf = Poseidon(agent_commitment, amount, ts, counterparty, nonce)
//! is inserted by `settle_and_record` (0x02), which performs the REAL on-chain payment that
//! backs the receipt in the SAME instruction. There is NO authorized writer / settlement
//! signer: anyone can record a receipt, but only by actually paying `amount` to the recipient.
//! This removes the off-chain trust + liveness dependency (the old pinned `O_AUTH`/
//! `CANONICAL_AUTHORITY`) while keeping receipts unforgeable — a leaf can only enter the tree
//! as a side-effect of a settled payment, not by fiat. (Residual: self-payment can farm
//! reputation at the cost of fees/capital — harden later with distinct-counterparty / burn /
//! stake; that is a threat-model knob, not a server dependency.)
//!
//! The tree keeps only the frontier + a rolling root history on-chain (NOT the leaves), so
//! cost is constant. The root equals the one dark_reputation_gate verifies track-record proofs
//! against (Poseidon Bn254X5 == circomlib == poseidon-lite). Provers reconstruct Merkle paths
//! from the public on-chain insert order (the `ts` is logged; all other fields are known to the
//! receipt owner) — class-A client work, no indexer required.
//!
//! Instructions:
//!   0x00 Initialize         accounts: [payer(s,w), tree_pda(w), system]      data: tree_id[8]
//!   0x02 SettleAndRecord    accounts: [payer(s,w), recipient(w), tree_pda(w), system]
//!                           data: tree_id[8] agent_commitment[32] amount_le[8] counterparty[32] nonce[32]

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    poseidon::{hashv, Endianness, Parameters},
    program::{invoke, invoke_signed},
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

// Account layout (UNCHANGED — dark_reputation_gate reads O_ROOTS at 682). O_AUTH is retained
// for layout compatibility but is now vestigial (written as zeros; no longer gates writes).
const O_AUTH: usize = 0; // [32] (vestigial — was the authorized writer)
const O_NEXT: usize = 32; // [8]  next leaf index (u64 le)
const O_RIDX: usize = 40; // [1]  current root-history index
const O_BUMP: usize = 41; // [1]
const O_FILLED: usize = 42; // [DEPTH*32] frontier
const O_ZEROS: usize = O_FILLED + DEPTH * 32; // [DEPTH*32] empty-subtree hashes
const O_ROOTS: usize = O_ZEROS + DEPTH * 32; // [ROOT_HISTORY*32] rolling roots  (== 682)
const TREE_LEN: usize = O_ROOTS + ROOT_HISTORY * 32; // == 938

fn poseidon2(a: &[u8; 32], b: &[u8; 32]) -> Result<[u8; 32], ProgramError> {
    hashv(Parameters::Bn254X5, Endianness::BigEndian, &[a.as_slice(), b.as_slice()])
        .map(|h| h.to_bytes())
        .map_err(|_| ProgramError::Custom(20))
}

/// leaf = Poseidon(agent_commitment, amount, ts, counterparty, nonce) — matches track_record.circom.
fn poseidon5(a: &[u8; 32], b: &[u8; 32], c: &[u8; 32], d: &[u8; 32], e: &[u8; 32]) -> Result<[u8; 32], ProgramError> {
    hashv(Parameters::Bn254X5, Endianness::BigEndian,
        &[a.as_slice(), b.as_slice(), c.as_slice(), d.as_slice(), e.as_slice()])
        .map(|h| h.to_bytes())
        .map_err(|_| ProgramError::Custom(20))
}

fn rd32(d: &[u8], o: usize) -> [u8; 32] {
    d[o..o + 32].try_into().unwrap_or([0u8; 32])
}

/// Encode a u64 as a big-endian 32-byte BN254 field element (matches the circuit's integer inputs).
fn u64_to_be32(x: u64) -> [u8; 32] {
    let mut o = [0u8; 32];
    o[24..32].copy_from_slice(&x.to_be_bytes());
    o
}

fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (tag, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    match tag {
        0x00 => initialize(program_id, accounts, rest),
        0x02 => settle_and_record(program_id, accounts, rest),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// Permissionless init: anyone may create a tree (canonical or not). Correctness no longer
/// depends on WHO inits — every write goes through `settle_and_record`, which requires a real
/// payment, so an attacker who wins the init race still cannot insert fabricated receipts.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], rest: &[u8]) -> ProgramResult {
    if rest.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let tree_id: [u8; 8] = rest[0..8].try_into().unwrap();

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
    // O_AUTH vestigial → zeros.
    d[O_BUMP] = bump;
    let mut zero = [0u8; 32];
    for i in 0..DEPTH {
        d[O_ZEROS + i * 32..O_ZEROS + i * 32 + 32].copy_from_slice(&zero);
        d[O_FILLED + i * 32..O_FILLED + i * 32 + 32].copy_from_slice(&zero);
        zero = poseidon2(&zero, &zero)?;
    }
    // initial root = zeros[DEPTH] = root of the empty tree.
    d[O_ROOTS..O_ROOTS + 32].copy_from_slice(&zero);
    msg!("receipt_commitment_tree: initialized depth={} (serverless: payment-gated writes)", DEPTH);
    Ok(())
}

/// Serverless, permissionless receipt write. Performs the REAL payment (payer -> recipient of
/// `amount`) that backs the receipt, then inserts leaf = Poseidon(agent_commitment, amount, ts,
/// counterparty, nonce). No authorized-writer check — the payment IS the authorization.
fn settle_and_record(program_id: &Pubkey, accounts: &[AccountInfo], rest: &[u8]) -> ProgramResult {
    // tree_id[8] + agent_commitment[32] + amount_le[8] + counterparty[32] + nonce[32] = 112
    if rest.len() < 112 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let tree_id: [u8; 8] = rest[0..8].try_into().unwrap();
    let agent_commitment: [u8; 32] = rest[8..40].try_into().unwrap();
    let amount = u64::from_le_bytes(rest[40..48].try_into().unwrap());
    let counterparty: [u8; 32] = rest[48..80].try_into().unwrap();
    let nonce: [u8; 32] = rest[80..112].try_into().unwrap();

    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let recipient = next_account_info(iter)?;
    let tree = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if amount == 0 {
        return Err(ProgramError::InvalidInstructionData); // a receipt must reflect a real payment
    }
    let (pda, _bump) = Pubkey::find_program_address(&[TREE_SEED, &tree_id], program_id);
    if tree.key != &pda {
        return Err(ProgramError::InvalidArgument);
    }
    if *system_program.key != solana_program::system_program::id() {
        return Err(ProgramError::IncorrectProgramId);
    }

    // The settlement: a real on-chain payment. This is what makes the receipt unforgeable
    // without any off-chain authority — you cannot record a receipt without actually paying.
    invoke(
        &system_instruction::transfer(payer.key, recipient.key, amount),
        &[payer.clone(), recipient.clone(), system_program.clone()],
    )?;

    let ts = Clock::get()?.unix_timestamp.max(0) as u64;
    let leaf = poseidon5(&agent_commitment, &u64_to_be32(amount), &u64_to_be32(ts), &counterparty, &nonce)?;

    let mut d = tree.try_borrow_mut_data()?;
    if d.len() != TREE_LEN {
        return Err(ProgramError::InvalidAccountData);
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

    // Log enough for a prover to reconstruct the leaf: ts is the only on-chain-determined field;
    // amount + leaf_index let owners locate their receipts. (agent_commitment/counterparty/nonce
    // are known to the parties.)
    msg!("receipt: idx={} amount={} ts={}", next, amount, ts);
    Ok(())
}
