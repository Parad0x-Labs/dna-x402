use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    hash::hashv,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    system_program,
    sysvar::Sysvar,
};

use crate::{
    error::ReceiptAnchorError,
    instruction::{AnchorV1Batch, AnchorV1Single, ReceiptAnchorInstruction},
    state::{AnchorBucket, ANCHOR_BUCKET_ACCOUNT_LEN, BUCKET_STATE_VERSION},
};

const BUCKET_SEED_PREFIX: &[u8] = b"bucket";
const BUCKET_WINDOW_SECONDS: u64 = 3600;

fn bucket_id_from_unix(unix_ts: i64) -> u64 {
    if unix_ts <= 0 {
        return 0;
    }
    (unix_ts as u64) / BUCKET_WINDOW_SECONDS
}

fn derive_bucket_address(program_id: &Pubkey, bucket_id: u64) -> (Pubkey, u8, [u8; 8]) {
    let bucket_id_le = bucket_id.to_le_bytes();
    let seeds = [BUCKET_SEED_PREFIX, bucket_id_le.as_ref()];
    let (pda, bump) = Pubkey::find_program_address(&seeds, program_id);
    (pda, bump, bucket_id_le)
}

fn ensure_bucket_account<'a>(
    payer: &AccountInfo<'a>,
    bucket: &AccountInfo<'a>,
    maybe_system_program: Option<&AccountInfo<'a>>,
    program_id: &Pubkey,
    bucket_id: u64,
) -> Result<u8, ProgramError> {
    let (expected_bucket, bump, bucket_id_le) = derive_bucket_address(program_id, bucket_id);
    if expected_bucket != *bucket.key {
        return Err(ReceiptAnchorError::InvalidBucketPda.into());
    }

    let should_create = bucket.owner != program_id || bucket.data_len() < ANCHOR_BUCKET_ACCOUNT_LEN;
    if !should_create {
        return Ok(bump);
    }

    let system_program_info = maybe_system_program.ok_or(ReceiptAnchorError::MissingSystemProgram)?;
    if *system_program_info.key != system_program::id() {
        return Err(ReceiptAnchorError::MissingSystemProgram.into());
    }

    let rent = Rent::get()?;
    let required_lamports = rent.minimum_balance(ANCHOR_BUCKET_ACCOUNT_LEN);

    let create_ix = system_instruction::create_account(
        payer.key,
        bucket.key,
        required_lamports,
        ANCHOR_BUCKET_ACCOUNT_LEN as u64,
        program_id,
    );

    invoke_signed(
        &create_ix,
        &[payer.clone(), bucket.clone(), system_program_info.clone()],
        &[&[BUCKET_SEED_PREFIX, bucket_id_le.as_ref(), &[bump]]],
    )?;

    Ok(bump)
}

fn load_or_initialize_bucket(
    bucket: &AccountInfo,
    expected_bucket_id: u64,
    bump: u8,
    now_unix_ts: i64,
) -> Result<AnchorBucket, ProgramError> {
    let data = bucket.try_borrow_data()?;
    if data.len() < ANCHOR_BUCKET_ACCOUNT_LEN {
        return Err(ProgramError::InvalidAccountData);
    }

    if data[0] == 0 {
        return Ok(AnchorBucket {
            version: BUCKET_STATE_VERSION,
            bump,
            bucket_id: expected_bucket_id,
            count: 0,
            root: [0u8; 32],
            updated_at: now_unix_ts,
        });
    }

    let loaded = AnchorBucket::unpack_from_slice(&data)?;
    if loaded.bucket_id != expected_bucket_id {
        return Err(ReceiptAnchorError::BucketStateMismatch.into());
    }

    Ok(loaded)
}

fn hash_accumulate(root: [u8; 32], anchor: &[u8; 32]) -> [u8; 32] {
    hashv(&[&root, anchor]).to_bytes()
}

fn apply_single(bucket: &mut AnchorBucket, single: &AnchorV1Single) -> Result<(), ProgramError> {
    bucket.root = hash_accumulate(bucket.root, &single.anchor32);
    bucket.count = bucket
        .count
        .checked_add(1)
        .ok_or(ReceiptAnchorError::ArithmeticOverflow)?;
    Ok(())
}

fn apply_batch(bucket: &mut AnchorBucket, batch: &AnchorV1Batch) -> Result<(), ProgramError> {
    for anchor in &batch.anchors {
        bucket.root = hash_accumulate(bucket.root, anchor);
    }

    bucket.count = bucket
        .count
        .checked_add(batch.count as u32)
        .ok_or(ReceiptAnchorError::ArithmeticOverflow)?;

    Ok(())
}

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], instruction_data: &[u8]) -> ProgramResult {
    let instruction = ReceiptAnchorInstruction::unpack(instruction_data)?;
    let now_unix = Clock::get()?.unix_timestamp;

    let accounts_iter = &mut accounts.iter();
    let payer = next_account_info(accounts_iter)?;
    let bucket = next_account_info(accounts_iter)?;
    let maybe_system_program = accounts_iter.next();

    if !payer.is_signer {
        return Err(ReceiptAnchorError::MissingPayerSignature.into());
    }
    if !payer.is_writable {
        return Err(ReceiptAnchorError::MissingPayerSignature.into());
    }
    if !bucket.is_writable {
        return Err(ReceiptAnchorError::InvalidBucketAccount.into());
    }

    let bucket_id = match &instruction {
        ReceiptAnchorInstruction::AnchorSingle(single) => {
            single.bucket_id.unwrap_or_else(|| bucket_id_from_unix(now_unix))
        }
        ReceiptAnchorInstruction::AnchorBatch(_) => bucket_id_from_unix(now_unix),
    };

    let bump = ensure_bucket_account(payer, bucket, maybe_system_program, program_id, bucket_id)?;
    let mut bucket_state = load_or_initialize_bucket(bucket, bucket_id, bump, now_unix)?;

    match &instruction {
        ReceiptAnchorInstruction::AnchorSingle(single) => apply_single(&mut bucket_state, single)?,
        ReceiptAnchorInstruction::AnchorBatch(batch) => apply_batch(&mut bucket_state, batch)?,
    }

    bucket_state.updated_at = now_unix;

    {
        let mut data = bucket.try_borrow_mut_data()?;
        AnchorBucket::pack_into_slice(&bucket_state, &mut data);
    }

    msg!("receipt_anchor ok bucket={} count={}", bucket.key, bucket_state.count);
    Ok(())
}
