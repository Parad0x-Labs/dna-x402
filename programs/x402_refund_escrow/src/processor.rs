use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    ed25519_program,
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::{instructions, Sysvar},
};

use crate::{
    ed25519::extract_pubkey_and_message,
    error::EscrowError,
    instruction::EscrowInstruction,
    receipt::{receipts_conflict, SettleReceipt, STATUS_SUCCESS},
    state::{status, Escrow, ESCROW_ACCOUNT_LEN, ESCROW_SEED_PREFIX, ESCROW_STATE_VERSION},
};

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match EscrowInstruction::unpack(data)? {
        EscrowInstruction::OpenEscrow {
            seller,
            amount,
            payment_commitment,
            deadline,
            dispute_window,
        } => open_escrow(
            program_id,
            accounts,
            seller,
            amount,
            payment_commitment,
            deadline,
            dispute_window,
        ),
        EscrowInstruction::PostBond { amount } => post_bond(program_id, accounts, amount),
        EscrowInstruction::SettleSuccess { receipt_ix_index } => {
            settle_success(program_id, accounts, receipt_ix_index)
        }
        EscrowInstruction::RefundOnTimeout => refund_on_timeout(program_id, accounts),
        EscrowInstruction::ProveEquivocation {
            ix_index_a,
            ix_index_b,
        } => prove_equivocation(program_id, accounts, ix_index_a, ix_index_b),
        EscrowInstruction::CloseAfterDispute => close_after_dispute(program_id, accounts),
    }
}

fn derive(program_id: &Pubkey, payment_commitment: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ESCROW_SEED_PREFIX, payment_commitment.as_ref()], program_id)
}

/// Load + validate the escrow account: owned by us, at the right PDA for its
/// own stored commitment. Returns the parsed state.
fn load_escrow(program_id: &Pubkey, escrow: &AccountInfo) -> Result<Escrow, ProgramError> {
    if escrow.owner != program_id {
        return Err(EscrowError::InvalidEscrowAccount.into());
    }
    let state = Escrow::unpack_from_slice(&escrow.try_borrow_data()?)?;
    let expected = Pubkey::create_program_address(
        &[
            ESCROW_SEED_PREFIX,
            state.payment_commitment.as_ref(),
            &[state.bump],
        ],
        program_id,
    )
    .map_err(|_| EscrowError::InvalidEscrowPda)?;
    if expected != *escrow.key {
        return Err(EscrowError::InvalidEscrowPda.into());
    }
    Ok(state)
}

fn write_escrow(escrow: &AccountInfo, state: &Escrow) -> ProgramResult {
    let mut data = escrow.try_borrow_mut_data()?;
    state.pack_into_slice(&mut data);
    Ok(())
}

/// Move `amount` lamports out of the program-owned PDA into `dest`, keeping the
/// PDA rent-exempt (escrowed funds always sit *on top* of the rent minimum, so
/// this never strands the account below rent).
fn pay_out(escrow: &AccountInfo, dest: &AccountInfo, amount: u64) -> ProgramResult {
    if amount == 0 {
        return Ok(());
    }
    let rent_min = Rent::get()?.minimum_balance(ESCROW_ACCOUNT_LEN);
    let cur = escrow.lamports();
    let remaining = cur
        .checked_sub(amount)
        .ok_or(EscrowError::InsufficientBalance)?;
    if remaining < rent_min {
        return Err(EscrowError::InsufficientBalance.into());
    }
    **escrow.try_borrow_mut_lamports()? = remaining;
    **dest.try_borrow_mut_lamports()? = dest
        .lamports()
        .checked_add(amount)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    Ok(())
}

/// Drain every remaining lamport (the rent deposit + any residue) to `dest` and
/// zero the data so the runtime reclaims the account. Called on the *final*
/// terminal action so the buyer's rent is returned rather than stranded.
fn close_escrow(escrow: &AccountInfo, dest: &AccountInfo) -> ProgramResult {
    let residual = escrow.lamports();
    **escrow.try_borrow_mut_lamports()? = 0;
    **dest.try_borrow_mut_lamports()? = dest
        .lamports()
        .checked_add(residual)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    let mut data = escrow.try_borrow_mut_data()?;
    for b in data.iter_mut() {
        *b = 0;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn open_escrow(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    seller: [u8; 32],
    amount: u64,
    payment_commitment: [u8; 32],
    deadline: i64,
    dispute_window: i64,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let buyer = next_account_info(iter)?;
    let escrow = next_account_info(iter)?;
    let system_prog = next_account_info(iter)?;

    if !buyer.is_signer {
        return Err(EscrowError::MissingSignature.into());
    }
    if amount == 0 {
        return Err(EscrowError::ZeroAmount.into());
    }
    if *system_prog.key != system_program::id() {
        return Err(EscrowError::MissingSystemProgram.into());
    }
    let now = Clock::get()?.unix_timestamp;
    if deadline <= now || dispute_window < 0 {
        return Err(EscrowError::DeadlinePassed.into());
    }

    let (expected, bump) = derive(program_id, &payment_commitment);
    if expected != *escrow.key {
        return Err(EscrowError::InvalidEscrowPda.into());
    }
    if !escrow.data_is_empty() {
        return Err(EscrowError::InvalidEscrowAccount.into());
    }

    let rent_min = Rent::get()?.minimum_balance(ESCROW_ACCOUNT_LEN);
    let fund = rent_min
        .checked_add(amount)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    invoke_signed(
        &system_instruction::create_account(
            buyer.key,
            escrow.key,
            fund,
            ESCROW_ACCOUNT_LEN as u64,
            program_id,
        ),
        &[buyer.clone(), escrow.clone(), system_prog.clone()],
        &[&[ESCROW_SEED_PREFIX, payment_commitment.as_ref(), &[bump]]],
    )?;

    let state = Escrow {
        version: ESCROW_STATE_VERSION,
        bump,
        status: status::OPEN,
        buyer: buyer.key.to_bytes(),
        seller,
        amount,
        bond: 0,
        payment_commitment,
        deadline,
        // maturity = deadline + window. The bond stays slashable until here and
        // is only reclaimable by the seller after it.
        dispute_deadline: deadline
            .checked_add(dispute_window)
            .ok_or(EscrowError::ArithmeticOverflow)?,
        response_hash: [0u8; 32],
        created_at: now,
        dispute_window,
    };
    write_escrow(escrow, &state)?;
    msg!("x402-escrow: OpenEscrow");
    Ok(())
}

fn post_bond(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    let iter = &mut accounts.iter();
    let seller = next_account_info(iter)?;
    let escrow = next_account_info(iter)?;
    let system_prog = next_account_info(iter)?;

    if !seller.is_signer {
        return Err(EscrowError::MissingSignature.into());
    }
    if amount == 0 {
        return Err(EscrowError::ZeroAmount.into());
    }
    if *system_prog.key != system_program::id() {
        return Err(EscrowError::MissingSystemProgram.into());
    }
    let mut state = load_escrow(program_id, escrow)?;
    if state.status != status::OPEN {
        return Err(EscrowError::NotOpen.into());
    }
    if seller.key.to_bytes() != state.seller {
        return Err(EscrowError::NotSeller.into());
    }
    // seller (system-owned) → escrow PDA: a plain transfer, seller signs.
    solana_program::program::invoke(
        &system_instruction::transfer(seller.key, escrow.key, amount),
        &[seller.clone(), escrow.clone(), system_prog.clone()],
    )?;
    state.bond = state
        .bond
        .checked_add(amount)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    write_escrow(escrow, &state)?;
    msg!("x402-escrow: PostBond");
    Ok(())
}

fn settle_success(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    receipt_ix_index: u8,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let seller = next_account_info(iter)?;
    let escrow = next_account_info(iter)?;
    let seller_wallet = next_account_info(iter)?;
    let ix_sysvar = next_account_info(iter)?;

    if !seller.is_signer {
        return Err(EscrowError::MissingSignature.into());
    }
    let mut state = load_escrow(program_id, escrow)?;
    if state.status != status::OPEN {
        return Err(EscrowError::NotOpen.into());
    }
    if seller.key.to_bytes() != state.seller || seller_wallet.key.to_bytes() != state.seller {
        return Err(EscrowError::NotSeller.into());
    }
    let now = Clock::get()?.unix_timestamp;
    if now > state.deadline {
        return Err(EscrowError::DeadlinePassed.into());
    }

    let receipt = read_receipt(ix_sysvar, receipt_ix_index, &state.seller)?;
    if receipt.payment_commitment != state.payment_commitment
        || receipt.deadline != state.deadline
        || receipt.status != STATUS_SUCCESS
    {
        return Err(EscrowError::ReceiptMismatch.into());
    }

    pay_out(escrow, seller_wallet, state.amount)?;
    state.status = status::SETTLED_SUCCESS;
    state.response_hash = receipt.response_hash;
    // dispute_deadline (maturity) was fixed at open; the bond stays escrowed and
    // slashable until then, then the seller reclaims it via CloseAfterDispute.
    write_escrow(escrow, &state)?;
    msg!("x402-escrow: SettleSuccess");
    Ok(())
}

fn refund_on_timeout(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let escrow = next_account_info(iter)?;
    let buyer_wallet = next_account_info(iter)?;

    let mut state = load_escrow(program_id, escrow)?;
    if state.status != status::OPEN {
        return Err(EscrowError::NotOpen.into());
    }
    if buyer_wallet.key.to_bytes() != state.buyer {
        return Err(EscrowError::NotBuyer.into());
    }
    let now = Clock::get()?.unix_timestamp;
    if now <= state.deadline {
        return Err(EscrowError::DeadlineNotReached.into());
    }

    // Refund only the payment, only to the buyer. The seller's bond deliberately
    // stays escrowed and slashable until maturity, so a seller who equivocated
    // can't dodge the slash by riding out the deadline (it used to be returned
    // here). The seller reclaims it after maturity via CloseAfterDispute.
    pay_out(escrow, buyer_wallet, state.amount)?;
    state.status = status::REFUNDED;
    write_escrow(escrow, &state)?;
    msg!("x402-escrow: RefundOnTimeout");
    Ok(())
}

fn prove_equivocation(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    ix_index_a: u8,
    ix_index_b: u8,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let escrow = next_account_info(iter)?;
    let buyer_wallet = next_account_info(iter)?;
    let ix_sysvar = next_account_info(iter)?;

    let state = load_escrow(program_id, escrow)?;
    // Slashable as long as any bond remains — a seller can't dodge fraud by
    // waiting out a deadline. Once the seller has reclaimed the bond (bond == 0)
    // there is nothing left to slash.
    if state.bond == 0 {
        return Err(EscrowError::NotOpen.into());
    }
    if buyer_wallet.key.to_bytes() != state.buyer {
        return Err(EscrowError::NotBuyer.into());
    }

    let ra = read_receipt(ix_sysvar, ix_index_a, &state.seller)?;
    let rb = read_receipt(ix_sysvar, ix_index_b, &state.seller)?;
    if ra.payment_commitment != state.payment_commitment
        || rb.payment_commitment != state.payment_commitment
        || ra.deadline != state.deadline
        || rb.deadline != state.deadline
    {
        return Err(EscrowError::ReceiptMismatch.into());
    }
    if !receipts_conflict(&ra, &rb) {
        return Err(EscrowError::NotEquivocation.into());
    }

    // Slash: the seller's bond goes to the buyer. If the payment is still
    // escrowed (never settled), it returns to the buyer too. A payment already
    // paid out on a fraudulent success can't be clawed non-custodially — the
    // bond is the recourse, so it must be sized to matter. Slashing resolves the
    // escrow, so return the rent to the buyer and close the account.
    if state.status == status::OPEN {
        pay_out(escrow, buyer_wallet, state.amount)?;
    }
    pay_out(escrow, buyer_wallet, state.bond)?;
    close_escrow(escrow, buyer_wallet)?;
    msg!("x402-escrow: ProveEquivocation -> Slashed + closed");
    Ok(())
}

fn close_after_dispute(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let escrow = next_account_info(iter)?;
    let seller_wallet = next_account_info(iter)?;
    let buyer_wallet = next_account_info(iter)?;

    let state = load_escrow(program_id, escrow)?;
    // The payment must already be resolved (settled to the seller or refunded to
    // the buyer) — never release a bond out of a still-Open escrow.
    if state.status == status::OPEN {
        return Err(EscrowError::NotSettled.into());
    }
    if seller_wallet.key.to_bytes() != state.seller {
        return Err(EscrowError::NotSeller.into());
    }
    if buyer_wallet.key.to_bytes() != state.buyer {
        return Err(EscrowError::NotBuyer.into());
    }
    // Only after maturity, so the buyer's whole equivocation window has elapsed.
    let now = Clock::get()?.unix_timestamp;
    if now <= state.dispute_deadline {
        return Err(EscrowError::DisputeWindowOpen.into());
    }
    // Return the bond to the (non-equivocating) seller, then return the rent
    // deposit to the buyer and close the account — nothing is stranded.
    pay_out(escrow, seller_wallet, state.bond)?;
    close_escrow(escrow, buyer_wallet)?;
    msg!("x402-escrow: CloseAfterDispute -> bond to seller, rent to buyer, closed");
    Ok(())
}

/// Load the ed25519 precompile instruction at `index` and recover the receipt
/// it verified, requiring the signer to be `expected_signer`.
fn read_receipt(
    ix_sysvar: &AccountInfo,
    index: u8,
    expected_signer: &[u8; 32],
) -> Result<SettleReceipt, ProgramError> {
    if *ix_sysvar.key != instructions::id() {
        return Err(EscrowError::InvalidReceiptSignature.into());
    }
    let ix = instructions::load_instruction_at_checked(index as usize, ix_sysvar)?;
    if ix.program_id != ed25519_program::id() {
        return Err(EscrowError::InvalidReceiptSignature.into());
    }
    let (pubkey, message) = extract_pubkey_and_message(&ix.data, 0)?;
    if &pubkey != expected_signer {
        return Err(EscrowError::InvalidReceiptSignature.into());
    }
    Ok(SettleReceipt::decode(&message)?)
}
