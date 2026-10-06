//! Instruction handlers.
//!
//! Prize solvency, checked after every instruction that moves prizes:
//! SOL prizes: `draw.lamports >= rent_exempt_minimum(len) + outstanding`;
//! SPL prizes: `vault.amount >= outstanding`, with
//! `outstanding = funded - paid - returned`. Prizes leave the vault only in
//! Claim (one slot's tier amount, to its winner), Reclaim (the refundable
//! amount, to the organizer, once the draw is complete) and Cancel (before any
//! randomness is fixed). The program has no fee, no treasury and no admin key.

use crate::{
    error::DrawError,
    instruction::{draw_address, CreateParams, DrawInstruction, LeafProof},
    state::{
        draw_len, Draw, Entrant, RoundInfo, Slot, Tier, DRAW_SEED, ENTRANT_LEN, ENTRANT_SEED,
        MAX_ALLOC_STEP, MAX_REDRAW_ROUNDS, MAX_ROUNDS, MAX_SLOTS, MAX_TIERS, MODE_LIST, MODE_OPEN, SLOT_CLAIMED,
        SLOT_FORFEITED, SLOT_PENDING, SLOT_VOID, SLOT_WON, STATUS_AWAIT_DRAW, STATUS_COMPLETE,
        STATUS_CREATED, STATUS_FUNDED, STATUS_RESOLVING, VAULT_SEED,
    },
    stream,
    sumtree::{self, FRONTIER_LEN, MAX_LIST_DEPTH, OPEN_DEPTH, PAIR_LEN, ZEROS},
    token::{self, TOKEN_PROGRAM_ID},
};
use null_draw_common::{
    pda::create_pda,
    slot_hashes::{self, SelectError},
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
    sysvar::{self, slot_hashes as slot_hashes_sysvar, Sysvar},
};

/// Claim window bounds in slots (about 1 minute to 7 days).
pub const MIN_CLAIM_WINDOW_SLOTS: u64 = 150;
pub const MAX_CLAIM_WINDOW_SLOTS: u64 = 1_512_000;
/// Unweighted open raffle: most leaves one Enter appends.
pub const MAX_ENTRIES_PER_IX: u32 = 8;
/// Most slots one Resolve processes (unweighted draws need no proof).
pub const MAX_RESOLVE_PER_IX: u8 = 24;
/// Open-raffle entry capacity.
pub const MAX_OPEN_LEAVES: u64 = 1 << OPEN_DEPTH;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match DrawInstruction::unpack(data).ok_or(DrawError::InvalidInstruction)? {
        DrawInstruction::CreateDraw { draw_id, params } => create_draw(program_id, accounts, draw_id, params),
        DrawInstruction::FundPrizes => fund_prizes(program_id, accounts),
        DrawInstruction::Enter { count, owner } => enter(program_id, accounts, count, owner),
        DrawInstruction::CommitList { root, total_weight, leaf_count, depth } => {
            commit_list(program_id, accounts, root, total_weight, leaf_count, depth)
        }
        DrawInstruction::Draw => draw(program_id, accounts),
        DrawInstruction::Resolve { max, proofs } => resolve(program_id, accounts, max, proofs),
        DrawInstruction::Claim { slot, proof } => claim(program_id, accounts, slot, proof),
        DrawInstruction::Advance => advance(program_id, accounts),
        DrawInstruction::Reclaim => reclaim(program_id, accounts),
        DrawInstruction::Close => close(program_id, accounts, false),
        DrawInstruction::Cancel => close(program_id, accounts, true),
        DrawInstruction::ProveEntry { proof } => prove_entry(program_id, accounts, proof),
        DrawInstruction::CloseEntrant => close_entrant(program_id, accounts),
        DrawInstruction::Extend => extend(program_id, accounts),
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────

fn ovf() -> ProgramError {
    DrawError::MathOverflow.into()
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
        Err(DrawError::InvalidAccount.into())
    }
}

fn require_token_program(ai: &AccountInfo) -> ProgramResult {
    if *ai.key == TOKEN_PROGRAM_ID {
        Ok(())
    } else {
        Err(DrawError::InvalidAccount.into())
    }
}

/// Program-owned draw at the PDA of its organizer, id and stored canonical bump.
fn load_draw(program_id: &Pubkey, ai: &AccountInfo) -> Result<Draw, ProgramError> {
    if ai.owner != program_id {
        return Err(DrawError::InvalidAccount.into());
    }
    let d = Draw::unpack(&ai.try_borrow_data()?).ok_or(DrawError::InvalidAccount)?;
    let expected =
        Pubkey::create_program_address(&[DRAW_SEED, &d.organizer, &d.draw_id.to_le_bytes(), &[d.bump]], program_id)
            .map_err(|_| DrawError::InvalidAccount)?;
    if expected != *ai.key {
        return Err(DrawError::InvalidAccount.into());
    }
    Ok(d)
}

fn store_draw(ai: &AccountInfo, d: &Draw) -> ProgramResult {
    d.pack(&mut ai.try_borrow_mut_data()?);
    Ok(())
}

/// The draw's SPL vault (address from the stored bump, owned by the Token program).
fn check_vault(program_id: &Pubkey, draw_key: &Pubkey, d: &Draw, ai: &AccountInfo) -> Result<token::TokenAccount, ProgramError> {
    let expected = Pubkey::create_program_address(&[VAULT_SEED, draw_key.as_ref(), &[d.vault_bump]], program_id)
        .map_err(|_| DrawError::InvalidAccount)?;
    if expected != *ai.key {
        return Err(DrawError::InvalidAccount.into());
    }
    let t = token::read_account(ai).ok_or(DrawError::InvalidTokenAccount)?;
    if t.mint != d.prize_mint || t.owner != draw_key.to_bytes() {
        return Err(DrawError::InvalidTokenAccount.into());
    }
    Ok(t)
}

/// Solvency of the prize vault (see the module docs).
fn assert_solvent(draw_ai: &AccountInfo, d: &Draw, vault: Option<&AccountInfo>) -> ProgramResult {
    let rent = Rent::get()?.minimum_balance(draw_ai.data_len());
    let outstanding = d.outstanding().ok_or_else(ovf)?;
    if d.is_sol_prize() {
        if draw_ai.lamports() < add(rent, outstanding)? {
            return Err(DrawError::Insolvent.into());
        }
    } else {
        if draw_ai.lamports() < rent {
            return Err(DrawError::Insolvent.into());
        }
        if let Some(v) = vault {
            let t = token::read_account(v).ok_or(DrawError::InvalidTokenAccount)?;
            if t.amount < outstanding {
                return Err(DrawError::Insolvent.into());
            }
        }
    }
    Ok(())
}

/// Move `amount` lamports out of a program-owned account.
fn debit(from: &AccountInfo, to: &AccountInfo, amount: u64) -> ProgramResult {
    let f = from.lamports().checked_sub(amount).ok_or(DrawError::Insolvent)?;
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

/// Pay `amount` of the prize asset from the vault (SOL: the draw account) to
/// `dest` (SOL: a wallet; SPL: a token account checked by the caller).
fn pay_prize<'a>(
    d: &Draw,
    draw_ai: &AccountInfo<'a>,
    dest: &AccountInfo<'a>,
    spl: Option<(&AccountInfo<'a>, &AccountInfo<'a>)>,
    amount: u64,
) -> ProgramResult {
    if amount == 0 {
        return Ok(());
    }
    match spl {
        None => debit(draw_ai, dest, amount),
        Some((vault, token_program)) => invoke_signed(
            &token::transfer(vault.key, dest.key, draw_ai.key, amount),
            &[vault.clone(), dest.clone(), draw_ai.clone(), token_program.clone()],
            &[&[DRAW_SEED, &d.organizer, &d.draw_id.to_le_bytes(), &[d.bump]]],
        ),
    }
}

/// The amount one slot of tier `t` pays.
fn tier_amount(d: &Draw, t: u8) -> Result<u64, ProgramError> {
    d.tiers.get(t as usize).map(|x| x.amount).ok_or_else(|| DrawError::InvalidAccount.into())
}

fn validate_create(p: &CreateParams, now: u64) -> Option<(u64, usize)> {
    if p.mode > MODE_LIST
        || p.redraw_rounds > MAX_REDRAW_ROUNDS
        || p.tiers.is_empty()
        || p.tiers.len() > MAX_TIERS
        || p.claim_window_slots < MIN_CLAIM_WINDOW_SLOTS
        || p.claim_window_slots > MAX_CLAIM_WINDOW_SLOTS
    {
        return None;
    }
    if p.mode == MODE_OPEN {
        if p.close_slot <= now {
            return None;
        }
    } else if p.entry_price != 0 || p.wallet_cap != 0 || p.close_slot != 0 || p.entry_mint != [0u8; 32] {
        return None;
    }
    let mut prizes: u64 = 0;
    let mut total: u64 = 0;
    for t in &p.tiers {
        if t.count == 0 || t.amount == 0 {
            return None;
        }
        prizes = prizes.checked_add(t.count as u64)?;
        total = total.checked_add((t.count as u64).checked_mul(t.amount)?)?;
    }
    let capacity = prizes.checked_mul(1 + p.redraw_rounds as u64)?;
    if capacity > MAX_SLOTS as u64 {
        return None;
    }
    Some((total, capacity as usize))
}

// ── 0 CreateDraw ────────────────────────────────────────────────────────────

fn create_draw(program_id: &Pubkey, accounts: &[AccountInfo], draw_id: u64, p: CreateParams) -> ProgramResult {
    let it = &mut accounts.iter();
    let organizer = next_account_info(it)?;
    let draw_ai = next_account_info(it)?;
    let system = next_account_info(it)?;
    require_signer(organizer)?;
    require_system(system)?;
    let now = Clock::get()?.slot;
    let (total_prize, capacity) = validate_create(&p, now).ok_or(DrawError::InvalidParams)?;

    let (expected, bump) = draw_address(program_id, organizer.key, draw_id);
    if expected != *draw_ai.key {
        return Err(DrawError::InvalidAccount.into());
    }
    let id_le = draw_id.to_le_bytes();
    // One CPI allocation is at most 10 KiB: larger draws grow with Extend.
    let len = draw_len(p.mode, capacity).min(MAX_ALLOC_STEP);
    create_pda(
        organizer,
        draw_ai,
        system,
        program_id,
        len,
        &[DRAW_SEED, organizer.key.as_ref(), &id_le, &[bump]],
        DrawError::AccountInUse.into(),
    )?;

    let mut vault_bump = 0u8;
    if p.prize_mint != [0u8; 32] {
        let vault = next_account_info(it)?;
        let mint = next_account_info(it)?;
        let token_program = next_account_info(it)?;
        require_token_program(token_program)?;
        if mint.key.to_bytes() != p.prize_mint || *mint.owner != TOKEN_PROGRAM_ID {
            return Err(DrawError::InvalidTokenAccount.into());
        }
        let (vk, vb) = Pubkey::find_program_address(&[VAULT_SEED, draw_ai.key.as_ref()], program_id);
        if vk != *vault.key {
            return Err(DrawError::InvalidAccount.into());
        }
        vault_bump = vb;
        create_pda(
            organizer,
            vault,
            system,
            &TOKEN_PROGRAM_ID,
            token::ACCOUNT_LEN,
            &[VAULT_SEED, draw_ai.key.as_ref(), &[vb]],
            DrawError::AccountInUse.into(),
        )?;
        invoke(
            &token::initialize_account3(vault.key, mint.key, draw_ai.key),
            &[vault.clone(), mint.clone(), token_program.clone()],
        )?;
    }

    let mut tiers = [Tier::default(); MAX_TIERS];
    tiers[..p.tiers.len()].copy_from_slice(&p.tiers);
    let mut rounds = [RoundInfo::default(); MAX_ROUNDS];
    if p.mode == MODE_OPEN {
        rounds[0].first_target = slot_hashes::first_target(p.close_slot).ok_or_else(ovf)?;
    }
    let prizes = (capacity / (1 + p.redraw_rounds as usize)) as u16;
    let d = Draw {
        organizer: organizer.key.to_bytes(),
        draw_id,
        bump,
        vault_bump,
        mode: p.mode,
        weighted: p.weighted,
        status: STATUS_CREATED,
        round: 0,
        redraw_rounds: p.redraw_rounds,
        tier_count: p.tiers.len() as u8,
        depth: if p.mode == MODE_OPEN { OPEN_DEPTH as u8 } else { 0 },
        won_count: 0,
        prize_mint: p.prize_mint,
        entry_mint: p.entry_mint,
        fee_dest: p.fee_dest,
        entry_price: p.entry_price,
        wallet_cap: p.wallet_cap,
        close_slot: p.close_slot,
        claim_window_slots: p.claim_window_slots,
        tiers,
        total_prize,
        funded: 0,
        paid: 0,
        returned: 0,
        refundable: 0,
        root: if p.mode == MODE_OPEN { ZEROS[OPEN_DEPTH] } else { [0u8; 32] },
        total_weight: 0,
        leaf_count: 0,
        commit_slot: 0,
        won_weight: 0,
        capacity: capacity as u16,
        slot_count: prizes,
        next_slot: 0,
        round_first_slot: 0,
        window_end: 0,
        rounds,
    };
    d.pack(&mut draw_ai.try_borrow_mut_data()?);
    sol_log_data(&[b"create", draw_ai.key.as_ref(), organizer.key.as_ref(), &total_prize.to_le_bytes()]);
    assert_solvent(draw_ai, &d, None)
}

// ── 1 FundPrizes ────────────────────────────────────────────────────────────

fn fund_prizes(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let funder = next_account_info(it)?;
    let draw_ai = next_account_info(it)?;
    let system = next_account_info(it)?;
    require_signer(funder)?;
    require_system(system)?;
    let mut d = load_draw(program_id, draw_ai)?;
    if d.status != STATUS_CREATED {
        return Err(DrawError::WrongStatus.into());
    }
    if draw_ai.data_len() != d.len() {
        return Err(DrawError::AccountNotExtended.into());
    }
    let amount = d.total_prize;
    let mut vault_ai = None;
    if d.is_sol_prize() {
        invoke(
            &system_instruction::transfer(funder.key, draw_ai.key, amount),
            &[funder.clone(), draw_ai.clone(), system.clone()],
        )?;
    } else {
        let funder_token = next_account_info(it)?;
        let vault = next_account_info(it)?;
        let token_program = next_account_info(it)?;
        require_token_program(token_program)?;
        check_vault(program_id, draw_ai.key, &d, vault)?;
        invoke(
            &token::transfer(funder_token.key, vault.key, funder.key, amount),
            &[funder_token.clone(), vault.clone(), funder.clone(), token_program.clone()],
        )?;
        vault_ai = Some(vault);
    }
    d.funded = amount;
    d.status = STATUS_FUNDED;
    {
        let mut data = draw_ai.try_borrow_mut_data()?;
        d.pack(&mut data);
        // Round-0 slots in tier order: the winner of slot 0 gets tier 0.
        let mut j = 0usize;
        for ti in 0..d.tier_count as usize {
            for _ in 0..d.tiers[ti].count {
                d.write_slot(&mut data, j, &Slot { tier: ti as u8, status: SLOT_PENDING, round: 0, ..Slot::default() });
                j += 1;
            }
        }
    }
    sol_log_data(&[b"fund", draw_ai.key.as_ref(), funder.key.as_ref(), &amount.to_le_bytes()]);
    assert_solvent(draw_ai, &d, vault_ai)
}

// ── 2 Enter ─────────────────────────────────────────────────────────────────

fn enter(program_id: &Pubkey, accounts: &[AccountInfo], count: u32, owner: [u8; 32]) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let draw_ai = next_account_info(it)?;
    let system = next_account_info(it)?;
    let entrant_ai = next_account_info(it)?;
    let fee_dest = next_account_info(it)?;
    require_signer(payer)?;
    require_system(system)?;
    let mut d = load_draw(program_id, draw_ai)?;
    if d.mode != MODE_OPEN || d.status != STATUS_FUNDED {
        return Err(DrawError::WrongStatus.into());
    }
    if Clock::get()?.slot >= d.close_slot {
        return Err(DrawError::EntriesClosed.into());
    }
    if count == 0 {
        return Err(DrawError::ZeroWeight.into());
    }
    let price = d.entry_price.checked_mul(count as u64).ok_or_else(ovf)?;
    if price > 0 && fee_dest.key.to_bytes() != d.fee_dest {
        return Err(DrawError::InvalidAccount.into());
    }
    if !d.weighted && count > MAX_ENTRIES_PER_IX {
        return Err(DrawError::InvalidParams.into());
    }
    let leaves = if d.weighted { 1 } else { count as u64 };
    if add(d.leaf_count, leaves)? > MAX_OPEN_LEAVES {
        return Err(DrawError::TreeFull.into());
    }

    // Per-wallet cap.
    if d.wallet_cap > 0 {
        let (ek, eb) = Pubkey::find_program_address(&[ENTRANT_SEED, draw_ai.key.as_ref(), &owner], program_id);
        if ek != *entrant_ai.key {
            return Err(DrawError::InvalidAccount.into());
        }
        let mut rec = if entrant_ai.owner == program_id {
            let r = Entrant::unpack(&entrant_ai.try_borrow_data()?).ok_or(DrawError::InvalidAccount)?;
            if r.draw != draw_ai.key.to_bytes() || r.owner != owner {
                return Err(DrawError::InvalidAccount.into());
            }
            r
        } else {
            create_pda(
                payer,
                entrant_ai,
                system,
                program_id,
                ENTRANT_LEN,
                &[ENTRANT_SEED, draw_ai.key.as_ref(), &owner, &[eb]],
                DrawError::AccountInUse.into(),
            )?;
            Entrant { draw: draw_ai.key.to_bytes(), owner, count: 0, bump: eb }
        };
        rec.count = add(rec.count, count as u64)?;
        if rec.count > d.wallet_cap {
            return Err(DrawError::WalletCapExceeded.into());
        }
        rec.pack(&mut entrant_ai.try_borrow_mut_data()?);
    }

    // Entry fee, straight to the organizer's fee destination.
    if price > 0 {
        if d.is_sol_entry() {
            invoke(
                &system_instruction::transfer(payer.key, fee_dest.key, price),
                &[payer.clone(), fee_dest.clone(), system.clone()],
            )?;
        } else {
            let payer_token = next_account_info(it)?;
            let token_program = next_account_info(it)?;
            require_token_program(token_program)?;
            let t = token::read_account(payer_token).ok_or(DrawError::InvalidTokenAccount)?;
            if t.mint != d.entry_mint {
                return Err(DrawError::InvalidTokenAccount.into());
            }
            invoke(
                &token::transfer(payer_token.key, fee_dest.key, payer.key, price),
                &[payer_token.clone(), fee_dest.clone(), payer.clone(), token_program.clone()],
            )?;
        }
    }

    // Append the leaves; each log line is the entrant's participation receipt.
    let draw_bytes = draw_ai.key.to_bytes();
    let weight = if d.weighted { count as u64 } else { 1 };
    let leaf = sumtree::leaf(&draw_bytes, &owner, weight);
    {
        let mut data = draw_ai.try_borrow_mut_data()?;
        let f = d.frontier_offset();
        for _ in 0..leaves {
            let index = d.leaf_count;
            let (root, total) = sumtree::append(&mut data[f..f + FRONTIER_LEN], index, &(leaf, weight)).ok_or_else(ovf)?;
            d.root = root;
            d.total_weight = add(d.total_weight, weight)?;
            debug_assert_eq!(total, d.total_weight);
            d.leaf_count = add(index, 1)?;
            sol_log_data(&[b"entry", &index.to_le_bytes(), &owner, &weight.to_le_bytes(), &leaf]);
        }
        d.pack(&mut data);
    }
    Ok(())
}

// ── 3 CommitList ────────────────────────────────────────────────────────────

fn commit_list(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    root: [u8; 32],
    total_weight: u64,
    leaf_count: u64,
    depth: u8,
) -> ProgramResult {
    let it = &mut accounts.iter();
    let organizer = next_account_info(it)?;
    let draw_ai = next_account_info(it)?;
    require_signer(organizer)?;
    let mut d = load_draw(program_id, draw_ai)?;
    if organizer.key.to_bytes() != d.organizer {
        return Err(DrawError::NotOrganizer.into());
    }
    // Prizes are escrowed before the target slot is fixed: the organizer
    // never gets a fund-or-walk-away option after seeing the outcome.
    if d.mode != MODE_LIST || d.status != STATUS_FUNDED {
        return Err(DrawError::WrongStatus.into());
    }
    if depth == 0
        || depth as usize > MAX_LIST_DEPTH
        || leaf_count == 0
        || leaf_count > (1u64 << depth)
        || total_weight == 0
        || (!d.weighted && total_weight != leaf_count)
    {
        return Err(DrawError::InvalidParams.into());
    }
    let now = Clock::get()?.slot;
    d.root = root;
    d.total_weight = total_weight;
    d.leaf_count = leaf_count;
    d.depth = depth;
    d.commit_slot = now;
    d.rounds[0].first_target = slot_hashes::first_target(now).ok_or_else(ovf)?;
    d.status = STATUS_AWAIT_DRAW;
    store_draw(draw_ai, &d)?;
    sol_log_data(&[b"commit", &root, &total_weight.to_le_bytes(), &leaf_count.to_le_bytes(), &[depth]]);
    Ok(())
}

// ── 4 Draw ──────────────────────────────────────────────────────────────────

fn draw(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let draw_ai = next_account_info(it)?;
    let hashes_ai = next_account_info(it)?;
    if !slot_hashes_sysvar::check_id(hashes_ai.key) || !sysvar::check_id(hashes_ai.owner) {
        return Err(DrawError::InvalidSysvar.into());
    }
    let mut d = load_draw(program_id, draw_ai)?;
    let now = Clock::get()?.slot;
    match d.status {
        STATUS_FUNDED if d.mode == MODE_OPEN => {
            if now < d.close_slot {
                return Err(DrawError::EntriesOpen.into());
            }
            if d.leaf_count == 0 {
                // Nobody entered: every prize goes back to the organizer.
                let mut data = draw_ai.try_borrow_mut_data()?;
                for j in 0..d.slot_count as usize {
                    let mut s = d.read_slot(&data, j);
                    s.status = SLOT_VOID;
                    d.write_slot(&mut data, j, &s);
                }
                d.next_slot = d.slot_count;
                d.refundable = d.total_prize;
                d.status = STATUS_COMPLETE;
                d.pack(&mut data);
                sol_log_data(&[b"empty", draw_ai.key.as_ref()]);
                return Ok(());
            }
        }
        STATUS_AWAIT_DRAW => {}
        _ => return Err(DrawError::WrongStatus.into()),
    }
    let r = d.round as usize;
    let t0 = d.rounds[r].first_target;
    let sel = {
        let data = hashes_ai.try_borrow_data()?;
        slot_hashes::select(&data, t0).map_err(|e| match e {
            SelectError::Malformed => DrawError::InvalidSysvar,
            SelectError::TooEarly => DrawError::DrawTooEarly,
            SelectError::Overflow => DrawError::MathOverflow,
        })?
    };
    let seed = stream::seed(
        &draw_ai.key.to_bytes(),
        d.round,
        sel.target_slot,
        sel.used_slot,
        &sel.hash,
        &d.root,
        d.total_weight,
        d.leaf_count,
    );
    d.rounds[r] = RoundInfo {
        first_target: t0,
        target_slot: sel.target_slot,
        used_slot: sel.used_slot,
        attempt: sel.attempt,
        slot_hash: sel.hash,
        seed,
    };
    d.status = STATUS_RESOLVING;
    store_draw(draw_ai, &d)?;
    sol_log_data(&[
        b"draw",
        &[d.round],
        &sel.attempt.to_le_bytes(),
        &sel.target_slot.to_le_bytes(),
        &sel.used_slot.to_le_bytes(),
        &sel.hash,
        &seed,
    ]);
    Ok(())
}

// ── 5 Resolve ───────────────────────────────────────────────────────────────

fn resolve(program_id: &Pubkey, accounts: &[AccountInfo], max: u8, proofs: Vec<LeafProof>) -> ProgramResult {
    let it = &mut accounts.iter();
    let draw_ai = next_account_info(it)?;
    let mut d = load_draw(program_id, draw_ai)?;
    if d.status != STATUS_RESOLVING {
        return Err(DrawError::WrongStatus.into());
    }
    if d.next_slot >= d.slot_count {
        return Err(DrawError::NothingToResolve.into());
    }
    let max = if max == 0 || max > MAX_RESOLVE_PER_IX { MAX_RESOLVE_PER_IX } else { max };
    let seed = d.rounds[d.round as usize].seed;
    let draw_bytes = draw_ai.key.to_bytes();
    let mut proofs = proofs.into_iter();
    let mut done = 0u8;
    let now = Clock::get()?.slot;
    let mut data = draw_ai.try_borrow_mut_data()?;
    while d.next_slot < d.slot_count && done < max {
        let j = d.next_slot as usize;
        let mut s = d.read_slot(&data, j);
        let remaining = sub(d.total_weight, d.won_weight)?;
        if remaining == 0 {
            // Every entry has won: the prize goes back to the organizer.
            s.status = SLOT_VOID;
            d.write_slot(&mut data, j, &s);
            d.refundable = add(d.refundable, tier_amount(&d, s.tier)?)?;
            d.next_slot += 1;
            done += 1;
            sol_log_data(&[b"void", &(j as u16).to_le_bytes()]);
            continue;
        }
        let u = stream::point(&seed, j as u64, remaining);
        let p = stream::remap(u, (0..d.won_count as usize).map(|k| d.won_at(&data, k))).ok_or_else(ovf)?;
        if d.weighted {
            let Some(pr) = proofs.next() else {
                if done == 0 {
                    return Err(DrawError::MissingProof.into());
                }
                break;
            };
            if pr.path.len() != d.depth as usize * PAIR_LEN {
                return Err(DrawError::InvalidProof.into());
            }
            if pr.weight == 0 {
                return Err(DrawError::ZeroWeight.into());
            }
            let leaf = sumtree::leaf(&draw_bytes, &pr.wallet, pr.weight);
            let start = sumtree::verify(
                &d.root,
                d.total_weight,
                d.depth as usize,
                d.leaf_count,
                pr.leaf_index,
                &leaf,
                pr.weight,
                &pr.path,
            )
            .ok_or(DrawError::InvalidProof)?;
            if p < start || p - start >= pr.weight {
                return Err(DrawError::PointNotInLeaf.into());
            }
            s.start = start;
            s.weight = pr.weight;
            s.leaf_index = pr.leaf_index;
            s.wallet = pr.wallet;
        } else {
            // Every leaf has weight 1: the point is the leaf index.
            s.start = p;
            s.weight = 1;
            s.leaf_index = p;
            s.wallet = [0u8; 32];
        }
        s.status = SLOT_WON;
        d.write_slot(&mut data, j, &s);
        d.won_insert(&mut data, s.start, s.weight);
        d.won_weight = add(d.won_weight, s.weight)?;
        d.next_slot += 1;
        done += 1;
        sol_log_data(&[
            b"winner",
            &(j as u16).to_le_bytes(),
            &[s.round, s.tier],
            &u.to_le_bytes(),
            &p.to_le_bytes(),
            &s.leaf_index.to_le_bytes(),
            &s.start.to_le_bytes(),
            &s.weight.to_le_bytes(),
            &s.wallet,
        ]);
    }
    if proofs.next().is_some() {
        return Err(DrawError::InvalidInstruction.into());
    }
    if d.next_slot == d.slot_count {
        d.window_end = add(now, d.claim_window_slots)?;
    }
    d.pack(&mut data);
    Ok(())
}

// ── 6 Claim ─────────────────────────────────────────────────────────────────

fn claim(program_id: &Pubkey, accounts: &[AccountInfo], slot: u16, proof: Option<LeafProof>) -> ProgramResult {
    let it = &mut accounts.iter();
    let winner = next_account_info(it)?;
    let draw_ai = next_account_info(it)?;
    require_signer(winner)?;
    let mut d = load_draw(program_id, draw_ai)?;
    if d.status != STATUS_RESOLVING || slot >= d.next_slot {
        return Err(DrawError::WrongStatus.into());
    }
    let j = slot as usize;
    let mut s = d.read_slot(&draw_ai.try_borrow_data()?, j);
    if s.status == SLOT_CLAIMED {
        return Err(DrawError::AlreadyClaimed.into());
    }
    if s.status != SLOT_WON || s.round != d.round {
        return Err(DrawError::NotWinner.into());
    }
    if d.window_end != 0 && Clock::get()?.slot > d.window_end {
        return Err(DrawError::ClaimWindowClosed.into());
    }
    let me = winner.key.to_bytes();
    if s.wallet == [0u8; 32] {
        // Unweighted slot: the winner proves the drawn leaf is theirs.
        let pr = proof.ok_or(DrawError::MissingProof)?;
        if pr.leaf_index != s.leaf_index || pr.wallet != me || pr.weight != 1 {
            return Err(DrawError::NotWinner.into());
        }
        if pr.path.len() != d.depth as usize * PAIR_LEN {
            return Err(DrawError::InvalidProof.into());
        }
        let leaf = sumtree::leaf(&draw_ai.key.to_bytes(), &me, 1);
        let start = sumtree::verify(&d.root, d.total_weight, d.depth as usize, d.leaf_count, pr.leaf_index, &leaf, 1, &pr.path)
            .ok_or(DrawError::InvalidProof)?;
        if start != s.start {
            return Err(DrawError::InvalidProof.into());
        }
        s.wallet = me;
    } else if s.wallet != me {
        return Err(DrawError::NotWinner.into());
    }
    let amount = tier_amount(&d, s.tier)?;
    let mut vault_ai = None;
    if d.is_sol_prize() {
        pay_prize(&d, draw_ai, winner, None, amount)?;
    } else {
        let dest = next_account_info(it)?;
        let vault = next_account_info(it)?;
        let token_program = next_account_info(it)?;
        require_token_program(token_program)?;
        check_vault(program_id, draw_ai.key, &d, vault)?;
        let t = token::read_account(dest).ok_or(DrawError::InvalidTokenAccount)?;
        if t.mint != d.prize_mint || t.owner != me {
            return Err(DrawError::InvalidTokenAccount.into());
        }
        pay_prize(&d, draw_ai, dest, Some((vault, token_program)), amount)?;
        vault_ai = Some(vault);
    }
    s.status = SLOT_CLAIMED;
    d.paid = add(d.paid, amount)?;
    {
        let mut data = draw_ai.try_borrow_mut_data()?;
        d.write_slot(&mut data, j, &s);
        d.pack(&mut data);
    }
    sol_log_data(&[b"claim", &slot.to_le_bytes(), &me, &amount.to_le_bytes()]);
    assert_solvent(draw_ai, &d, vault_ai)
}

// ── 7 Advance ───────────────────────────────────────────────────────────────

fn advance(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let draw_ai = next_account_info(it)?;
    let mut d = load_draw(program_id, draw_ai)?;
    if d.status != STATUS_RESOLVING || d.next_slot != d.slot_count || d.window_end == 0 {
        return Err(DrawError::WrongStatus.into());
    }
    if Clock::get()?.slot <= d.window_end {
        return Err(DrawError::ClaimWindowOpen.into());
    }
    let mut data = draw_ai.try_borrow_mut_data()?;
    let mut forfeited: Vec<u8> = Vec::new();
    for j in d.round_first_slot as usize..d.slot_count as usize {
        let mut s = d.read_slot(&data, j);
        if s.status == SLOT_WON {
            s.status = SLOT_FORFEITED;
            d.write_slot(&mut data, j, &s);
            forfeited.push(s.tier);
        }
    }
    let remaining = sub(d.total_weight, d.won_weight)?;
    if !forfeited.is_empty() && d.round < d.redraw_rounds && remaining > 0 {
        // Re-draw the unclaimed prizes among the entries that have not won,
        // with the hash of a slot fixed now: after the window, so nobody
        // could know it when deciding whether to claim.
        let base = d.slot_count as usize;
        for (k, tier) in forfeited.iter().enumerate() {
            d.write_slot(&mut data, base + k, &Slot { tier: *tier, status: SLOT_PENDING, round: d.round + 1, ..Slot::default() });
        }
        d.round += 1;
        d.round_first_slot = d.slot_count;
        d.slot_count += forfeited.len() as u16;
        d.rounds[d.round as usize].first_target = slot_hashes::first_target(d.window_end).ok_or_else(ovf)?;
        d.window_end = 0;
        d.status = STATUS_AWAIT_DRAW;
    } else {
        for tier in &forfeited {
            d.refundable = add(d.refundable, tier_amount(&d, *tier)?)?;
        }
        d.status = STATUS_COMPLETE;
    }
    d.pack(&mut data);
    sol_log_data(&[b"advance", &[d.round, d.status], &(forfeited.len() as u16).to_le_bytes()]);
    Ok(())
}

// ── 8 Reclaim ───────────────────────────────────────────────────────────────

fn reclaim(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let organizer = next_account_info(it)?;
    let draw_ai = next_account_info(it)?;
    require_signer(organizer)?;
    let mut d = load_draw(program_id, draw_ai)?;
    if organizer.key.to_bytes() != d.organizer {
        return Err(DrawError::NotOrganizer.into());
    }
    if d.status != STATUS_COMPLETE || d.refundable == 0 {
        return Err(DrawError::WrongStatus.into());
    }
    let amount = d.refundable;
    let mut vault_ai = None;
    if d.is_sol_prize() {
        pay_prize(&d, draw_ai, organizer, None, amount)?;
    } else {
        let dest = next_account_info(it)?;
        let vault = next_account_info(it)?;
        let token_program = next_account_info(it)?;
        require_token_program(token_program)?;
        check_vault(program_id, draw_ai.key, &d, vault)?;
        let t = token::read_account(dest).ok_or(DrawError::InvalidTokenAccount)?;
        if t.mint != d.prize_mint || t.owner != d.organizer {
            return Err(DrawError::InvalidTokenAccount.into());
        }
        pay_prize(&d, draw_ai, dest, Some((vault, token_program)), amount)?;
        vault_ai = Some(vault);
    }
    d.returned = add(d.returned, amount)?;
    d.refundable = 0;
    store_draw(draw_ai, &d)?;
    sol_log_data(&[b"reclaim", &amount.to_le_bytes()]);
    assert_solvent(draw_ai, &d, vault_ai)
}

// ── 9 Close / 10 Cancel ─────────────────────────────────────────────────────

fn close(program_id: &Pubkey, accounts: &[AccountInfo], cancel: bool) -> ProgramResult {
    let it = &mut accounts.iter();
    let organizer = next_account_info(it)?;
    let draw_ai = next_account_info(it)?;
    require_signer(organizer)?;
    let d = load_draw(program_id, draw_ai)?;
    if organizer.key.to_bytes() != d.organizer {
        return Err(DrawError::NotOrganizer.into());
    }
    let allowed = if cancel {
        // Before any randomness or entry is fixed.
        d.status == STATUS_CREATED || (d.status == STATUS_FUNDED && d.mode == MODE_LIST)
    } else {
        d.status == STATUS_COMPLETE && d.refundable == 0 && d.outstanding() == Some(0)
    };
    if !allowed {
        return Err(DrawError::WrongStatus.into());
    }
    if !d.is_sol_prize() {
        let dest = next_account_info(it)?;
        let vault = next_account_info(it)?;
        let token_program = next_account_info(it)?;
        require_token_program(token_program)?;
        let v = check_vault(program_id, draw_ai.key, &d, vault)?;
        let t = token::read_account(dest).ok_or(DrawError::InvalidTokenAccount)?;
        if t.mint != d.prize_mint || t.owner != d.organizer {
            return Err(DrawError::InvalidTokenAccount.into());
        }
        let seeds: &[&[u8]] = &[DRAW_SEED, &d.organizer, &d.draw_id.to_le_bytes(), &[d.bump]];
        if v.amount > 0 {
            invoke_signed(
                &token::transfer(vault.key, dest.key, draw_ai.key, v.amount),
                &[vault.clone(), dest.clone(), draw_ai.clone(), token_program.clone()],
                &[seeds],
            )?;
        }
        invoke_signed(
            &token::close_account(vault.key, organizer.key, draw_ai.key),
            &[vault.clone(), organizer.clone(), draw_ai.clone(), token_program.clone()],
            &[seeds],
        )?;
    }
    sol_log_data(&[if cancel { b"cancel".as_slice() } else { b"close".as_slice() }, draw_ai.key.as_ref()]);
    // SOL prizes still escrowed (Cancel after funding) go back with the rent.
    close_into(draw_ai, organizer)
}

// ── 11 ProveEntry ───────────────────────────────────────────────────────────

fn prove_entry(program_id: &Pubkey, accounts: &[AccountInfo], pr: LeafProof) -> ProgramResult {
    let it = &mut accounts.iter();
    let draw_ai = next_account_info(it)?;
    let d = load_draw(program_id, draw_ai)?;
    if d.depth == 0 || d.leaf_count == 0 {
        return Err(DrawError::WrongStatus.into());
    }
    if pr.weight == 0 {
        return Err(DrawError::ZeroWeight.into());
    }
    if pr.path.len() != d.depth as usize * PAIR_LEN {
        return Err(DrawError::InvalidProof.into());
    }
    let leaf = sumtree::leaf(&draw_ai.key.to_bytes(), &pr.wallet, pr.weight);
    let start = sumtree::verify(&d.root, d.total_weight, d.depth as usize, d.leaf_count, pr.leaf_index, &leaf, pr.weight, &pr.path)
        .ok_or(DrawError::InvalidProof)?;
    // The participation receipt: a log line, no account.
    sol_log_data(&[
        b"receipt",
        draw_ai.key.as_ref(),
        &pr.leaf_index.to_le_bytes(),
        &pr.wallet,
        &pr.weight.to_le_bytes(),
        &start.to_le_bytes(),
    ]);
    Ok(())
}

// ── 12 CloseEntrant ─────────────────────────────────────────────────────────

fn close_entrant(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let owner = next_account_info(it)?;
    let draw_ai = next_account_info(it)?;
    let entrant_ai = next_account_info(it)?;
    require_signer(owner)?;
    if entrant_ai.owner != program_id {
        return Err(DrawError::InvalidAccount.into());
    }
    let rec = Entrant::unpack(&entrant_ai.try_borrow_data()?).ok_or(DrawError::InvalidAccount)?;
    let expected = Pubkey::create_program_address(&[ENTRANT_SEED, &rec.draw, &rec.owner, &[rec.bump]], program_id)
        .map_err(|_| DrawError::InvalidAccount)?;
    if expected != *entrant_ai.key || rec.owner != owner.key.to_bytes() || rec.draw != draw_ai.key.to_bytes() {
        return Err(DrawError::InvalidAccount.into());
    }
    // While the draw exists, the record is needed until entries close.
    if draw_ai.owner == program_id {
        let d = load_draw(program_id, draw_ai)?;
        if d.status <= STATUS_FUNDED && Clock::get()?.slot < d.close_slot {
            return Err(DrawError::EntrantInUse.into());
        }
    }
    close_into(entrant_ai, owner)
}

// ── 13 Extend ───────────────────────────────────────────────────────────────

fn extend(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let draw_ai = next_account_info(it)?;
    let system = next_account_info(it)?;
    require_signer(payer)?;
    require_system(system)?;
    let d = load_draw(program_id, draw_ai)?;
    let full = d.len();
    let have = draw_ai.data_len();
    if d.status != STATUS_CREATED || have >= full {
        return Err(DrawError::WrongStatus.into());
    }
    let new_len = full.min(have + MAX_ALLOC_STEP);
    let need = Rent::get()?.minimum_balance(new_len).saturating_sub(draw_ai.lamports());
    if need > 0 {
        invoke(
            &system_instruction::transfer(payer.key, draw_ai.key, need),
            &[payer.clone(), draw_ai.clone(), system.clone()],
        )?;
    }
    draw_ai.realloc(new_len, true)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> CreateParams {
        CreateParams {
            mode: MODE_OPEN,
            weighted: false,
            redraw_rounds: 2,
            tiers: vec![Tier { count: 1, amount: 100 }, Tier { count: 5, amount: 10 }, Tier { count: 50, amount: 1 }],
            entry_price: 0,
            wallet_cap: 0,
            close_slot: 1_000,
            claim_window_slots: 150,
            prize_mint: [0; 32],
            entry_mint: [0; 32],
            fee_dest: [0; 32],
        }
    }

    #[test]
    fn create_bounds() {
        assert_eq!(validate_create(&params(), 10), Some((200, 168)));
        let bad = |f: fn(&mut CreateParams)| {
            let mut p = params();
            f(&mut p);
            validate_create(&p, 10).is_none()
        };
        assert!(bad(|p| p.mode = 2));
        assert!(bad(|p| p.redraw_rounds = 4));
        assert!(bad(|p| p.tiers.clear()));
        assert!(bad(|p| p.tiers[0].count = 0));
        assert!(bad(|p| p.tiers[0].amount = 0));
        assert!(bad(|p| p.tiers = vec![Tier { count: 1, amount: 1 }; 9]));
        assert!(bad(|p| p.tiers[2].count = 400)); // 406 * 3 > 1024
        assert!(bad(|p| p.close_slot = 10));
        assert!(bad(|p| p.claim_window_slots = 149));
        assert!(bad(|p| p.tiers[0].amount = u64::MAX));
        // List mode takes no entry price, cap, close slot or entry mint.
        assert!(bad(|p| { p.mode = MODE_LIST; }));
        let mut l = params();
        l.mode = MODE_LIST;
        l.close_slot = 0;
        assert!(validate_create(&l, 10).is_some());
        l.entry_price = 1;
        assert!(validate_create(&l, 10).is_none());
        // 1024 slots exactly is fine.
        let mut p = params();
        p.tiers = vec![Tier { count: 256, amount: 1 }];
        p.redraw_rounds = 3;
        assert_eq!(validate_create(&p, 10), Some((256, 1024)));
        let _ = (SLOT_CLAIMED, SLOT_FORFEITED);
    }
}
