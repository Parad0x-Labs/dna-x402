//! Instruction handlers.
//!
//! Every handler that reads the pool ends with [`assert_solvent`]:
//! `pool.lamports >= jackpot + reserve + creator_owed + locked_prize
//!  + owed_prizes + rent_exempt_minimum(POOL_LEN)`.
//! Lamports leave the pool only in Payout (a settled winner share, to the
//! ticket owner) and WithdrawCreatorFees (at most `creator_owed`, to the
//! creator). There is no other debit, no admin key and no close instruction
//! for the pool.

use crate::{
    draw::{self, SelectError},
    econ,
    error::PoolError,
    instruction::{claim_address, pool_address, round_address, PoolInstruction},
    state::{
        ClaimRecord, Pool, Round, CLAIM_LEN, CLAIM_SEED, FRONTIER_OFFSET, POOL_LEN, POOL_SEED,
        ROUND_DRAWN, ROUND_LEN, ROUND_SEED, ROUND_SETTLED,
    },
    tree::{self, FRONTIER_LEN, MAX_TICKETS, TREE_DEPTH, ZEROS},
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    log::sol_log_data,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::{self, slot_hashes, Sysvar},
};

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match PoolInstruction::unpack(data).ok_or(PoolError::InvalidInstruction)? {
        PoolInstruction::CreatePool { nonce, params } => create_pool(program_id, accounts, nonce, params),
        PoolInstruction::BuyTicket { round_id, owner, numbers } => {
            buy_ticket(program_id, accounts, round_id, owner, numbers)
        }
        PoolInstruction::Draw => draw_round(program_id, accounts),
        PoolInstruction::Claim { ticket_index, numbers, proof } => {
            claim(program_id, accounts, ticket_index, numbers, &proof)
        }
        PoolInstruction::Settle => settle(program_id, accounts),
        PoolInstruction::Payout => payout(program_id, accounts),
        PoolInstruction::WithdrawCreatorFees { amount } => withdraw(program_id, accounts, amount),
        PoolInstruction::Retire => retire(program_id, accounts),
        PoolInstruction::CloseRound => close_round(program_id, accounts),
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────

fn ovf() -> ProgramError {
    PoolError::MathOverflow.into()
}

fn add(a: u64, b: u64) -> Result<u64, ProgramError> {
    a.checked_add(b).ok_or_else(ovf)
}

fn sub(a: u64, b: u64) -> Result<u64, ProgramError> {
    a.checked_sub(b).ok_or_else(ovf)
}

fn require_signer(ai: &AccountInfo) -> ProgramResult {
    if ai.is_signer {
        Ok(())
    } else {
        Err(ProgramError::MissingRequiredSignature)
    }
}

fn require_system(ai: &AccountInfo) -> ProgramResult {
    if system_program::check_id(ai.key) {
        Ok(())
    } else {
        Err(PoolError::InvalidAccount.into())
    }
}

/// Program-owned pool at the PDA of the creator, nonce and canonical bump it
/// stores (the bump was derived with `find_program_address` at CreatePool).
fn load_pool(program_id: &Pubkey, ai: &AccountInfo) -> Result<Pool, ProgramError> {
    if ai.owner != program_id {
        return Err(PoolError::InvalidAccount.into());
    }
    let pool = Pool::unpack(&ai.try_borrow_data()?).ok_or(PoolError::InvalidAccount)?;
    let expected = Pubkey::create_program_address(
        &[POOL_SEED, &pool.creator, &pool.nonce.to_le_bytes(), &[pool.bump]],
        program_id,
    )
    .map_err(|_| PoolError::InvalidAccount)?;
    if expected != *ai.key {
        return Err(PoolError::InvalidAccount.into());
    }
    Ok(pool)
}

fn store_pool(ai: &AccountInfo, pool: &Pool) -> ProgramResult {
    pool.pack(&mut ai.try_borrow_mut_data()?);
    Ok(())
}

/// Program-owned round of `pool_key` at the PDA of its round id and stored
/// canonical bump (derived with `find_program_address` at Draw).
fn load_round(program_id: &Pubkey, ai: &AccountInfo, pool_key: &Pubkey) -> Result<Round, ProgramError> {
    if ai.owner != program_id {
        return Err(PoolError::InvalidAccount.into());
    }
    let round = Round::unpack(&ai.try_borrow_data()?).ok_or(PoolError::InvalidAccount)?;
    if round.pool != pool_key.to_bytes() {
        return Err(PoolError::InvalidAccount.into());
    }
    let expected = Pubkey::create_program_address(
        &[ROUND_SEED, pool_key.as_ref(), &round.round_id.to_le_bytes(), &[round.bump]],
        program_id,
    )
    .map_err(|_| PoolError::InvalidAccount)?;
    if expected != *ai.key {
        return Err(PoolError::InvalidAccount.into());
    }
    Ok(round)
}

fn store_round(ai: &AccountInfo, round: &Round) -> ProgramResult {
    round.pack(&mut ai.try_borrow_mut_data()?);
    Ok(())
}

/// Solvency invariant of the pool vault.
fn assert_solvent(ai: &AccountInfo, pool: &Pool) -> ProgramResult {
    let rent = Rent::get()?.minimum_balance(POOL_LEN);
    let need = pool.liabilities().ok_or_else(ovf)?.checked_add(rent).ok_or_else(ovf)?;
    if ai.lamports() < need {
        return Err(PoolError::Insolvent.into());
    }
    Ok(())
}

/// Create a PDA owned by this program. If the address already holds lamports
/// (anyone can transfer to it before it exists), top it up to rent exemption
/// and allocate + assign instead of create_account, so pre-funding cannot
/// block the creation.
fn create_pda<'a>(
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    program_id: &Pubkey,
    space: usize,
    seeds: &[&[u8]],
) -> ProgramResult {
    let need = Rent::get()?.minimum_balance(space);
    if target.lamports() == 0 {
        invoke_signed(
            &system_instruction::create_account(payer.key, target.key, need, space as u64, program_id),
            &[payer.clone(), target.clone(), system.clone()],
            &[seeds],
        )
    } else {
        if !system_program::check_id(target.owner) || !target.data_is_empty() {
            return Err(PoolError::AccountInUse.into());
        }
        let top_up = need.saturating_sub(target.lamports());
        if top_up > 0 {
            invoke(
                &system_instruction::transfer(payer.key, target.key, top_up),
                &[payer.clone(), target.clone(), system.clone()],
            )?;
        }
        invoke_signed(
            &system_instruction::allocate(target.key, space as u64),
            &[target.clone(), system.clone()],
            &[seeds],
        )?;
        invoke_signed(
            &system_instruction::assign(target.key, program_id),
            &[target.clone(), system.clone()],
            &[seeds],
        )
    }
}

/// Move `amount` lamports out of a program-owned account.
fn debit(from: &AccountInfo, to: &AccountInfo, amount: u64) -> ProgramResult {
    let f = from.lamports().checked_sub(amount).ok_or(PoolError::Insolvent)?;
    let t = to.lamports().checked_add(amount).ok_or_else(ovf)?;
    **from.try_borrow_mut_lamports()? = f;
    **to.try_borrow_mut_lamports()? = t;
    Ok(())
}

/// Close a program-owned account into `to`.
fn close_into(acct: &AccountInfo, to: &AccountInfo) -> ProgramResult {
    debit(acct, to, acct.lamports())?;
    acct.realloc(0, false)?;
    acct.assign(&system_program::ID);
    Ok(())
}

/// Open the next round at `slot` with an empty tree.
fn open_next_round(pool_ai: &AccountInfo, pool: &mut Pool, slot: u64) -> ProgramResult {
    pool.round_id = add(pool.round_id, 1)?;
    pool.round_open_slot = slot;
    pool.round_close_slot = add(slot, pool.params.round_slots)?;
    pool.ticket_count = 0;
    pool.root = ZEROS[TREE_DEPTH];
    pool_ai.try_borrow_mut_data()?[FRONTIER_OFFSET..FRONTIER_OFFSET + FRONTIER_LEN].fill(0);
    Ok(())
}

// ── 0 CreatePool ────────────────────────────────────────────────────────────

fn create_pool(program_id: &Pubkey, accounts: &[AccountInfo], nonce: u64, params: econ::PoolParams) -> ProgramResult {
    let it = &mut accounts.iter();
    let creator = next_account_info(it)?;
    let pool_ai = next_account_info(it)?;
    let system = next_account_info(it)?;
    require_signer(creator)?;
    require_system(system)?;

    let derived = econ::validate_params(&params).ok_or(PoolError::InvalidParams)?;
    let (expected, bump) = pool_address(program_id, creator.key, nonce);
    if expected != *pool_ai.key {
        return Err(PoolError::InvalidAccount.into());
    }
    let nonce_le = nonce.to_le_bytes();
    create_pda(
        creator,
        pool_ai,
        system,
        program_id,
        POOL_LEN,
        &[POOL_SEED, creator.key.as_ref(), &nonce_le, &[bump]],
    )?;
    // The seed goes straight into the jackpot; no instruction returns it.
    invoke(
        &system_instruction::transfer(creator.key, pool_ai.key, params.seed),
        &[creator.clone(), pool_ai.clone(), system.clone()],
    )?;

    let slot = Clock::get()?.slot;
    let pool = Pool {
        creator: creator.key.to_bytes(),
        nonce,
        params,
        retired: false,
        last_settle_won: false,
        has_pending: false,
        bump,
        combos: derived.combos,
        cap: derived.cap,
        recoup_volume: derived.recoup_volume,
        jackpot: params.seed,
        reserve: 0,
        creator_owed: 0,
        creator_withdrawn: 0,
        locked_prize: 0,
        owed_prizes: 0,
        total_sales: 0,
        pending_round_id: 0,
        round_id: 0,
        round_open_slot: slot,
        round_close_slot: add(slot, params.round_slots)?,
        ticket_count: 0,
        root: ZEROS[TREE_DEPTH],
    };
    store_pool(pool_ai, &pool)?;
    sol_log_data(&[b"pool", pool_ai.key.as_ref(), creator.key.as_ref(), &params.seed.to_le_bytes()]);
    assert_solvent(pool_ai, &pool)
}

// ── 1 BuyTicket ─────────────────────────────────────────────────────────────

fn buy_ticket(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    round_id: u64,
    owner: [u8; 32],
    numbers: [u8; 8],
) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let pool_ai = next_account_info(it)?;
    let system = next_account_info(it)?;
    require_signer(payer)?;
    require_system(system)?;

    let mut pool = load_pool(program_id, pool_ai)?;
    let slot = Clock::get()?.slot;
    if round_id != pool.round_id {
        return Err(PoolError::WrongRound.into());
    }
    if slot >= pool.round_close_slot {
        return Err(PoolError::SalesClosed.into());
    }
    if !econ::valid_numbers(&numbers, pool.params.pick_k, pool.params.range_n) {
        return Err(PoolError::InvalidNumbers.into());
    }
    if pool.ticket_count >= MAX_TICKETS {
        return Err(PoolError::RoundFull.into());
    }

    let price = pool.params.ticket_price;
    let split = econ::split_ticket(&pool.params, pool.recoup_volume, pool.total_sales, pool.retired)
        .ok_or_else(ovf)?;
    invoke(
        &system_instruction::transfer(payer.key, pool_ai.key, price),
        &[payer.clone(), pool_ai.clone(), system.clone()],
    )?;

    pool.creator_owed = add(pool.creator_owed, split.creator)?;
    let (to_jackpot, overflow) = econ::apply_cap(pool.jackpot, split.jackpot, pool.cap);
    pool.jackpot = add(pool.jackpot, to_jackpot)?;
    pool.reserve = add(add(pool.reserve, split.reserve)?, overflow)?;
    pool.total_sales = add(pool.total_sales, price)?;

    let index = pool.ticket_count;
    let leaf = tree::ticket_leaf(&pool_ai.key.to_bytes(), round_id, &owner, &numbers, index);
    pool.root = {
        let mut d = pool_ai.try_borrow_mut_data()?;
        tree::append(&mut d[FRONTIER_OFFSET..FRONTIER_OFFSET + FRONTIER_LEN], index, &leaf)
    };
    pool.ticket_count = add(index, 1)?;
    store_pool(pool_ai, &pool)?;

    // Indexers rebuild the round tree (and claim proofs) from these records.
    sol_log_data(&[b"ticket", &round_id.to_le_bytes(), &index.to_le_bytes(), &owner, &numbers, &leaf]);
    assert_solvent(pool_ai, &pool)
}

// ── 2 Draw ──────────────────────────────────────────────────────────────────

fn draw_round(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let cranker = next_account_info(it)?;
    let pool_ai = next_account_info(it)?;
    let round_ai = next_account_info(it)?;
    let hashes_ai = next_account_info(it)?;
    let system = next_account_info(it)?;
    require_signer(cranker)?;
    require_system(system)?;
    if !slot_hashes::check_id(hashes_ai.key) || !sysvar::check_id(hashes_ai.owner) {
        return Err(PoolError::InvalidSysvar.into());
    }

    let mut pool = load_pool(program_id, pool_ai)?;
    let clock = Clock::get()?;
    if pool.has_pending {
        return Err(PoolError::PreviousRoundUnsettled.into());
    }
    if clock.slot < pool.round_close_slot {
        return Err(PoolError::SalesOpen.into());
    }
    let round_id = pool.round_id;
    let (round_key, bump) = round_address(program_id, pool_ai.key, round_id);
    if round_key != *round_ai.key {
        return Err(PoolError::InvalidAccount.into());
    }

    if pool.ticket_count > 0 {
        let t0 = draw::first_target(pool.round_close_slot).ok_or_else(ovf)?;
        let sel = {
            let d = hashes_ai.try_borrow_data()?;
            draw::select(&d, t0).map_err(|e| match e {
                SelectError::Malformed => PoolError::InvalidSysvar,
                SelectError::TooEarly => PoolError::DrawTooEarly,
                SelectError::Overflow => PoolError::MathOverflow,
            })?
        };
        let pool_bytes = pool_ai.key.to_bytes();
        let entropy = draw::entropy(&pool_bytes, round_id, &sel, &pool.root, pool.ticket_count);
        let numbers = draw::draw_numbers(&entropy, pool.params.pick_k, pool.params.range_n);

        let round_le = round_id.to_le_bytes();
        create_pda(
            cranker,
            round_ai,
            system,
            program_id,
            ROUND_LEN,
            &[ROUND_SEED, pool_ai.key.as_ref(), &round_le, &[bump]],
        )?;
        let prize = pool.jackpot;
        let round = Round {
            pool: pool_bytes,
            round_id,
            status: ROUND_DRAWN,
            bump,
            attempt: sel.attempt,
            target_slot: sel.target_slot,
            used_slot: sel.used_slot,
            slot_hash: sel.hash,
            root: pool.root,
            ticket_count: pool.ticket_count,
            numbers,
            prize,
            window_end: add(clock.slot, pool.params.claim_window_slots)?,
            winners: 0,
            share: 0,
            paid: 0,
            rent_payer: cranker.key.to_bytes(),
            draw_slot: clock.slot,
        };
        store_round(round_ai, &round)?;
        // The prize is locked for this round's claimants until Settle.
        pool.locked_prize = add(pool.locked_prize, prize)?;
        pool.jackpot = 0;
        pool.has_pending = true;
        pool.pending_round_id = round_id;
        sol_log_data(&[
            b"draw",
            &round_le,
            &sel.attempt.to_le_bytes(),
            &sel.target_slot.to_le_bytes(),
            &sel.used_slot.to_le_bytes(),
            &numbers,
            &prize.to_le_bytes(),
        ]);
    } else {
        // No ticket: nothing to draw, the jackpot simply carries on.
        sol_log_data(&[b"empty", &round_id.to_le_bytes()]);
    }

    open_next_round(pool_ai, &mut pool, clock.slot)?;
    store_pool(pool_ai, &pool)?;
    assert_solvent(pool_ai, &pool)
}

// ── 3 Claim ─────────────────────────────────────────────────────────────────

fn claim(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    ticket_index: u64,
    numbers: [u8; 8],
    proof: &[[u8; 32]; TREE_DEPTH],
) -> ProgramResult {
    let it = &mut accounts.iter();
    let claimant = next_account_info(it)?;
    let pool_ai = next_account_info(it)?;
    let round_ai = next_account_info(it)?;
    let claim_ai = next_account_info(it)?;
    let system = next_account_info(it)?;
    require_signer(claimant)?;
    require_system(system)?;

    let pool = load_pool(program_id, pool_ai)?;
    let mut round = load_round(program_id, round_ai, pool_ai.key)?;
    if round.status != ROUND_DRAWN {
        return Err(PoolError::WrongStatus.into());
    }
    if Clock::get()?.slot > round.window_end {
        return Err(PoolError::ClaimWindowClosed.into());
    }
    if ticket_index >= round.ticket_count {
        return Err(PoolError::InvalidProof.into());
    }
    if numbers != round.numbers {
        return Err(PoolError::TicketNotWinning.into());
    }
    // The leaf commits to the owner key: only the owner can claim.
    let leaf = tree::ticket_leaf(&round.pool, round.round_id, &claimant.key.to_bytes(), &numbers, ticket_index);
    if tree::root_from_proof(&leaf, ticket_index, proof) != round.root {
        return Err(PoolError::InvalidProof.into());
    }

    let (claim_key, bump) = claim_address(program_id, pool_ai.key, round.round_id, ticket_index);
    if claim_key != *claim_ai.key {
        return Err(PoolError::InvalidAccount.into());
    }
    if claim_ai.owner == program_id {
        return Err(PoolError::AlreadyClaimed.into());
    }
    let round_le = round.round_id.to_le_bytes();
    let index_le = ticket_index.to_le_bytes();
    create_pda(
        claimant,
        claim_ai,
        system,
        program_id,
        CLAIM_LEN,
        &[CLAIM_SEED, pool_ai.key.as_ref(), &round_le, &index_le, &[bump]],
    )?;
    let record = ClaimRecord {
        pool: round.pool,
        round_id: round.round_id,
        ticket_index,
        owner: claimant.key.to_bytes(),
        bump,
    };
    record.pack(&mut claim_ai.try_borrow_mut_data()?);
    round.winners = add(round.winners, 1)?;
    store_round(round_ai, &round)?;
    sol_log_data(&[b"claim", &round_le, &index_le, claimant.key.as_ref()]);
    assert_solvent(pool_ai, &pool)
}

// ── 4 Settle ────────────────────────────────────────────────────────────────

fn settle(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let pool_ai = next_account_info(it)?;
    let round_ai = next_account_info(it)?;

    let mut pool = load_pool(program_id, pool_ai)?;
    let mut round = load_round(program_id, round_ai, pool_ai.key)?;
    if round.status != ROUND_DRAWN || !pool.has_pending || pool.pending_round_id != round.round_id {
        return Err(PoolError::WrongStatus.into());
    }
    if Clock::get()?.slot <= round.window_end {
        return Err(PoolError::ClaimWindowOpen.into());
    }
    pool.locked_prize = sub(pool.locked_prize, round.prize)?;
    if round.winners == 0 {
        // No claimed winner: the whole prize rolls over (cap overflow to reserve).
        let (j, o) = econ::apply_cap(pool.jackpot, round.prize, pool.cap);
        pool.jackpot = add(pool.jackpot, j)?;
        pool.reserve = add(pool.reserve, o)?;
        pool.last_settle_won = false;
    } else {
        let share = round.prize / round.winners;
        let total = share.checked_mul(round.winners).ok_or_else(ovf)?;
        let dust = sub(round.prize, total)?;
        pool.owed_prizes = add(pool.owed_prizes, total)?;
        let (j, o) = econ::apply_cap(pool.jackpot, dust, pool.cap);
        pool.jackpot = add(pool.jackpot, j)?;
        pool.reserve = add(pool.reserve, o)?;
        // The reserve seeds the next jackpot (up to the cap).
        let (seeded, _) = econ::apply_cap(pool.jackpot, pool.reserve, pool.cap);
        pool.jackpot = add(pool.jackpot, seeded)?;
        pool.reserve = sub(pool.reserve, seeded)?;
        pool.last_settle_won = true;
        round.share = share;
    }
    round.status = ROUND_SETTLED;
    pool.has_pending = false;
    store_round(round_ai, &round)?;
    store_pool(pool_ai, &pool)?;
    sol_log_data(&[b"settle", &round.round_id.to_le_bytes(), &round.winners.to_le_bytes(), &round.share.to_le_bytes()]);
    assert_solvent(pool_ai, &pool)
}

// ── 5 Payout ────────────────────────────────────────────────────────────────

fn payout(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let pool_ai = next_account_info(it)?;
    let round_ai = next_account_info(it)?;
    let claim_ai = next_account_info(it)?;
    let owner_ai = next_account_info(it)?;

    let mut pool = load_pool(program_id, pool_ai)?;
    let mut round = load_round(program_id, round_ai, pool_ai.key)?;
    if round.status != ROUND_SETTLED {
        return Err(PoolError::WrongStatus.into());
    }
    if claim_ai.owner != program_id {
        return Err(PoolError::ClaimMismatch.into());
    }
    let record = ClaimRecord::unpack(&claim_ai.try_borrow_data()?).ok_or(PoolError::ClaimMismatch)?;
    if record.pool != round.pool || record.round_id != round.round_id || record.owner != owner_ai.key.to_bytes() {
        return Err(PoolError::ClaimMismatch.into());
    }
    let claim_key = Pubkey::create_program_address(
        &[
            CLAIM_SEED,
            pool_ai.key.as_ref(),
            &round.round_id.to_le_bytes(),
            &record.ticket_index.to_le_bytes(),
            &[record.bump],
        ],
        program_id,
    )
    .map_err(|_| PoolError::InvalidAccount)?;
    if claim_key != *claim_ai.key {
        return Err(PoolError::InvalidAccount.into());
    }

    pool.owed_prizes = sub(pool.owed_prizes, round.share)?;
    round.paid = add(round.paid, 1)?;
    debit(pool_ai, owner_ai, round.share)?;
    // The record's rent goes back to the owner, who paid it at Claim.
    close_into(claim_ai, owner_ai)?;
    store_round(round_ai, &round)?;
    store_pool(pool_ai, &pool)?;
    sol_log_data(&[b"payout", &round.round_id.to_le_bytes(), &record.ticket_index.to_le_bytes(), &round.share.to_le_bytes()]);
    assert_solvent(pool_ai, &pool)
}

// ── 6 WithdrawCreatorFees ───────────────────────────────────────────────────

fn withdraw(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    let it = &mut accounts.iter();
    let creator = next_account_info(it)?;
    let pool_ai = next_account_info(it)?;
    require_signer(creator)?;
    let mut pool = load_pool(program_id, pool_ai)?;
    if creator.key.to_bytes() != pool.creator {
        return Err(PoolError::NotCreator.into());
    }
    if amount == 0 || amount > pool.creator_owed {
        return Err(PoolError::InsufficientFees.into());
    }
    pool.creator_owed = sub(pool.creator_owed, amount)?;
    pool.creator_withdrawn = add(pool.creator_withdrawn, amount)?;
    debit(pool_ai, creator, amount)?;
    store_pool(pool_ai, &pool)?;
    assert_solvent(pool_ai, &pool)
}

// ── 7 Retire ────────────────────────────────────────────────────────────────

fn retire(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let creator = next_account_info(it)?;
    let pool_ai = next_account_info(it)?;
    require_signer(creator)?;
    let mut pool = load_pool(program_id, pool_ai)?;
    if creator.key.to_bytes() != pool.creator {
        return Err(PoolError::NotCreator.into());
    }
    if pool.retired {
        return Err(PoolError::AlreadyRetired.into());
    }
    // Only after a winner was paid, or when every player-side lamport is
    // already jackpot: no round in its window, no unpaid winner share.
    if pool.has_pending || pool.owed_prizes != 0 || !(pool.last_settle_won || pool.reserve == 0) {
        return Err(PoolError::RetireNotAllowed.into());
    }
    let (moved, _) = econ::apply_cap(pool.jackpot, pool.reserve, pool.cap);
    pool.jackpot = add(pool.jackpot, moved)?;
    pool.reserve = sub(pool.reserve, moved)?;
    pool.retired = true;
    store_pool(pool_ai, &pool)?;
    sol_log_data(&[b"retire", pool_ai.key.as_ref()]);
    assert_solvent(pool_ai, &pool)
}

// ── 8 CloseRound ────────────────────────────────────────────────────────────

fn close_round(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let pool_ai = next_account_info(it)?;
    let round_ai = next_account_info(it)?;
    let rent_payer = next_account_info(it)?;
    let pool = load_pool(program_id, pool_ai)?;
    let round = load_round(program_id, round_ai, pool_ai.key)?;
    if round.status != ROUND_SETTLED {
        return Err(PoolError::WrongStatus.into());
    }
    if round.paid != round.winners {
        return Err(PoolError::RoundNotFinished.into());
    }
    if rent_payer.key.to_bytes() != round.rent_payer {
        return Err(PoolError::WrongRentPayer.into());
    }
    close_into(round_ai, rent_payer)?;
    assert_solvent(pool_ai, &pool)
}
