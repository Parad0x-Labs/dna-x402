//! dark_registrar — ANONYMOUS .null name ownership.
//!
//! A name's owner is a COMMITMENT, never a pubkey: `owner_commitment = Poseidon(secret, name)`.
//! The per-name PDA stores only the commitment + a content pointer + a sequence number. Managing
//! the site (`set_record`) and selling it (`transfer`) are authorized by a Groth16 proof of
//! knowledge of `secret` — so the wallet that signs/pays (a relayer) is never linked to the owner.
//!
//! Anti-replay: each authorized action binds an `action_hash = Poseidon(domain, payload, seq)` as a
//! proof public input; the program recomputes it from the requested action + the name's current
//! `seq` and rejects a mismatch. A captured proof can't be reused for a different action or after
//! `seq` advances; forging one needs the secret. (See DARK_REGISTRAR_DESIGN.md. Unlinkability also
//! requires a relayer fee-payer + shielded-pool payment — those live off this program.)
//!
//! Instructions:
//!   0x00 Register     accounts [payer(s,w), name_pda(w), system]   data: name[32] commitment[32]
//!   0x01 SetRecord    accounts [name_pda(w)]   data: name[32] proof[256] commitment[32] content_ptr[32]
//!   0x02 Transfer     accounts [name_pda(w)]   data: name[32] proof[256] commitment[32] new_commitment[32]

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

use dark_groth16_core::{
    g1_from_bytes, g2_from_bytes, groth16_verify,
    registrar_vk::{registrar_vk, NR_PUBLIC_INPUTS},
    Groth16Proof,
};

entrypoint!(process_instruction);

const NAME_SEED: &[u8] = b"null_name";
// NameRecord layout: commitment[32] | content_ptr[32] | seq u64 le[8] | bump[1] = 73
const O_COMMIT: usize = 0;
const O_CONTENT: usize = 32;
const O_SEQ: usize = 64;
const O_BUMP: usize = 72;
const REC_LEN: usize = 73;

const DOMAIN_SETRECORD: u64 = 1;
const DOMAIN_TRANSFER: u64 = 2;
const DOMAIN_REGISTER: u64 = 3;

fn u64_to_be32(x: u64) -> [u8; 32] {
    let mut o = [0u8; 32];
    o[24..32].copy_from_slice(&x.to_be_bytes());
    o
}
fn rd32(d: &[u8], o: usize) -> [u8; 32] {
    d[o..o + 32].try_into().unwrap_or([0u8; 32])
}
/// action_hash = Poseidon(domain, payload, seq) — matches the off-chain prover.
fn action_hash(domain: u64, payload: &[u8; 32], seq: u64) -> Result<[u8; 32], ProgramError> {
    hashv(Parameters::Bn254X5, Endianness::BigEndian,
        &[u64_to_be32(domain).as_slice(), payload.as_slice(), u64_to_be32(seq).as_slice()])
        .map(|h| h.to_bytes())
        .map_err(|_| ProgramError::Custom(20))
}

fn verify_ownership(name: &[u8; 32], commitment: &[u8; 32], action: &[u8; 32], proof_bytes: &[u8; 256]) -> bool {
    let vk = registrar_vk();
    // Fail closed on a non-trustless VK (devnet ships single-party; --features devnet skips this).
    #[cfg(not(feature = "devnet"))]
    if !vk.mainnet_ready {
        return false;
    }
    let public_inputs: [[u8; 32]; NR_PUBLIC_INPUTS] = [*name, *commitment, *action];
    let a: [u8; 64] = proof_bytes[0..64].try_into().unwrap_or([0u8; 64]);
    let b: [u8; 128] = proof_bytes[64..192].try_into().unwrap_or([0u8; 128]);
    let c: [u8; 64] = proof_bytes[192..256].try_into().unwrap_or([0u8; 64]);
    let proof = Groth16Proof { a: g1_from_bytes(&a), b: g2_from_bytes(&b), c: g1_from_bytes(&c) };
    matches!(groth16_verify(&vk, &proof, &public_inputs), Ok(true))
}

fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (tag, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    match tag {
        0x00 => register(program_id, accounts, rest),
        0x01 => set_record(program_id, accounts, rest),
        0x02 => transfer(program_id, accounts, rest),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// Create a name owned by a commitment. Permissionless (anyone can register an unclaimed name);
/// the commitment hides the owner. Pays rent from `payer` (a relayer / privately-funded signer).
fn register(program_id: &Pubkey, accounts: &[AccountInfo], rest: &[u8]) -> ProgramResult {
    // name[32] commitment[32] proof[256] = 320
    if rest.len() < 320 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let name: [u8; 32] = rest[0..32].try_into().unwrap();
    let commitment: [u8; 32] = rest[32..64].try_into().unwrap();
    let proof: [u8; 256] = rest[64..320].try_into().unwrap();
    // Require proof of knowledge of the secret behind the commitment (audit HIGH: otherwise a
    // griefer registers a victim's name with a junk/unowned commitment → permanently bricked &
    // unrecoverable). groth16_verify also rejects commitment==0 and non-canonical name/commitment.
    let action = action_hash(DOMAIN_REGISTER, &commitment, 0)?;
    if !verify_ownership(&name, &commitment, &action, &proof) {
        return Err(ProgramError::Custom(1)); // ownership proof invalid → name not claimable by junk
    }

    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let name_pda = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;
    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (pda, bump) = Pubkey::find_program_address(&[NAME_SEED, &name], program_id);
    if name_pda.key != &pda {
        return Err(ProgramError::InvalidArgument);
    }
    if !name_pda.data_is_empty() {
        return Err(ProgramError::Custom(21)); // name already registered
    }
    if *system_program.key != solana_program::system_program::id() {
        return Err(ProgramError::IncorrectProgramId);
    }
    let rent = Rent::get()?.minimum_balance(REC_LEN);
    invoke_signed(
        &system_instruction::create_account(payer.key, &pda, rent, REC_LEN as u64, program_id),
        &[payer.clone(), name_pda.clone(), system_program.clone()],
        &[&[NAME_SEED, &name, &[bump]]],
    )?;
    let mut d = name_pda.try_borrow_mut_data()?;
    d[O_COMMIT..O_COMMIT + 32].copy_from_slice(&commitment);
    // content_ptr zeroed; seq = 0
    d[O_BUMP] = bump;
    msg!("dark_registrar: registered (owner = commitment)");
    Ok(())
}

/// Update the name's content pointer (site), authorized by an ownership proof. No signer/owner
/// check — the ZK proof is the authorization, so the tx fee-payer (a relayer) is unlinkable.
fn set_record(program_id: &Pubkey, accounts: &[AccountInfo], rest: &[u8]) -> ProgramResult {
    // name[32] proof[256] commitment[32] content_ptr[32] = 352
    if rest.len() < 352 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let name: [u8; 32] = rest[0..32].try_into().unwrap();
    let proof: [u8; 256] = rest[32..288].try_into().unwrap();
    let commitment: [u8; 32] = rest[288..320].try_into().unwrap();
    let content_ptr: [u8; 32] = rest[320..352].try_into().unwrap();

    let iter = &mut accounts.iter();
    let name_pda = next_account_info(iter)?;
    if name_pda.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let (pda, _b) = Pubkey::find_program_address(&[NAME_SEED, &name], program_id);
    if name_pda.key != &pda {
        return Err(ProgramError::InvalidArgument);
    }
    let mut d = name_pda.try_borrow_mut_data()?;
    if d.len() != REC_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    // The proof must be against the CURRENT stored commitment.
    if rd32(&d, O_COMMIT) != commitment {
        return Err(ProgramError::InvalidArgument);
    }
    let seq = u64::from_le_bytes(d[O_SEQ..O_SEQ + 8].try_into().unwrap_or([0u8; 8]));
    let action = action_hash(DOMAIN_SETRECORD, &content_ptr, seq)?;
    if !verify_ownership(&name, &commitment, &action, &proof) {
        return Err(ProgramError::Custom(1)); // ownership proof invalid
    }
    d[O_CONTENT..O_CONTENT + 32].copy_from_slice(&content_ptr);
    d[O_SEQ..O_SEQ + 8].copy_from_slice(&seq.checked_add(1).ok_or(ProgramError::Custom(22))?.to_le_bytes());
    msg!("dark_registrar: set_record (ZK-authorized)");
    Ok(())
}

/// Re-commit the name to a new owner commitment, authorized by the current owner's proof.
/// The old proof can't be replayed (binds new_commitment + seq); after transfer, proofs against
/// the old commitment no longer verify (stored commitment changed).
fn transfer(program_id: &Pubkey, accounts: &[AccountInfo], rest: &[u8]) -> ProgramResult {
    // name[32] proof[256] commitment[32] new_commitment[32] = 352
    if rest.len() < 352 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let name: [u8; 32] = rest[0..32].try_into().unwrap();
    let proof: [u8; 256] = rest[32..288].try_into().unwrap();
    let commitment: [u8; 32] = rest[288..320].try_into().unwrap();
    let new_commitment: [u8; 32] = rest[320..352].try_into().unwrap();

    let iter = &mut accounts.iter();
    let name_pda = next_account_info(iter)?;
    if name_pda.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let (pda, _b) = Pubkey::find_program_address(&[NAME_SEED, &name], program_id);
    if name_pda.key != &pda {
        return Err(ProgramError::InvalidArgument);
    }
    let mut d = name_pda.try_borrow_mut_data()?;
    if d.len() != REC_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    if rd32(&d, O_COMMIT) != commitment {
        return Err(ProgramError::InvalidArgument);
    }
    let seq = u64::from_le_bytes(d[O_SEQ..O_SEQ + 8].try_into().unwrap_or([0u8; 8]));
    let action = action_hash(DOMAIN_TRANSFER, &new_commitment, seq)?;
    if !verify_ownership(&name, &commitment, &action, &proof) {
        return Err(ProgramError::Custom(1));
    }
    d[O_COMMIT..O_COMMIT + 32].copy_from_slice(&new_commitment);
    d[O_SEQ..O_SEQ + 8].copy_from_slice(&seq.checked_add(1).ok_or(ProgramError::Custom(22))?.to_le_bytes());
    msg!("dark_registrar: transfer (re-committed to new owner)");
    Ok(())
}
