//! Instruction handlers.
//!
//! Money model: every ledger (one per mint) has one vault. All balances
//! inside the program are ledger entries: escrow balances, channel balances,
//! two-phase batch holds and payee balances. `Ledger::liabilities` is their
//! sum. Instructions that move tokens in or out of the vault update
//! `liabilities` and check `vault holdings >= liabilities` (holdings exclude
//! rent for the SOL ledger). Every other instruction only moves value
//! between entries of one ledger and debits exactly what it credits.

use crate::{
    crypto,
    error::XsError,
    instruction::{tag, WireClose, WireVoucher, CLOSE_WIRE_LEN, NO_BOOK, VOUCHER_WIRE_LEN},
    state::*,
    token,
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::{ProgramResult, MAX_PERMITTED_DATA_INCREASE},
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::{self, Sysvar},
};

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (&t, rest) = data.split_first().ok_or(XsError::InvalidInstruction)?;
    match t {
        tag::INIT_LEDGER => init_ledger(program_id, accounts, rest),
        tag::OPEN_ESCROW => open_escrow(program_id, accounts, rest),
        tag::GROW_ESCROW => grow_escrow(program_id, accounts, rest),
        tag::DEPOSIT => deposit(program_id, accounts, rest),
        tag::REQUEST_EXIT => request_exit(program_id, accounts, rest),
        tag::WITHDRAW_ESCROW => withdraw_escrow(program_id, accounts, rest),
        tag::CLOSE_ESCROW => close_escrow(program_id, accounts, rest),
        tag::CREATE_BOOK => create_book(program_id, accounts, rest),
        tag::REGISTER_PAYEE => register_payee(program_id, accounts, rest),
        tag::WITHDRAW_PAYEE => withdraw_payee(program_id, accounts, rest),
        tag::SETTLE => settle(program_id, accounts, rest),
        tag::OPEN_CHANNEL => open_channel(program_id, accounts, rest),
        tag::CLOSE_CHANNELS => close_channels(program_id, accounts, rest),
        tag::REQUEST_CHANNEL_CLOSE => request_channel_close(program_id, accounts, rest),
        tag::FINALIZE_CHANNEL => finalize_channel(program_id, accounts, rest),
        tag::RECLAIM_CHANNEL => reclaim_channel(program_id, accounts, rest),
        tag::BEGIN_BATCH => begin_batch(program_id, accounts, rest),
        tag::STAGE_CHUNK => stage_chunk(program_id, accounts, rest),
        tag::COMMIT_BATCH => commit_batch(program_id, accounts, rest),
        tag::ABORT_BATCH => abort_batch(program_id, accounts, rest),
        tag::RESOLVE_STAGED => resolve_staged(program_id, accounts, rest),
        tag::CLOSE_BATCH => close_batch(program_id, accounts, rest),
        #[cfg(feature = "cu-probe")]
        0xF0 => cu_probe(rest),
        _ => Err(XsError::InvalidInstruction.into()),
    }
}

/// Measurement hook compiled only with the `cu-probe` feature (test builds):
/// mode 1 hashes a 288-byte input split like a voucher verification
/// (R 32 | A 32 | message 224), mode 0 does everything except the hash.
/// The difference is the in-program SHA-512 cost that the `sha512-syscall`
/// build replaces.
#[cfg(feature = "cu-probe")]
fn cu_probe(d: &[u8]) -> ProgramResult {
    let buf = [0x5au8; 288];
    let h = if d.first() == Some(&1) { crypto::sha512(&[&buf[..32], &buf[32..64], &buf[64..]]) } else { [0u8; 64] };
    if h[0] == 0xff && h[1] == 0xff && h[2] == 0xff {
        solana_program::msg!("probe");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now() -> Result<u64, ProgramError> {
    Ok(Clock::get()?.slot)
}

fn signer(acc: &AccountInfo) -> ProgramResult {
    if !acc.is_signer {
        return Err(XsError::Unauthorized.into());
    }
    Ok(())
}

fn writable(acc: &AccountInfo) -> ProgramResult {
    if !acc.is_writable {
        return Err(XsError::InvalidAccount.into());
    }
    Ok(())
}

fn exact(d: &[u8], len: usize) -> ProgramResult {
    if d.len() != len {
        return Err(XsError::InvalidInstruction.into());
    }
    Ok(())
}

fn add(a: u64, b: u64) -> Result<u64, ProgramError> {
    a.checked_add(b).ok_or_else(|| XsError::MathOverflow.into())
}

fn sub(a: u64, b: u64) -> Result<u64, ProgramError> {
    a.checked_sub(b).ok_or_else(|| XsError::MathOverflow.into())
}

/// Creates a program-derived account. A pre-funded address (lamports sent
/// before creation) is topped up and taken over with allocate + assign, so a
/// transfer to the address cannot block the creation.
fn create_pda<'a>(
    funder: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    space: usize,
    owner: &Pubkey,
    seeds: &[&[u8]],
) -> ProgramResult {
    if *system.key != system_program::id() {
        return Err(XsError::InvalidAccount.into());
    }
    signer(funder)?;
    writable(target)?;
    let rent = Rent::get()?.minimum_balance(space);
    let cur = target.lamports();
    if cur == 0 {
        invoke_signed(
            &system_instruction::create_account(funder.key, target.key, rent, space as u64, owner),
            &[funder.clone(), target.clone(), system.clone()],
            &[seeds],
        )
    } else {
        if *target.owner != system_program::id() || !target.data_is_empty() {
            return Err(XsError::AccountInUse.into());
        }
        if cur < rent {
            invoke(
                &system_instruction::transfer(funder.key, target.key, rent - cur),
                &[funder.clone(), target.clone(), system.clone()],
            )?;
        }
        invoke_signed(&system_instruction::allocate(target.key, space as u64), &[target.clone(), system.clone()], &[seeds])?;
        invoke_signed(&system_instruction::assign(target.key, owner), &[target.clone(), system.clone()], &[seeds])
    }
}

/// Closes a program account: lamports to `dest`, data cleared, owner reset.
fn close_account(acc: &AccountInfo, dest: &AccountInfo) -> ProgramResult {
    writable(acc)?;
    writable(dest)?;
    let l = acc.lamports();
    **dest.try_borrow_mut_lamports()? = add(dest.lamports(), l)?;
    **acc.try_borrow_mut_lamports()? = 0;
    acc.try_borrow_mut_data()?.fill(0);
    acc.realloc(0, false)?;
    acc.assign(&system_program::id());
    Ok(())
}

/// Vault holdings available for liabilities.
fn holdings(ledger: &Ledger, ledger_acc: &AccountInfo, vault: Option<&AccountInfo>) -> Result<u64, ProgramError> {
    if ledger.kind == KIND_SOL {
        let rent = Rent::get()?.minimum_balance(LEDGER_LEN);
        return Ok(ledger_acc.lamports().saturating_sub(rent));
    }
    let v = vault.ok_or(XsError::InvalidAccount)?;
    if v.key.to_bytes() != ledger.vault || v.owner.to_bytes() != ledger.token_program {
        return Err(XsError::InvalidAccount.into());
    }
    let amount = token::account_amount(&v.try_borrow_data()?)?;
    Ok(amount)
}

/// Solvency invariant: vault holdings cover every liability of the ledger.
fn check_solvency(ledger: &Ledger, ledger_acc: &AccountInfo, vault: Option<&AccountInfo>) -> ProgramResult {
    if holdings(ledger, ledger_acc, vault)? < ledger.liabilities {
        return Err(XsError::Insolvent.into());
    }
    Ok(())
}

/// Token accounts of an SPL ledger: (vault, mint, token program), checked
/// against the ledger.
fn spl_accounts<'a, 'b>(
    ledger: &Ledger,
    it: &mut core::slice::Iter<'a, AccountInfo<'b>>,
) -> Result<(&'a AccountInfo<'b>, &'a AccountInfo<'b>, &'a AccountInfo<'b>), ProgramError> {
    let vault = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let tp = next_account_info(it)?;
    if vault.key.to_bytes() != ledger.vault
        || mint.key.to_bytes() != ledger.mint
        || tp.key.to_bytes() != ledger.token_program
        || vault.owner != tp.key
    {
        return Err(XsError::InvalidAccount.into());
    }
    Ok((vault, mint, tp))
}

/// Pays `amount` out of the vault to `dest` (a system account for SOL, a
/// token account of the mint for SPL).
fn pay_out<'a>(
    ledger: &Ledger,
    ledger_acc: &AccountInfo<'a>,
    dest: &AccountInfo<'a>,
    spl: Option<(&AccountInfo<'a>, &AccountInfo<'a>, &AccountInfo<'a>)>,
    amount: u64,
) -> ProgramResult {
    writable(dest)?;
    match spl {
        None => {
            if ledger.kind != KIND_SOL || dest.key == ledger_acc.key {
                return Err(XsError::InvalidAccount.into());
            }
            **ledger_acc.try_borrow_mut_lamports()? = sub(ledger_acc.lamports(), amount)?;
            **dest.try_borrow_mut_lamports()? = add(dest.lamports(), amount)?;
            Ok(())
        }
        Some((vault, mint, tp)) => {
            let bump = [ledger.bump];
            let seeds: [&[u8]; 3] = [LEDGER_SEED, &ledger.mint, &bump];
            invoke_signed(
                &token::transfer_checked(tp.key, vault.key, mint.key, dest.key, ledger_acc.key, amount, ledger.decimals),
                &[vault.clone(), mint.clone(), dest.clone(), ledger_acc.clone(), tp.clone()],
                &[&seeds],
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

fn init_ledger(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    exact(d, 1)?;
    let kind = d[0];
    let it = &mut accounts.iter();
    let funder = next_account_info(it)?;
    let ledger_acc = next_account_info(it)?;
    let (mint_key, token_program, mint_acc, vault_acc, decimals) = match kind {
        KIND_SOL => ([0u8; 32], [0u8; 32], None, None, 9u8),
        KIND_TOKEN | KIND_TOKEN_2022 => {
            let mint = next_account_info(it)?;
            let vault = next_account_info(it)?;
            let tp = next_account_info(it)?;
            let want = if kind == KIND_TOKEN { token::TOKEN_ID } else { token::TOKEN_2022_ID };
            if *tp.key != want {
                return Err(XsError::MintNotAllowed.into());
            }
            let dec = token::check_mint(mint, tp.key)?;
            (mint.key.to_bytes(), tp.key.to_bytes(), Some(mint), Some((vault, tp)), dec)
        }
        _ => return Err(XsError::InvalidParams.into()),
    };
    let system = next_account_info(it)?;
    let slot_hashes = next_account_info(it)?;

    let (ledger_key, bump) = Pubkey::find_program_address(&[LEDGER_SEED, &mint_key], program_id);
    if ledger_key != *ledger_acc.key {
        return Err(XsError::InvalidAccount.into());
    }
    // Cluster binding: the newest SlotHashes entry at creation.
    if *slot_hashes.key != sysvar::slot_hashes::id() {
        return Err(XsError::InvalidAccount.into());
    }
    let (sh_slot, sh_hash) = {
        let sd = slot_hashes.try_borrow_data()?;
        if sd.len() < 48 || rd_u64(&sd, 0) == 0 {
            return Err(XsError::InvalidAccount.into());
        }
        (rd_u64(&sd, 8), rd_key(&sd, 16))
    };
    let salt = crypto::ledger_salt(&program_id.to_bytes(), &mint_key, sh_slot, &sh_hash);

    let bump_b = [bump];
    create_pda(funder, ledger_acc, system, LEDGER_LEN, program_id, &[LEDGER_SEED, &mint_key, &bump_b])?;

    let mut vault_key = ledger_key.to_bytes();
    let mut vault_bump = 0u8;
    if let (Some(mint), Some((vault, tp))) = (mint_acc, vault_acc) {
        let (vk, vb) = Pubkey::find_program_address(&[VAULT_SEED, ledger_key.as_ref()], program_id);
        if vk != *vault.key {
            return Err(XsError::InvalidAccount.into());
        }
        let vb_b = [vb];
        create_pda(funder, vault, system, token::ACCOUNT_LEN, tp.key, &[VAULT_SEED, ledger_key.as_ref(), &vb_b])?;
        invoke(
            &token::initialize_account3(tp.key, vault.key, mint.key, &ledger_key),
            &[vault.clone(), mint.clone(), tp.clone()],
        )?;
        vault_key = vk.to_bytes();
        vault_bump = vb;
    }

    let ledger = Ledger {
        bump,
        vault_bump,
        kind,
        decimals,
        mint: mint_key,
        token_program,
        vault: vault_key,
        salt,
        exit_delay_slots: EXIT_DELAY_SLOTS,
        dispute_slots: DISPUTE_SLOTS,
        batch_timeout_slots: BATCH_TIMEOUT_SLOTS,
        liabilities: 0,
        next_scope: 1,
        created_slot: now()?,
    };
    ledger.store(ledger_acc)?;
    check_solvency(&ledger, ledger_acc, vault_acc.map(|v| v.0))
}

// ---------------------------------------------------------------------------
// Escrow
// ---------------------------------------------------------------------------

fn open_escrow(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    exact(d, 1)?;
    let capacity = d[0] as usize;
    if capacity == 0 || capacity > MAX_PAIRS {
        return Err(XsError::InvalidParams.into());
    }
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let ledger_acc = next_account_info(it)?;
    let escrow_acc = next_account_info(it)?;
    let system = next_account_info(it)?;
    signer(payer)?;
    writable(ledger_acc)?;
    let mut ledger = Ledger::load(ledger_acc, program_id)?;
    if !crypto::is_strict_pubkey(&payer.key.to_bytes()) {
        return Err(XsError::InvalidPayerKey.into());
    }
    let (ek, bump) = Pubkey::find_program_address(&[ESCROW_SEED, ledger_acc.key.as_ref(), payer.key.as_ref()], program_id);
    if ek != *escrow_acc.key {
        return Err(XsError::InvalidAccount.into());
    }
    let bump_b = [bump];
    create_pda(
        payer,
        escrow_acc,
        system,
        escrow_len(capacity),
        program_id,
        &[ESCROW_SEED, ledger_acc.key.as_ref(), payer.key.as_ref(), &bump_b],
    )?;
    let scope = ledger.next_scope;
    ledger.next_scope = add(scope, 1)?;
    {
        let mut e = escrow_acc.try_borrow_mut_data()?;
        e[0..8].copy_from_slice(DISC_ESCROW);
        e[escrow::BUMP] = bump;
        e[escrow::CAPACITY] = capacity as u8;
        e[escrow::LEDGER..escrow::LEDGER + 32].copy_from_slice(ledger_acc.key.as_ref());
        e[escrow::PAYER..escrow::PAYER + 32].copy_from_slice(payer.key.as_ref());
        wr_u64(&mut e, escrow::SCOPE, scope);
    }
    ledger.store(ledger_acc)
}

fn grow_escrow(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    exact(d, 1)?;
    let new_cap = d[0] as usize;
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let escrow_acc = next_account_info(it)?;
    let system = next_account_info(it)?;
    signer(payer)?;
    writable(escrow_acc)?;
    let (_, owner) = check_escrow(escrow_acc, program_id)?;
    if owner != payer.key.to_bytes() {
        return Err(XsError::Unauthorized.into());
    }
    if *system.key != system_program::id() {
        return Err(XsError::InvalidAccount.into());
    }
    let old_len = escrow_acc.data_len();
    let old_cap = escrow_acc.try_borrow_data()?[escrow::CAPACITY] as usize;
    if new_cap <= old_cap || new_cap > MAX_PAIRS {
        return Err(XsError::InvalidParams.into());
    }
    let new_len = escrow_len(new_cap);
    if new_len - old_len > MAX_PERMITTED_DATA_INCREASE {
        return Err(XsError::InvalidParams.into());
    }
    let rent = Rent::get()?.minimum_balance(new_len);
    let cur = escrow_acc.lamports();
    if cur < rent {
        invoke(
            &system_instruction::transfer(payer.key, escrow_acc.key, rent - cur),
            &[payer.clone(), escrow_acc.clone(), system.clone()],
        )?;
    }
    escrow_acc.realloc(new_len, true)?;
    escrow_acc.try_borrow_mut_data()?[escrow::CAPACITY] = new_cap as u8;
    Ok(())
}

fn deposit(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    exact(d, 8)?;
    let amount = rd_u64(d, 0);
    if amount == 0 {
        return Err(XsError::InvalidParams.into());
    }
    let it = &mut accounts.iter();
    let depositor = next_account_info(it)?;
    let ledger_acc = next_account_info(it)?;
    let escrow_acc = next_account_info(it)?;
    signer(depositor)?;
    writable(ledger_acc)?;
    writable(escrow_acc)?;
    let mut ledger = Ledger::load(ledger_acc, program_id)?;
    let (el, _) = check_escrow(escrow_acc, program_id)?;
    if el != ledger_acc.key.to_bytes() {
        return Err(XsError::InvalidAccount.into());
    }
    let mut vault_for_check = None;
    if ledger.kind == KIND_SOL {
        let system = next_account_info(it)?;
        if *system.key != system_program::id() {
            return Err(XsError::InvalidAccount.into());
        }
        invoke(
            &system_instruction::transfer(depositor.key, ledger_acc.key, amount),
            &[depositor.clone(), ledger_acc.clone(), system.clone()],
        )?;
    } else {
        let source = next_account_info(it)?;
        let (vault, mint, tp) = spl_accounts(&ledger, it)?;
        invoke(
            &token::transfer_checked(tp.key, source.key, mint.key, vault.key, depositor.key, amount, ledger.decimals),
            &[source.clone(), mint.clone(), vault.clone(), depositor.clone(), tp.clone()],
        )?;
        vault_for_check = Some(vault);
    }
    {
        let mut e = escrow_acc.try_borrow_mut_data()?;
        let b = add(rd_u64(&e, escrow::BALANCE), amount)?;
        wr_u64(&mut e, escrow::BALANCE, b);
    }
    ledger.liabilities_add(amount)?;
    ledger.store(ledger_acc)?;
    check_solvency(&ledger, ledger_acc, vault_for_check)
}

fn request_exit(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    exact(d, 8)?;
    let amount = rd_u64(d, 0);
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let ledger_acc = next_account_info(it)?;
    let escrow_acc = next_account_info(it)?;
    signer(payer)?;
    writable(escrow_acc)?;
    let ledger = Ledger::load(ledger_acc, program_id)?;
    let (el, owner) = check_escrow(escrow_acc, program_id)?;
    if el != ledger_acc.key.to_bytes() {
        return Err(XsError::InvalidAccount.into());
    }
    if owner != payer.key.to_bytes() {
        return Err(XsError::Unauthorized.into());
    }
    let ready = if amount == 0 { 0 } else { add(now()?, ledger.exit_delay_slots)? };
    let mut e = escrow_acc.try_borrow_mut_data()?;
    wr_u64(&mut e, escrow::EXIT_AMOUNT, amount);
    wr_u64(&mut e, escrow::EXIT_READY, ready);
    Ok(())
}

fn withdraw_escrow(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    exact(d, 0)?;
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let ledger_acc = next_account_info(it)?;
    let escrow_acc = next_account_info(it)?;
    let dest = next_account_info(it)?;
    signer(payer)?;
    writable(ledger_acc)?;
    writable(escrow_acc)?;
    let mut ledger = Ledger::load(ledger_acc, program_id)?;
    let (el, owner) = check_escrow(escrow_acc, program_id)?;
    if el != ledger_acc.key.to_bytes() {
        return Err(XsError::InvalidAccount.into());
    }
    if owner != payer.key.to_bytes() {
        return Err(XsError::Unauthorized.into());
    }
    let spl = if ledger.kind == KIND_SOL { None } else { Some(spl_accounts(&ledger, it)?) };
    let amount = {
        let mut e = escrow_acc.try_borrow_mut_data()?;
        let exit_amount = rd_u64(&e, escrow::EXIT_AMOUNT);
        let ready = rd_u64(&e, escrow::EXIT_READY);
        if exit_amount == 0 || now()? < ready {
            return Err(XsError::ExitNotReady.into());
        }
        // Funds paid out by vouchers during the delay are gone; reserved
        // funds are not part of the balance.
        let bal = rd_u64(&e, escrow::BALANCE);
        let amount = exit_amount.min(bal);
        wr_u64(&mut e, escrow::BALANCE, bal - amount);
        wr_u64(&mut e, escrow::EXIT_AMOUNT, 0);
        wr_u64(&mut e, escrow::EXIT_READY, 0);
        amount
    };
    if amount > 0 {
        ledger.liabilities_sub(amount)?;
        ledger.store(ledger_acc)?;
        pay_out(&ledger, ledger_acc, dest, spl, amount)?;
    }
    check_solvency(&ledger, ledger_acc, spl.map(|s| s.0))
}

fn close_escrow(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    exact(d, 0)?;
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let escrow_acc = next_account_info(it)?;
    signer(payer)?;
    let (_, owner) = check_escrow(escrow_acc, program_id)?;
    if owner != payer.key.to_bytes() {
        return Err(XsError::Unauthorized.into());
    }
    {
        let e = escrow_acc.try_borrow_data()?;
        if rd_u64(&e, escrow::BALANCE) != 0 || rd_u16(&e, escrow::PENDING_COUNT) != 0 || rd_u32(&e, escrow::OPEN_CHANNELS) != 0 {
            return Err(XsError::EscrowBusy.into());
        }
    }
    close_account(escrow_acc, payer)
}

// ---------------------------------------------------------------------------
// Books (payee balances)
// ---------------------------------------------------------------------------

fn create_book(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    exact(d, 4)?;
    let page = rd_u32(d, 0);
    let it = &mut accounts.iter();
    let funder = next_account_info(it)?;
    let ledger_acc = next_account_info(it)?;
    let book_acc = next_account_info(it)?;
    let system = next_account_info(it)?;
    Ledger::load(ledger_acc, program_id)?;
    let page_b = page.to_le_bytes();
    let (bk, bump) = Pubkey::find_program_address(&[BOOK_SEED, ledger_acc.key.as_ref(), &page_b], program_id);
    if bk != *book_acc.key {
        return Err(XsError::InvalidAccount.into());
    }
    let bump_b = [bump];
    create_pda(funder, book_acc, system, BOOK_LEN, program_id, &[BOOK_SEED, ledger_acc.key.as_ref(), &page_b, &bump_b])?;
    let mut b = book_acc.try_borrow_mut_data()?;
    b[0..8].copy_from_slice(DISC_BOOK);
    b[book::BUMP] = bump;
    wr_u32(&mut b, book::PAGE, page);
    b[book::LEDGER..book::LEDGER + 32].copy_from_slice(ledger_acc.key.as_ref());
    Ok(())
}

fn register_payee(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    exact(d, 1)?;
    let slot = d[0] as usize;
    if slot >= BOOK_SLOTS {
        return Err(XsError::InvalidParams.into());
    }
    let it = &mut accounts.iter();
    let payee = next_account_info(it)?;
    let book_acc = next_account_info(it)?;
    signer(payee)?;
    writable(book_acc)?;
    check_book(book_acc, program_id)?;
    let mut b = book_acc.try_borrow_mut_data()?;
    let o = slot_off(slot);
    if b[o..o + 32] != [0u8; 32] {
        return Err(XsError::SlotMismatch.into());
    }
    // Slots are permanent: an owner is never replaced, so a pending credit
    // always reaches the payee it was staged for.
    b[o..o + 32].copy_from_slice(payee.key.as_ref());
    let used = rd_u16(&b, book::USED) + 1;
    wr_u16(&mut b, book::USED, used);
    Ok(())
}

fn withdraw_payee(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    exact(d, 9)?;
    let slot = d[0] as usize;
    let amount = rd_u64(d, 1);
    if slot >= BOOK_SLOTS || amount == 0 {
        return Err(XsError::InvalidParams.into());
    }
    let it = &mut accounts.iter();
    let payee = next_account_info(it)?;
    let ledger_acc = next_account_info(it)?;
    let book_acc = next_account_info(it)?;
    let dest = next_account_info(it)?;
    signer(payee)?;
    writable(ledger_acc)?;
    writable(book_acc)?;
    let mut ledger = Ledger::load(ledger_acc, program_id)?;
    if check_book(book_acc, program_id)? != ledger_acc.key.to_bytes() {
        return Err(XsError::InvalidAccount.into());
    }
    let spl = if ledger.kind == KIND_SOL { None } else { Some(spl_accounts(&ledger, it)?) };
    {
        let mut b = book_acc.try_borrow_mut_data()?;
        let o = slot_off(slot);
        if b[o..o + 32] != payee.key.to_bytes() {
            return Err(XsError::SlotMismatch.into());
        }
        let bal = rd_u64(&b, o + book::S_BALANCE);
        if bal < amount {
            return Err(XsError::InsufficientFunds.into());
        }
        wr_u64(&mut b, o + book::S_BALANCE, bal - amount);
    }
    ledger.liabilities_sub(amount)?;
    ledger.store(ledger_acc)?;
    pay_out(&ledger, ledger_acc, dest, spl, amount)?;
    check_solvency(&ledger, ledger_acc, spl.map(|s| s.0))
}

// ---------------------------------------------------------------------------
// Lane B2: vouchers against payer escrows
// ---------------------------------------------------------------------------

struct VCtx {
    program_id: [u8; 32],
    ledger: [u8; 32],
    mint: [u8; 32],
    salt: [u8; 32],
    now: u64,
}

/// Accounts already checked in this instruction (bit per account index).
struct Seen(u128);

impl Seen {
    fn test_set(&mut self, i: usize) -> Result<bool, ProgramError> {
        if i >= 128 {
            return Err(XsError::InvalidInstruction.into());
        }
        let bit = 1u128 << i;
        let was = self.0 & bit != 0;
        self.0 |= bit;
        Ok(was)
    }
}

/// A verified B2 voucher, not yet applied.
struct B2 {
    escrow_ix: usize,
    pair_ix: usize,
    append: bool,
    payee: [u8; 32],
    book_ix: usize,
    slot: usize,
    cumulative: u64,
    delta: u64,
    msg: [u8; crypto::MSG_LEN],
}

/// Checks a B2 voucher against its escrow pair and payee slot and verifies
/// the payer signature. `need_book_writable` is true for Settle.
fn verify_b2(
    program_id: &Pubkey,
    ctx: &VCtx,
    accounts: &[AccountInfo],
    w: &WireVoucher,
    escrows_seen: &mut Seen,
    books_seen: &mut Seen,
    first_ix: usize,
    need_book_writable: bool,
) -> Result<B2, ProgramError> {
    let ei = w.escrow_ix as usize;
    let bi = w.book_ix as usize;
    let slot = w.slot as usize;
    if ei < first_ix || bi < first_ix {
        return Err(XsError::InvalidInstruction.into());
    }
    let escrow_acc = accounts.get(ei).ok_or(XsError::InvalidInstruction)?;
    let book_acc = accounts.get(bi).ok_or(XsError::InvalidInstruction)?;
    if !escrows_seen.test_set(ei)? {
        writable(escrow_acc)?;
        let (l, _) = check_escrow(escrow_acc, program_id)?;
        if l != ctx.ledger {
            return Err(XsError::InvalidAccount.into());
        }
    }
    if !books_seen.test_set(bi)? {
        if need_book_writable {
            writable(book_acc)?;
        }
        if check_book(book_acc, program_id)? != ctx.ledger {
            return Err(XsError::InvalidAccount.into());
        }
    }
    if slot >= BOOK_SLOTS {
        return Err(XsError::InvalidInstruction.into());
    }
    let payee = rd_key(&book_acc.try_borrow_data()?, slot_off(slot));
    if payee == [0u8; 32] {
        return Err(XsError::SlotMismatch.into());
    }
    if w.expiry_slot < ctx.now {
        return Err(XsError::VoucherExpired.into());
    }
    let e = escrow_acc.try_borrow_data()?;
    let count = e[escrow::PAIR_COUNT] as usize;
    let cap = e[escrow::CAPACITY] as usize;
    let pi = w.pair_ix as usize;
    let (append, settled) = if pi < count {
        let o = pair_off(pi);
        if rd_key(&e, o + escrow::P_PAYEE) != payee {
            return Err(XsError::PairMismatch.into());
        }
        if rd_u64(&e, o + escrow::P_PENDING_BATCH) != 0 {
            return Err(XsError::PairPending.into());
        }
        (false, rd_u64(&e, o + escrow::P_SETTLED))
    } else if pi == count {
        if count >= cap {
            return Err(XsError::PairTableFull.into());
        }
        // One entry per payee: a second entry would restart the cumulative
        // counter and let the same voucher settle twice.
        if pair_exists(&e, count, &payee) {
            return Err(XsError::DuplicatePair.into());
        }
        (true, 0)
    } else {
        return Err(XsError::InvalidInstruction.into());
    };
    if w.cumulative <= settled {
        return Err(XsError::StaleVoucher.into());
    }
    let delta = w.cumulative - settled;
    if rd_u64(&e, escrow::BALANCE) < delta {
        return Err(XsError::InsufficientFunds.into());
    }
    let payer = rd_key(&e, escrow::PAYER);
    let scope = rd_u64(&e, escrow::SCOPE);
    drop(e);
    let msg = crypto::voucher_message(
        &ctx.program_id,
        &ctx.mint,
        &ctx.salt,
        &payer,
        &payee,
        scope,
        w.cumulative,
        w.expiry_slot,
        &w.quote_hash,
    );
    if !crypto::verify(&payer, &msg, &w.sig) {
        return Err(XsError::BadSignature.into());
    }
    Ok(B2 { escrow_ix: ei, pair_ix: pi, append, payee, book_ix: bi, slot, cumulative: w.cumulative, delta, msg })
}

/// True if `payee` already has an entry among the `count` pairs in use.
/// Bounded by `MAX_PAIRS` (255); runs only when a voucher appends a pair.
fn pair_exists(e: &[u8], count: usize, payee: &[u8; 32]) -> bool {
    let head = rd_u64(payee, 0);
    (0..count).any(|i| {
        let o = pair_off(i);
        rd_u64(e, o) == head && e[o..o + 32] == payee[..]
    })
}

/// Writes a new pair entry if the voucher appends one; returns the entry
/// offset.
fn pair_entry(e: &mut [u8], v: &B2) -> usize {
    let o = pair_off(v.pair_ix);
    if v.append {
        e[o..o + 32].copy_from_slice(&v.payee);
        wr_u64(e, o + escrow::P_SETTLED, 0);
        wr_u64(e, o + escrow::P_PENDING_CUM, 0);
        wr_u64(e, o + escrow::P_PENDING_BATCH, 0);
        e[escrow::PAIR_COUNT] += 1;
    }
    o
}

fn settle(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let (&n, body) = d.split_first().ok_or(XsError::InvalidInstruction)?;
    let n = n as usize;
    if n == 0 || body.len() != n * VOUCHER_WIRE_LEN {
        return Err(XsError::InvalidInstruction.into());
    }
    let ledger_acc = accounts.first().ok_or(XsError::InvalidInstruction)?;
    let ledger = Ledger::load(ledger_acc, program_id)?;
    let ctx = VCtx {
        program_id: program_id.to_bytes(),
        ledger: ledger_acc.key.to_bytes(),
        mint: ledger.mint,
        salt: ledger.salt,
        now: now()?,
    };
    let mut es = Seen(0);
    let mut bs = Seen(0);
    for i in 0..n {
        let w = WireVoucher::decode(&body[i * VOUCHER_WIRE_LEN..(i + 1) * VOUCHER_WIRE_LEN]);
        let v = verify_b2(program_id, &ctx, accounts, &w, &mut es, &mut bs, 1, true)?;
        {
            let mut e = accounts[v.escrow_ix].try_borrow_mut_data()?;
            let o = pair_entry(&mut e, &v);
            wr_u64(&mut e, o + escrow::P_SETTLED, v.cumulative);
            let bal = sub(rd_u64(&e, escrow::BALANCE), v.delta)?;
            wr_u64(&mut e, escrow::BALANCE, bal);
        }
        {
            let mut b = accounts[v.book_ix].try_borrow_mut_data()?;
            let o = slot_off(v.slot) + book::S_BALANCE;
            let bal = add(rd_u64(&b, o), v.delta)?;
            wr_u64(&mut b, o, bal);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Lane C: channels
// ---------------------------------------------------------------------------

fn open_channel(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    exact(d, 56)?;
    let channel_id = rd_u64(d, 0);
    let payee = rd_key(d, 8);
    let amount = rd_u64(d, 40);
    let expiry_slot = rd_u64(d, 48);
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let ledger_acc = next_account_info(it)?;
    let escrow_acc = next_account_info(it)?;
    let channel_acc = next_account_info(it)?;
    let system = next_account_info(it)?;
    signer(payer)?;
    writable(ledger_acc)?;
    writable(escrow_acc)?;
    let mut ledger = Ledger::load(ledger_acc, program_id)?;
    let (el, owner) = check_escrow(escrow_acc, program_id)?;
    if el != ledger_acc.key.to_bytes() {
        return Err(XsError::InvalidAccount.into());
    }
    if owner != payer.key.to_bytes() {
        return Err(XsError::Unauthorized.into());
    }
    let slot = now()?;
    if amount == 0 || payee == [0u8; 32] || expiry_slot <= slot || expiry_slot - slot > MAX_CHANNEL_SLOTS {
        return Err(XsError::InvalidParams.into());
    }
    let id_b = channel_id.to_le_bytes();
    let (ck, bump) =
        Pubkey::find_program_address(&[CHANNEL_SEED, ledger_acc.key.as_ref(), payer.key.as_ref(), &payee, &id_b], program_id);
    if ck != *channel_acc.key {
        return Err(XsError::InvalidAccount.into());
    }
    {
        let mut e = escrow_acc.try_borrow_mut_data()?;
        let bal = rd_u64(&e, escrow::BALANCE);
        if bal < amount {
            return Err(XsError::InsufficientFunds.into());
        }
        wr_u64(&mut e, escrow::BALANCE, bal - amount);
        let oc = rd_u32(&e, escrow::OPEN_CHANNELS).checked_add(1).ok_or(XsError::MathOverflow)?;
        wr_u32(&mut e, escrow::OPEN_CHANNELS, oc);
    }
    let bump_b = [bump];
    create_pda(
        payer,
        channel_acc,
        system,
        CHANNEL_LEN,
        program_id,
        &[CHANNEL_SEED, ledger_acc.key.as_ref(), payer.key.as_ref(), &payee, &id_b, &bump_b],
    )?;
    let scope = ledger.next_scope;
    ledger.next_scope = add(scope, 1)?;
    ledger.store(ledger_acc)?;
    Channel {
        bump,
        status: CH_OPEN,
        ledger: ledger_acc.key.to_bytes(),
        payer: payer.key.to_bytes(),
        payee,
        channel_id,
        scope,
        deposit: amount,
        balance: amount,
        best_cum: 0,
        expiry_slot,
        dispute_end_slot: 0,
    }
    .store(channel_acc)
}

/// Credits `amount` to a payee slot after checking that the slot belongs to
/// `payee`.
fn credit_slot(
    program_id: &Pubkey,
    book_acc: &AccountInfo,
    ledger: &[u8; 32],
    slot: usize,
    payee: &[u8; 32],
    amount: u64,
    verify: bool,
) -> ProgramResult {
    if verify {
        writable(book_acc)?;
        if check_book(book_acc, program_id)? != *ledger {
            return Err(XsError::InvalidAccount.into());
        }
    }
    if slot >= BOOK_SLOTS {
        return Err(XsError::InvalidInstruction.into());
    }
    let mut b = book_acc.try_borrow_mut_data()?;
    let o = slot_off(slot);
    if rd_key(&b, o) != *payee {
        return Err(XsError::SlotMismatch.into());
    }
    let bal = add(rd_u64(&b, o + book::S_BALANCE), amount)?;
    wr_u64(&mut b, o + book::S_BALANCE, bal);
    Ok(())
}

fn is_signer_key(accounts: &[AccountInfo], key: &[u8; 32]) -> bool {
    accounts.iter().any(|a| a.is_signer && a.key.to_bytes() == *key)
}

/// Signer keys of the instruction (a V1 transaction has at most 12).
struct Signers {
    keys: [[u8; 32]; 12],
    n: usize,
}

impl Signers {
    fn of(accounts: &[AccountInfo]) -> Self {
        let mut s = Signers { keys: [[0u8; 32]; 12], n: 0 };
        for a in accounts.iter().filter(|a| a.is_signer) {
            if s.n < 12 {
                s.keys[s.n] = a.key.to_bytes();
                s.n += 1;
            }
        }
        s
    }
    fn has(&self, k: &[u8; 32]) -> bool {
        self.keys[..self.n].iter().any(|x| x == k)
    }
}

fn close_channels(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let (&n, body) = d.split_first().ok_or(XsError::InvalidInstruction)?;
    let n = n as usize;
    if n == 0 || body.len() != n * CLOSE_WIRE_LEN {
        return Err(XsError::InvalidInstruction.into());
    }
    let ledger_acc = accounts.first().ok_or(XsError::InvalidInstruction)?;
    let ledger = Ledger::load(ledger_acc, program_id)?;
    let lk = ledger_acc.key.to_bytes();
    let slot_now = now()?;
    let pid = program_id.to_bytes();
    let signers = Signers::of(accounts);
    let mut books = Seen(0);
    for i in 0..n {
        let w = WireClose::decode(&body[i * CLOSE_WIRE_LEN..(i + 1) * CLOSE_WIRE_LEN]);
        let ch_acc = accounts.get(w.channel_ix as usize).ok_or(XsError::InvalidInstruction)?;
        writable(ch_acc)?;
        let mut ch = Channel::load(ch_acc, program_id)?;
        if ch.ledger != lk {
            return Err(XsError::InvalidAccount.into());
        }
        match ch.status {
            CH_OPEN if slot_now >= ch.expiry_slot => return Err(XsError::ChannelExpired.into()),
            CH_OPEN => {}
            CH_CLOSING if slot_now > ch.dispute_end_slot => return Err(XsError::ChannelState.into()),
            CH_CLOSING => {}
            _ => return Err(XsError::ChannelState.into()),
        }
        if w.expiry_slot < slot_now {
            return Err(XsError::VoucherExpired.into());
        }
        if w.cumulative <= ch.best_cum {
            return Err(XsError::StaleVoucher.into());
        }
        if w.cumulative > ch.balance {
            return Err(XsError::OverDeposit.into());
        }
        let msg = crypto::voucher_message(
            &pid,
            &ledger.mint,
            &ledger.salt,
            &ch.payer,
            &ch.payee,
            ch.scope,
            w.cumulative,
            w.expiry_slot,
            &w.quote_hash,
        );
        if !crypto::verify(&ch.payer, &msg, &w.sig) {
            return Err(XsError::BadSignature.into());
        }
        ch.best_cum = w.cumulative;
        if signers.has(&ch.payee) {
            // The payee closes with its own latest voucher: no dispute window.
            let bi = w.book_ix as usize;
            if w.book_ix == NO_BOOK || bi == 0 {
                return Err(XsError::InvalidInstruction.into());
            }
            let book_acc = accounts.get(bi).ok_or(XsError::InvalidInstruction)?;
            let fresh = !books.test_set(bi)?;
            credit_slot(program_id, book_acc, &lk, w.slot as usize, &ch.payee, ch.best_cum, fresh)?;
            ch.balance = sub(ch.balance, ch.best_cum)?;
            ch.status = CH_CLOSED;
        } else if ch.status == CH_OPEN {
            ch.status = CH_CLOSING;
            ch.dispute_end_slot = add(slot_now, ledger.dispute_slots)?;
        }
        ch.store(ch_acc)?;
    }
    Ok(())
}

fn request_channel_close(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    exact(d, 0)?;
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let ledger_acc = next_account_info(it)?;
    let ch_acc = next_account_info(it)?;
    signer(payer)?;
    writable(ch_acc)?;
    let ledger = Ledger::load(ledger_acc, program_id)?;
    let mut ch = Channel::load(ch_acc, program_id)?;
    if ch.ledger != ledger_acc.key.to_bytes() {
        return Err(XsError::InvalidAccount.into());
    }
    if ch.payer != payer.key.to_bytes() {
        return Err(XsError::Unauthorized.into());
    }
    let slot_now = now()?;
    if ch.status != CH_OPEN {
        return Err(XsError::ChannelState.into());
    }
    if slot_now >= ch.expiry_slot {
        return Err(XsError::ChannelExpired.into());
    }
    ch.status = CH_CLOSING;
    ch.dispute_end_slot = add(slot_now, ledger.dispute_slots)?;
    ch.store(ch_acc)
}

fn finalize_channel(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    exact(d, 1)?;
    let slot = d[0] as usize;
    let ch_acc = accounts.first().ok_or(XsError::InvalidInstruction)?;
    writable(ch_acc)?;
    let mut ch = Channel::load(ch_acc, program_id)?;
    let payee_signed = is_signer_key(accounts, &ch.payee);
    let slot_now = now()?;
    match ch.status {
        CH_CLOSING if payee_signed || slot_now > ch.dispute_end_slot => {}
        CH_CLOSING => return Err(XsError::DisputeOpen.into()),
        CH_OPEN if payee_signed => {}
        _ => return Err(XsError::ChannelState.into()),
    }
    if ch.best_cum > 0 {
        let book_acc = accounts.get(1).ok_or(XsError::InvalidInstruction)?;
        credit_slot(program_id, book_acc, &ch.ledger, slot, &ch.payee, ch.best_cum, true)?;
        ch.balance = sub(ch.balance, ch.best_cum)?;
    }
    ch.status = CH_CLOSED;
    ch.store(ch_acc)
}

fn reclaim_channel(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    exact(d, 0)?;
    let it = &mut accounts.iter();
    let ch_acc = next_account_info(it)?;
    let escrow_acc = next_account_info(it)?;
    let payer = next_account_info(it)?;
    writable(escrow_acc)?;
    let ch = Channel::load(ch_acc, program_id)?;
    let slot_now = now()?;
    match ch.status {
        CH_CLOSED => {}
        CH_OPEN if slot_now >= ch.expiry_slot => {}
        CH_OPEN => return Err(XsError::ChannelNotExpired.into()),
        _ => return Err(XsError::ChannelState.into()),
    }
    let (el, owner) = check_escrow(escrow_acc, program_id)?;
    if el != ch.ledger || owner != ch.payer || payer.key.to_bytes() != ch.payer {
        return Err(XsError::InvalidAccount.into());
    }
    {
        let mut e = escrow_acc.try_borrow_mut_data()?;
        let bal = add(rd_u64(&e, escrow::BALANCE), ch.balance)?;
        wr_u64(&mut e, escrow::BALANCE, bal);
        let oc = rd_u32(&e, escrow::OPEN_CHANNELS).checked_sub(1).ok_or(XsError::MathOverflow)?;
        wr_u32(&mut e, escrow::OPEN_CHANNELS, oc);
    }
    close_account(ch_acc, payer)
}

// ---------------------------------------------------------------------------
// Two-phase batches
// ---------------------------------------------------------------------------

fn begin_batch(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    exact(d, 54)?;
    let batch_id = rd_u64(d, 0);
    let root = rd_key(d, 8);
    let count = rd_u32(d, 40);
    let total = rd_u64(d, 44);
    let chunk_log = d[52];
    let chunk_size = d[53];
    if batch_id == 0
        || count == 0
        || chunk_log > MAX_CHUNK_LOG
        || chunk_size == 0
        || chunk_size as u32 > (1u32 << chunk_log)
        || total < count as u64
    {
        return Err(XsError::InvalidParams.into());
    }
    let num_chunks = count.div_ceil(chunk_size as u32);
    if num_chunks > MAX_CHUNKS {
        return Err(XsError::InvalidParams.into());
    }
    let it = &mut accounts.iter();
    let submitter = next_account_info(it)?;
    let ledger_acc = next_account_info(it)?;
    let batch_acc = next_account_info(it)?;
    let system = next_account_info(it)?;
    let ledger = Ledger::load(ledger_acc, program_id)?;
    let id_b = batch_id.to_le_bytes();
    let (bk, bump) = Pubkey::find_program_address(&[BATCH_SEED, ledger_acc.key.as_ref(), &id_b], program_id);
    if bk != *batch_acc.key {
        return Err(XsError::InvalidAccount.into());
    }
    let bump_b = [bump];
    create_pda(submitter, batch_acc, system, BATCH_LEN, program_id, &[BATCH_SEED, ledger_acc.key.as_ref(), &id_b, &bump_b])?;
    let hdr = BatchHdr {
        bump,
        status: B_STAGING,
        chunk_log,
        chunk_size,
        n_payees: 0,
        num_chunks: num_chunks as u16,
        chunks_staged: 0,
        ledger: ledger_acc.key.to_bytes(),
        submitter: submitter.key.to_bytes(),
        batch_id,
        root,
        count,
        staged_count: 0,
        total,
        staged_total: 0,
        held: 0,
        deadline_slot: add(now()?, ledger.batch_timeout_slots)?,
        outstanding: 0,
    };
    hdr.pack(&mut batch_acc.try_borrow_mut_data()?);
    Ok(())
}

/// Adds `amount` to the batch's credit for `(book, slot)`.
fn add_batch_payee(bd: &mut [u8], hdr: &mut BatchHdr, book: &[u8; 32], slot: u8, amount: u64) -> ProgramResult {
    for i in 0..hdr.n_payees as usize {
        let o = batch_payee_off(i);
        if bd[o..o + 32] == *book && bd[o + 40] == slot {
            let a = add(rd_u64(bd, o + 32), amount)?;
            wr_u64(bd, o + 32, a);
            return Ok(());
        }
    }
    let i = hdr.n_payees as usize;
    if i >= MAX_BATCH_PAYEES {
        return Err(XsError::BatchPayeesFull.into());
    }
    let o = batch_payee_off(i);
    bd[o..o + 32].copy_from_slice(book);
    wr_u64(bd, o + 32, amount);
    bd[o + 40] = slot;
    hdr.n_payees += 1;
    Ok(())
}

fn stage_chunk(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    if d.len() < 4 {
        return Err(XsError::InvalidInstruction.into());
    }
    let chunk_index = rd_u16(d, 0) as u32;
    let n = d[2] as usize;
    let proof_len = d[3] as usize;
    let proof_end = 4 + proof_len * 32;
    if d.len() != proof_end + n * VOUCHER_WIRE_LEN {
        return Err(XsError::InvalidInstruction.into());
    }
    let ledger_acc = accounts.first().ok_or(XsError::InvalidInstruction)?;
    let batch_acc = accounts.get(1).ok_or(XsError::InvalidInstruction)?;
    writable(batch_acc)?;
    let ledger = Ledger::load(ledger_acc, program_id)?;
    let mut hdr = BatchHdr::load(batch_acc, program_id)?;
    let lk = ledger_acc.key.to_bytes();
    if hdr.ledger != lk {
        return Err(XsError::InvalidAccount.into());
    }
    if hdr.status != B_STAGING {
        return Err(XsError::BatchState.into());
    }
    let slot_now = now()?;
    if slot_now > hdr.deadline_slot {
        return Err(XsError::BatchDeadline.into());
    }
    let num_chunks = hdr.num_chunks as u32;
    if chunk_index >= num_chunks {
        return Err(XsError::BadChunk.into());
    }
    let bit_o = BATCH_HDR + (chunk_index / 8) as usize;
    let bit = 1u8 << (chunk_index % 8);
    if batch_acc.try_borrow_data()?[bit_o] & bit != 0 {
        return Err(XsError::ChunkAlreadyStaged.into());
    }
    let cs = hdr.chunk_size as u32;
    let expect = cs.min(hdr.count - chunk_index * cs) as usize;
    if n != expect || proof_len as u32 != crypto::upper_depth(num_chunks) {
        return Err(XsError::BadChunk.into());
    }
    let ctx = VCtx { program_id: program_id.to_bytes(), ledger: lk, mint: ledger.mint, salt: ledger.salt, now: slot_now };
    let mut es = Seen(0);
    let mut bs = Seen(0);
    let mut leaves: Vec<[u8; 32]> = Vec::with_capacity(n);
    let body = &d[proof_end..];
    for i in 0..n {
        let w = WireVoucher::decode(&body[i * VOUCHER_WIRE_LEN..(i + 1) * VOUCHER_WIRE_LEN]);
        let v = verify_b2(program_id, &ctx, accounts, &w, &mut es, &mut bs, 2, false)?;
        // Reserve: the delta leaves the escrow balance now and is held by the
        // batch; the pair is locked until the batch is resolved.
        {
            let mut e = accounts[v.escrow_ix].try_borrow_mut_data()?;
            let o = pair_entry(&mut e, &v);
            wr_u64(&mut e, o + escrow::P_PENDING_CUM, v.cumulative);
            wr_u64(&mut e, o + escrow::P_PENDING_BATCH, hdr.batch_id);
            let bal = sub(rd_u64(&e, escrow::BALANCE), v.delta)?;
            wr_u64(&mut e, escrow::BALANCE, bal);
            let pc = rd_u16(&e, escrow::PENDING_COUNT).checked_add(1).ok_or(XsError::MathOverflow)?;
            wr_u16(&mut e, escrow::PENDING_COUNT, pc);
        }
        let book_key = accounts[v.book_ix].key.to_bytes();
        add_batch_payee(&mut batch_acc.try_borrow_mut_data()?, &mut hdr, &book_key, v.slot as u8, v.delta)?;
        hdr.staged_count = hdr.staged_count.checked_add(1).ok_or(XsError::MathOverflow)?;
        hdr.staged_total = add(hdr.staged_total, v.delta)?;
        hdr.held = add(hdr.held, v.delta)?;
        hdr.outstanding = hdr.outstanding.checked_add(1).ok_or(XsError::MathOverflow)?;
        leaves.push(crypto::batch_leaf(v.delta, &v.msg));
    }
    let mut proof = [[0u8; 32]; 8];
    for (j, p) in proof.iter_mut().take(proof_len).enumerate() {
        p.copy_from_slice(&d[4 + 32 * j..4 + 32 * (j + 1)]);
    }
    let chunk_root = crypto::subtree_root(&leaves, hdr.chunk_log as u32);
    if crypto::fold_proof(chunk_root, chunk_index, &proof[..proof_len]) != hdr.root {
        return Err(XsError::BadMerkleProof.into());
    }
    hdr.chunks_staged += 1;
    let mut bd = batch_acc.try_borrow_mut_data()?;
    bd[bit_o] |= bit;
    hdr.pack(&mut bd);
    Ok(())
}

fn commit_batch(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    exact(d, 0)?;
    let batch_acc = accounts.first().ok_or(XsError::InvalidInstruction)?;
    writable(batch_acc)?;
    let mut hdr = BatchHdr::load(batch_acc, program_id)?;
    if hdr.status != B_STAGING {
        return Err(XsError::BatchState.into());
    }
    if now()? > hdr.deadline_slot {
        return Err(XsError::BatchDeadline.into());
    }
    if hdr.chunks_staged as u32 != hdr.num_chunks as u32 || hdr.staged_count != hdr.count {
        return Err(XsError::BatchIncomplete.into());
    }
    if hdr.staged_total != hdr.total || hdr.held != hdr.total {
        return Err(XsError::BatchTotalMismatch.into());
    }
    // Every credit of the batch in one instruction.
    let mut seen = Seen(0);
    let mut credited = 0u64;
    for i in 0..hdr.n_payees as usize {
        let (book_key, amount, slot) = {
            let bd = batch_acc.try_borrow_data()?;
            let o = batch_payee_off(i);
            (rd_key(&bd, o), rd_u64(&bd, o + 32), bd[o + 40] as usize)
        };
        let bi = 1 + accounts[1..]
            .iter()
            .position(|a| a.key.to_bytes() == book_key)
            .ok_or(XsError::InvalidAccount)?;
        let book_acc = &accounts[bi];
        if !seen.test_set(bi)? {
            writable(book_acc)?;
            if check_book(book_acc, program_id)? != hdr.ledger {
                return Err(XsError::InvalidAccount.into());
            }
        }
        let mut b = book_acc.try_borrow_mut_data()?;
        let o = slot_off(slot) + book::S_BALANCE;
        let bal = add(rd_u64(&b, o), amount)?;
        wr_u64(&mut b, o, bal);
        credited = add(credited, amount)?;
    }
    if credited != hdr.held {
        return Err(XsError::BatchTotalMismatch.into());
    }
    hdr.held = 0;
    hdr.status = B_COMMITTED;
    hdr.pack(&mut batch_acc.try_borrow_mut_data()?);
    Ok(())
}

fn abort_batch(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    exact(d, 0)?;
    let it = &mut accounts.iter();
    let caller = next_account_info(it)?;
    let batch_acc = next_account_info(it)?;
    signer(caller)?;
    writable(batch_acc)?;
    let mut hdr = BatchHdr::load(batch_acc, program_id)?;
    if hdr.status != B_STAGING {
        return Err(XsError::BatchState.into());
    }
    if caller.key.to_bytes() != hdr.submitter && now()? <= hdr.deadline_slot {
        return Err(XsError::BatchNotTimedOut.into());
    }
    hdr.status = B_ABORTED;
    hdr.pack(&mut batch_acc.try_borrow_mut_data()?);
    Ok(())
}

fn resolve_staged(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let (&n, body) = d.split_first().ok_or(XsError::InvalidInstruction)?;
    let n = n as usize;
    if n == 0 || body.len() != 2 * n {
        return Err(XsError::InvalidInstruction.into());
    }
    let batch_acc = accounts.first().ok_or(XsError::InvalidInstruction)?;
    writable(batch_acc)?;
    let mut hdr = BatchHdr::load(batch_acc, program_id)?;
    let committed = match hdr.status {
        B_COMMITTED => true,
        B_ABORTED => false,
        _ => return Err(XsError::BatchState.into()),
    };
    let mut seen = Seen(0);
    for i in 0..n {
        let ei = body[2 * i] as usize;
        let pi = body[2 * i + 1] as usize;
        if ei == 0 {
            return Err(XsError::InvalidInstruction.into());
        }
        let escrow_acc = accounts.get(ei).ok_or(XsError::InvalidInstruction)?;
        if !seen.test_set(ei)? {
            writable(escrow_acc)?;
            let (l, _) = check_escrow(escrow_acc, program_id)?;
            if l != hdr.ledger {
                return Err(XsError::InvalidAccount.into());
            }
        }
        let mut e = escrow_acc.try_borrow_mut_data()?;
        if pi >= e[escrow::PAIR_COUNT] as usize {
            return Err(XsError::InvalidInstruction.into());
        }
        let o = pair_off(pi);
        if rd_u64(&e, o + escrow::P_PENDING_BATCH) != hdr.batch_id {
            return Err(XsError::WrongPendingBatch.into());
        }
        let cum = rd_u64(&e, o + escrow::P_PENDING_CUM);
        let settled = rd_u64(&e, o + escrow::P_SETTLED);
        let delta = sub(cum, settled)?;
        if committed {
            wr_u64(&mut e, o + escrow::P_SETTLED, cum);
        } else {
            let bal = add(rd_u64(&e, escrow::BALANCE), delta)?;
            wr_u64(&mut e, escrow::BALANCE, bal);
            hdr.held = sub(hdr.held, delta)?;
        }
        wr_u64(&mut e, o + escrow::P_PENDING_CUM, 0);
        wr_u64(&mut e, o + escrow::P_PENDING_BATCH, 0);
        let pc = rd_u16(&e, escrow::PENDING_COUNT).checked_sub(1).ok_or(XsError::MathOverflow)?;
        wr_u16(&mut e, escrow::PENDING_COUNT, pc);
        hdr.outstanding = hdr.outstanding.checked_sub(1).ok_or(XsError::MathOverflow)?;
    }
    hdr.pack(&mut batch_acc.try_borrow_mut_data()?);
    Ok(())
}

fn close_batch(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    exact(d, 0)?;
    let it = &mut accounts.iter();
    let batch_acc = next_account_info(it)?;
    let submitter = next_account_info(it)?;
    let hdr = BatchHdr::load(batch_acc, program_id)?;
    if hdr.status != B_COMMITTED && hdr.status != B_ABORTED {
        return Err(XsError::BatchState.into());
    }
    if hdr.outstanding != 0 || hdr.held != 0 {
        return Err(XsError::BatchOutstanding.into());
    }
    if submitter.key.to_bytes() != hdr.submitter {
        return Err(XsError::InvalidAccount.into());
    }
    close_account(batch_acc, submitter)
}
