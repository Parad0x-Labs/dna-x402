use crate::{
    ticket,
    error::LotteryError,
    instruction::{LotteryInstruction, TicketClaim},
    state::{
        CLAIM_NULLIFIER_DISC, CLAIM_NULLIFIER_SIZE,
        LOTTERY_CONFIG_DISC, LOTTERY_CONFIG_SIZE,
        ROUND_STATE_DISC, ROUND_STATE_SIZE,
        ClaimNullifier, LotteryConfig, RoundState, RoundStatus,
    },
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    hash::hashv,
    keccak,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

// The admin checks on round transitions (require_admin) and the ClaimJackpot
// winner binding apply in every build. The `mainnet` cargo feature used to switch
// ClaimJackpot between "first claimed nullifier wins" (default build) and "stored
// winner nullifier only"; it is kept as a no-op so existing build commands work.
//
// Every payout goes through ClaimJackpot and needs an anchored ticket leaf that
// commits to the claimant key: the drawn-numbers ticket of a Drawn round, or the
// selected ticket of a FallbackDrawn round. A Won round is closed.

/// FallbackDraw takes this many consecutive Drawn rounds.
const FALLBACK_ROUNDS: u8 = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Public entry-point
// ─────────────────────────────────────────────────────────────────────────────

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match LotteryInstruction::unpack(data)? {
        LotteryInstruction::InitLottery {
            ticket_price_null,
            house_fee_bps,
            numbers_count,
            numbers_range,
            fallback_after,
        } => process_init(
            program_id,
            accounts,
            ticket_price_null,
            house_fee_bps,
            numbers_count,
            numbers_range,
            fallback_after,
        ),

        LotteryInstruction::CommitRound { seed_commitment } => {
            process_commit(program_id, accounts, seed_commitment)
        }

        LotteryInstruction::AnchorTickets {
            tickets_root,
            ticket_count,
            total_null_deposited,
        } => process_anchor(program_id, accounts, tickets_root, ticket_count, total_null_deposited),

        LotteryInstruction::RevealDraw { seed } => process_reveal(program_id, accounts, seed),

        LotteryInstruction::FallbackDraw {
            seed,
            fallback_tickets_root,
            fallback_pool_size,
        } => process_fallback(program_id, accounts, seed, fallback_tickets_root, fallback_pool_size),

        LotteryInstruction::ClaimJackpot { winner_nullifier, ticket } => {
            process_claim(program_id, accounts, winner_nullifier, ticket)
        }
    }
}

/// Require `admin` to sign and to equal the admin stored in the canonical
/// `[b"lottery-config"]` PDA owned by this program. Used by every round-state
/// transition the house drives (CommitRound, AnchorTickets, RevealDraw,
/// FallbackDraw), so no other signer can set tickets_root / ticket_count or
/// reveal a draw.
fn require_admin(
    program_id:  &Pubkey,
    lottery_cfg: &AccountInfo,
    admin:       &AccountInfo,
) -> Result<LotteryConfig, ProgramError> {
    if !admin.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (expected_cfg_pda, _) =
        Pubkey::find_program_address(&[b"lottery-config"], program_id);
    if expected_cfg_pda != *lottery_cfg.key || lottery_cfg.owner != program_id {
        return Err(ProgramError::InvalidAccountData);
    }
    let cfg = {
        let data = lottery_cfg.try_borrow_data()?;
        LotteryConfig::unpack_from(&data).ok_or(ProgramError::InvalidAccountData)?
    };
    if cfg.admin != admin.key.to_bytes() {
        return Err(LotteryError::NotAdmin.into());
    }
    Ok(cfg)
}

/// Unpack a round account: program-owned, a RoundState, at the canonical
/// `[b"round", round_id_le]` PDA of the round id it stores.
fn load_round(program_id: &Pubkey, acct: &AccountInfo) -> Result<RoundState, ProgramError> {
    if acct.owner != program_id {
        return Err(ProgramError::InvalidAccountData);
    }
    let round = {
        let data = acct.try_borrow_data()?;
        RoundState::unpack_from(&data).ok_or(ProgramError::InvalidAccountData)?
    };
    let (expected, _) =
        Pubkey::find_program_address(&[b"round", &round.round_id.to_le_bytes()], program_id);
    if expected != *acct.key {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(round)
}

/// The ticket leaf built from the claimant key must sit at
/// `leaf_index < ticket_count` under the round's tickets_root.
fn verify_ticket(
    round:     &RoundState,
    claimant:  &Pubkey,
    nullifier: &[u8; 32],
    t:         &TicketClaim,
) -> ProgramResult {
    if t.leaf_index >= round.ticket_count
        || t.proof.len() != ticket::tree_depth(round.ticket_count)
    {
        return Err(LotteryError::InvalidTicketProof.into());
    }
    let leaf = ticket::ticket_leaf(round.round_id, &claimant.to_bytes(), &t.numbers, nullifier);
    if ticket::root_from_proof(leaf, t.leaf_index, &t.proof) != round.tickets_root {
        return Err(LotteryError::InvalidTicketProof.into());
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// 0x01 InitLottery
// ─────────────────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn process_init(
    program_id:        &Pubkey,
    accounts:          &[AccountInfo],
    ticket_price_null: u64,
    house_fee_bps:     u16,
    numbers_count:     u8,
    numbers_range:     u8,
    fallback_after:    u8,
) -> ProgramResult {
    let iter          = &mut accounts.iter();
    let lottery_cfg   = next_account_info(iter)?;
    let admin         = next_account_info(iter)?;
    let system_prog   = next_account_info(iter)?;

    if !admin.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let (expected_pda, bump) =
        Pubkey::find_program_address(&[b"lottery-config"], program_id);
    if expected_pda != *lottery_cfg.key {
        return Err(ProgramError::InvalidAccountData);
    }
    if !lottery_cfg.data_is_empty() {
        return Err(LotteryError::AlreadyInitialized.into());
    }

    let rent     = Rent::get()?;
    let lamports = rent.minimum_balance(LOTTERY_CONFIG_SIZE);
    invoke_signed(
        &system_instruction::create_account(
            admin.key,
            lottery_cfg.key,
            lamports,
            LOTTERY_CONFIG_SIZE as u64,
            program_id,
        ),
        &[admin.clone(), lottery_cfg.clone(), system_prog.clone()],
        &[&[b"lottery-config", &[bump]]],
    )?;

    let config = LotteryConfig {
        disc:              LOTTERY_CONFIG_DISC,
        admin:             admin.key.to_bytes(),
        ticket_price_null,
        house_fee_bps,
        numbers_count,
        numbers_range,
        fallback_after,
        current_round_id:  0,
        is_active:         true,
    };
    let mut data = lottery_cfg.try_borrow_mut_data()?;
    config.pack_into(&mut data);

    msg!("dark-null-lottery: InitLottery");
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// 0x02 CommitRound
// ─────────────────────────────────────────────────────────────────────────────

fn process_commit(
    program_id:      &Pubkey,
    accounts:        &[AccountInfo],
    seed_commitment: [u8; 32],
) -> ProgramResult {
    let iter        = &mut accounts.iter();
    let lottery_cfg = next_account_info(iter)?;
    let round_state = next_account_info(iter)?;
    let admin       = next_account_info(iter)?;
    let system_prog = next_account_info(iter)?;

    // ── Read and validate config + admin ──────────────────────────────────
    let mut cfg = require_admin(program_id, lottery_cfg, admin)?;

    let round_id = cfg.current_round_id;
    let round_id_le = round_id.to_le_bytes();

    // ── Validate round_state PDA ──────────────────────────────────────────
    let (expected_round_pda, round_bump) =
        Pubkey::find_program_address(&[b"round", &round_id_le], program_id);
    if expected_round_pda != *round_state.key {
        return Err(ProgramError::InvalidAccountData);
    }

    // Ensure round doesn't already exist (double-commit protection)
    if !round_state.data_is_empty() {
        let existing = round_state.try_borrow_data()?;
        if existing.len() >= ROUND_STATE_SIZE && existing[0] == ROUND_STATE_DISC {
            let r = RoundState::unpack_from(&existing)
                .ok_or(ProgramError::InvalidAccountData)?;
            // Any state that isn't brand-new → WrongStatus
            let _ = r;
            return Err(LotteryError::WrongStatus.into());
        }
    }

    // ── Create round PDA ──────────────────────────────────────────────────
    let rent     = Rent::get()?;
    let lamports = rent.minimum_balance(ROUND_STATE_SIZE);
    invoke_signed(
        &system_instruction::create_account(
            admin.key,
            round_state.key,
            lamports,
            ROUND_STATE_SIZE as u64,
            program_id,
        ),
        &[admin.clone(), round_state.clone(), system_prog.clone()],
        &[&[b"round", &round_id_le, &[round_bump]]],
    )?;

    let round = RoundState {
        disc:                 ROUND_STATE_DISC,
        round_id,
        tickets_root:         [0u8; 32],
        ticket_count:         0,
        total_null_deposited: 0,
        seed_commitment,
        seed_revealed:        [0u8; 32],
        drawn_numbers:        [0u8; 5],
        status:               RoundStatus::Committed,
        winner_nullifier:     [0u8; 32],
        no_winner_count:      0,
    };
    {
        let mut data = round_state.try_borrow_mut_data()?;
        round.pack_into(&mut data);
    }

    // ── Increment round counter in config ─────────────────────────────────
    cfg.current_round_id = round_id + 1;
    {
        let mut data = lottery_cfg.try_borrow_mut_data()?;
        cfg.pack_into(&mut data);
    }

    msg!("dark-null-lottery: CommitRound id={}", round_id);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// 0x03 AnchorTickets
// ─────────────────────────────────────────────────────────────────────────────

fn process_anchor(
    program_id:           &Pubkey,
    accounts:             &[AccountInfo],
    tickets_root:         [u8; 32],
    ticket_count:         u64,
    total_null_deposited: u64,
) -> ProgramResult {
    let iter        = &mut accounts.iter();
    let round_state = next_account_info(iter)?;
    let admin       = next_account_info(iter)?;
    let lottery_cfg = next_account_info(iter)?;

    require_admin(program_id, lottery_cfg, admin)?;

    let mut data  = round_state.try_borrow_mut_data()?;
    let mut round = RoundState::unpack_from(&data)
        .ok_or(ProgramError::InvalidAccountData)?;

    if round.status != RoundStatus::Committed {
        return Err(LotteryError::WrongStatus.into());
    }

    round.tickets_root         = tickets_root;
    round.ticket_count         = ticket_count;
    round.total_null_deposited = total_null_deposited;
    round.status               = RoundStatus::Anchored;
    round.pack_into(&mut data);

    msg!("dark-null-lottery: AnchorTickets round_id={}", round.round_id);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// 0x04 RevealDraw
// ─────────────────────────────────────────────────────────────────────────────

fn process_reveal(program_id: &Pubkey, accounts: &[AccountInfo], seed: [u8; 32]) -> ProgramResult {
    let iter        = &mut accounts.iter();
    let round_state = next_account_info(iter)?;
    let admin       = next_account_info(iter)?;
    let lottery_cfg = next_account_info(iter)?;

    require_admin(program_id, lottery_cfg, admin)?;

    let mut data  = round_state.try_borrow_mut_data()?;
    let mut round = RoundState::unpack_from(&data)
        .ok_or(ProgramError::InvalidAccountData)?;

    if round.status != RoundStatus::Anchored {
        return Err(LotteryError::WrongStatus.into());
    }

    // ── Verify SHA-256(seed) == seed_commitment ───────────────────────────
    let computed = hashv(&[&seed]);
    if computed.to_bytes() != round.seed_commitment {
        return Err(LotteryError::InvalidSeed.into());
    }

    // ── Draw 5 numbers from 1..=30 via Fisher-Yates + keccak256 ──────────
    let drawn = draw_numbers(&seed, round.round_id);

    round.seed_revealed  = seed;
    round.drawn_numbers  = drawn;
    // The winner is whoever holds an anchored ticket with these numbers;
    // ClaimJackpot verifies that against tickets_root.
    round.status         = RoundStatus::Drawn;
    // no_winner_count is not maintained; FallbackDraw checks three consecutive
    // Drawn rounds instead.
    round.pack_into(&mut data);

    msg!(
        "dark-null-lottery: RevealDraw round={} drawn={},{},{},{},{}",
        round.round_id,
        drawn[0], drawn[1], drawn[2], drawn[3], drawn[4],
    );
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// 0x05 FallbackDraw
// ─────────────────────────────────────────────────────────────────────────────

fn process_fallback(
    program_id:            &Pubkey,
    accounts:              &[AccountInfo],
    seed:                  [u8; 32],
    fallback_tickets_root: [u8; 32],
    fallback_pool_size:    u64,
) -> ProgramResult {
    let iter        = &mut accounts.iter();
    let lottery_cfg = next_account_info(iter)?;
    let accts       = [
        next_account_info(iter)?,
        next_account_info(iter)?,
        next_account_info(iter)?,
    ];
    let admin       = next_account_info(iter)?;

    let cfg = require_admin(program_id, lottery_cfg, admin)?;
    if cfg.fallback_after > FALLBACK_ROUNDS {
        return Err(LotteryError::FallbackNotReady.into());
    }

    // Three consecutive rounds, each drawn with no claimed winner. The canonical
    // PDA check plus consecutive ids also makes the three accounts distinct.
    let mut rounds = [
        load_round(program_id, accts[0])?,
        load_round(program_id, accts[1])?,
        load_round(program_id, accts[2])?,
    ];
    for i in 1..3 {
        if rounds[i - 1].round_id.checked_add(1) != Some(rounds[i].round_id) {
            return Err(LotteryError::FallbackRoundsNotConsecutive.into());
        }
    }
    if rounds.iter().any(|r| r.status != RoundStatus::Drawn) {
        return Err(LotteryError::WrongStatus.into());
    }

    // Seed: the third round's draw seed, committed by CommitRound before its
    // tickets were anchored and checked here against that commitment, so the
    // selection cannot be chosen after the pool is fixed. (SlotHashes was not
    // used: the admin caller could pick the slot its transaction lands in.)
    let r3 = &rounds[2];
    if hashv(&[&seed]).to_bytes() != r3.seed_commitment {
        return Err(LotteryError::InvalidSeed.into());
    }
    // Pool: the third round's anchored tickets tree, fixed before the draw.
    if r3.ticket_count == 0
        || fallback_tickets_root != r3.tickets_root
        || fallback_pool_size != r3.ticket_count
    {
        return Err(LotteryError::FallbackPoolMismatch.into());
    }
    let index = ticket::fallback_winner_index(&seed, r3.round_id, r3.ticket_count);

    // The winner is recorded by ClaimJackpot from the selected ticket's leaf.
    rounds[0].status = RoundStatus::NoWinner;
    rounds[1].status = RoundStatus::NoWinner;
    rounds[2].status = RoundStatus::FallbackDrawn;
    for (acct, round) in accts.iter().zip(rounds.iter()) {
        let mut data = acct.try_borrow_mut_data()?;
        round.pack_into(&mut data);
    }

    msg!("dark-null-lottery: FallbackDraw round3={} index={}", rounds[2].round_id, index);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// 0x06 ClaimJackpot
// ─────────────────────────────────────────────────────────────────────────────

fn process_claim(
    program_id:       &Pubkey,
    accounts:         &[AccountInfo],
    winner_nullifier: [u8; 32],
    ticket:           Option<TicketClaim>,
) -> ProgramResult {
    let iter                  = &mut accounts.iter();
    let round_state           = next_account_info(iter)?;
    let claim_nullifier_acct  = next_account_info(iter)?;
    let claimant              = next_account_info(iter)?;
    let _jackpot_escrow       = next_account_info(iter)?;
    let _claimant_token       = next_account_info(iter)?;
    let _null_mint            = next_account_info(iter)?;
    let _token_program        = next_account_info(iter)?;
    let system_prog           = next_account_info(iter)?;

    if !claimant.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut round = load_round(program_id, round_state)?;

    match round.status {
        // Drawn: the claimant must hold an anchored ticket whose numbers are the
        // drawn numbers. The ticket leaf commits to the claimant key, so a ticket
        // can only be claimed by its owner.
        RoundStatus::Drawn => {
            let t = ticket.ok_or(LotteryError::InvalidTicketProof)?;
            if t.numbers != ticket::sorted_numbers(&round.drawn_numbers) {
                return Err(LotteryError::TicketNotWinning.into());
            }
            verify_ticket(&round, claimant.key, &winner_nullifier, &t)?;
        }
        // FallbackDrawn: only the ticket at the selected index, by its owner.
        RoundStatus::FallbackDrawn => {
            let t = ticket.ok_or(LotteryError::InvalidTicketProof)?;
            let index = ticket::fallback_winner_index(
                &round.seed_revealed, round.round_id, round.ticket_count,
            );
            if t.leaf_index != index {
                return Err(LotteryError::NotFallbackWinner.into());
            }
            verify_ticket(&round, claimant.key, &winner_nullifier, &t)?;
        }
        // Won: the winner already claimed (the claim record exists). Closed.
        RoundStatus::Won => {
            return Err(if round.winner_nullifier == winner_nullifier {
                LotteryError::AlreadyClaimed
            } else {
                LotteryError::InvalidWinner
            }
            .into());
        }
        _ => return Err(LotteryError::WrongStatus.into()),
    }
    round.winner_nullifier = winner_nullifier;

    // ── Create ClaimNullifier PDA (double-claim prevention) ───────────────
    let (expected_claim_pda, claim_bump) =
        Pubkey::find_program_address(&[b"claim", &winner_nullifier], program_id);
    if expected_claim_pda != *claim_nullifier_acct.key {
        return Err(ProgramError::InvalidAccountData);
    }
    if !claim_nullifier_acct.data_is_empty() {
        return Err(LotteryError::AlreadyClaimed.into());
    }

    let rent     = Rent::get()?;
    let lamports = rent.minimum_balance(CLAIM_NULLIFIER_SIZE);
    invoke_signed(
        &system_instruction::create_account(
            claimant.key,
            claim_nullifier_acct.key,
            lamports,
            CLAIM_NULLIFIER_SIZE as u64,
            program_id,
        ),
        &[claimant.clone(), claim_nullifier_acct.clone(), system_prog.clone()],
        &[&[b"claim", &winner_nullifier, &[claim_bump]]],
    )?;

    let slot = Clock::get().map(|c| c.slot).unwrap_or(0);
    let claim_record = ClaimNullifier {
        disc:       CLAIM_NULLIFIER_DISC,
        used:       true,
        round_id:   round.round_id,
        claimed_at: slot,
    };
    {
        let mut claim_data = claim_nullifier_acct.try_borrow_mut_data()?;
        claim_record.pack_into(&mut claim_data);
    }

    // No SPL token transfer is made by this program; the claim is recorded and
    // the round is marked Won.
    round.status = RoundStatus::Won;
    {
        let mut data = round_state.try_borrow_mut_data()?;
        round.pack_into(&mut data);
    }

    msg!("dark-null-lottery: ClaimJackpot round={}", round.round_id);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Draw helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Fisher-Yates draw of 5 distinct numbers from 1..=30.
///
/// Randomness source: keccak256([seed, round_id_le, i]) mod (30 - i)
/// for each draw step i in 0..5.
pub fn draw_numbers(seed: &[u8; 32], round_id: u64) -> [u8; 5] {
    // Pool: 1..=30 as u8
    let mut pool: [u8; 30] = core::array::from_fn(|i| (i + 1) as u8);
    let mut drawn = [0u8; 5];
    let round_id_le = round_id.to_le_bytes();

    for i in 0usize..5 {
        let remaining = 30 - i;
        // keccak256(seed || round_id_le || [i as u8])
        let hash_out = keccak::hashv(&[seed.as_slice(), &round_id_le, &[i as u8]]);
        let hash_bytes = hash_out.0;
        let mut idx_bytes = [0u8; 8];
        idx_bytes.copy_from_slice(&hash_bytes[0..8]);
        let idx = (u64::from_le_bytes(idx_bytes) % remaining as u64) as usize;

        drawn[i] = pool[idx];
        // swap_remove: replace pool[idx] with the last element, shrink pool
        pool[idx] = pool[remaining - 1];
    }

    drawn
}
