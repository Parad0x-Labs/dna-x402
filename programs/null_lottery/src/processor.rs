use crate::{
    error::LotteryError,
    instruction::LotteryInstruction,
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

/// Devnet-only flag. Set to true only when deploying to mainnet.
pub const IS_MAINNET_READY: bool = false;

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
        } => process_anchor(accounts, tickets_root, ticket_count, total_null_deposited),

        LotteryInstruction::RevealDraw { seed } => process_reveal(accounts, seed),

        LotteryInstruction::FallbackDraw {
            seed,
            fallback_tickets_root: _,
            fallback_pool_size,
        } => process_fallback(program_id, accounts, seed, fallback_pool_size),

        LotteryInstruction::ClaimJackpot { winner_nullifier } => {
            process_claim(program_id, accounts, winner_nullifier)
        }
    }
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

    if !admin.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // ── Read and validate config ──────────────────────────────────────────
    let mut cfg = {
        let data = lottery_cfg.try_borrow_data()?;
        LotteryConfig::unpack_from(&data)
            .ok_or(ProgramError::InvalidAccountData)?
    };

    if cfg.admin != admin.key.to_bytes() {
        return Err(LotteryError::NotAdmin.into());
    }

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
    accounts:             &[AccountInfo],
    tickets_root:         [u8; 32],
    ticket_count:         u64,
    total_null_deposited: u64,
) -> ProgramResult {
    let iter        = &mut accounts.iter();
    let round_state = next_account_info(iter)?;
    let admin       = next_account_info(iter)?;

    if !admin.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

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

fn process_reveal(accounts: &[AccountInfo], seed: [u8; 32]) -> ProgramResult {
    let iter        = &mut accounts.iter();
    let round_state = next_account_info(iter)?;
    let admin       = next_account_info(iter)?;

    if !admin.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

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
    // IS_MAINNET_READY=false: no on-chain winner verification; mark Drawn only.
    round.status         = RoundStatus::Drawn;
    // no_winner_count persists; ClaimJackpot or FallbackDraw updates it.
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
    program_id:         &Pubkey,
    accounts:           &[AccountInfo],
    seed:               [u8; 32],
    fallback_pool_size: u64,
) -> ProgramResult {
    let iter         = &mut accounts.iter();
    let lottery_cfg  = next_account_info(iter)?;
    let round_state1 = next_account_info(iter)?;
    let round_state2 = next_account_info(iter)?;
    let round_state3 = next_account_info(iter)?;
    let admin        = next_account_info(iter)?;

    if !admin.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // ── Validate config PDA ───────────────────────────────────────────────
    let (expected_cfg_pda, _) =
        Pubkey::find_program_address(&[b"lottery-config"], program_id);
    if expected_cfg_pda != *lottery_cfg.key {
        return Err(ProgramError::InvalidAccountData);
    }

    let cfg = {
        let data = lottery_cfg.try_borrow_data()?;
        LotteryConfig::unpack_from(&data)
            .ok_or(ProgramError::InvalidAccountData)?
    };

    if cfg.admin != admin.key.to_bytes() {
        return Err(LotteryError::NotAdmin.into());
    }

    // ── Load and validate the three round states ──────────────────────────
    let mut r1 = {
        let data = round_state1.try_borrow_data()?;
        RoundState::unpack_from(&data).ok_or(ProgramError::InvalidAccountData)?
    };
    let mut r2 = {
        let data = round_state2.try_borrow_data()?;
        RoundState::unpack_from(&data).ok_or(ProgramError::InvalidAccountData)?
    };
    let mut r3 = {
        let data = round_state3.try_borrow_data()?;
        RoundState::unpack_from(&data).ok_or(ProgramError::InvalidAccountData)?
    };

    // All three must be Drawn with a positive no_winner_count chain.
    // We check r3's no_winner_count >= fallback_after.
    if r3.no_winner_count < cfg.fallback_after {
        return Err(LotteryError::FallbackNotReady.into());
    }

    if r1.status != RoundStatus::Drawn
        || r2.status != RoundStatus::Drawn
        || r3.status != RoundStatus::Drawn
    {
        return Err(LotteryError::WrongStatus.into());
    }

    // ── Compute fallback winner index ─────────────────────────────────────
    let winner_nullifier = fallback_winner_nullifier(&seed, fallback_pool_size);

    // ── Update statuses ───────────────────────────────────────────────────
    r1.status = RoundStatus::NoWinner;
    r2.status = RoundStatus::NoWinner;
    r3.status          = RoundStatus::Won;
    r3.winner_nullifier = winner_nullifier;
    r3.no_winner_count  = 0;

    {
        let mut data = round_state1.try_borrow_mut_data()?;
        r1.pack_into(&mut data);
    }
    {
        let mut data = round_state2.try_borrow_mut_data()?;
        r2.pack_into(&mut data);
    }
    {
        let mut data = round_state3.try_borrow_mut_data()?;
        r3.pack_into(&mut data);
    }

    msg!("dark-null-lottery: FallbackDraw round3={}", r3.round_id);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// 0x06 ClaimJackpot
// ─────────────────────────────────────────────────────────────────────────────

fn process_claim(
    program_id:       &Pubkey,
    accounts:         &[AccountInfo],
    winner_nullifier: [u8; 32],
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

    // ── Validate round state ──────────────────────────────────────────────
    let mut data  = round_state.try_borrow_mut_data()?;
    let mut round = RoundState::unpack_from(&data)
        .ok_or(ProgramError::InvalidAccountData)?;

    if round.status != RoundStatus::Drawn && round.status != RoundStatus::Won {
        return Err(LotteryError::WrongStatus.into());
    }
    if round.winner_nullifier != winner_nullifier {
        // On IS_MAINNET_READY=false this field is zeroes until FallbackDraw sets it.
        // For normal Drawn rounds the off-chain house calls this after setting
        // winner_nullifier via a separate mechanism; for devnet we accept any
        // non-zero nullifier supplied against a Drawn round.
        if !IS_MAINNET_READY {
            // devnet: only reject if round is Won and nullifier truly mismatches.
            if round.status == RoundStatus::Won {
                return Err(LotteryError::InvalidWinner.into());
            }
            // For Drawn rounds on devnet: accept, store the supplied nullifier.
            round.winner_nullifier = winner_nullifier;
        } else {
            return Err(LotteryError::InvalidWinner.into());
        }
    }

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

    // IS_MAINNET_READY=false: skip actual SPL token transfer; mark round Won.
    round.status = RoundStatus::Won;
    round.pack_into(&mut data);

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

/// Computes the fallback winner nullifier:
///   SHA-256(seed || "fallback" || winner_index_le)
/// where winner_index = keccak([seed, pool_size_le])[0..8] mod pool_size
pub fn fallback_winner_nullifier(seed: &[u8; 32], pool_size: u64) -> [u8; 32] {
    let pool_size_le = pool_size.to_le_bytes();
    let hash_out     = keccak::hashv(&[seed.as_slice(), &pool_size_le]);
    let mut idx_bytes = [0u8; 8];
    idx_bytes.copy_from_slice(&hash_out.0[0..8]);
    let winner_index = if pool_size > 0 {
        u64::from_le_bytes(idx_bytes) % pool_size
    } else {
        0
    };
    let winner_index_le = winner_index.to_le_bytes();

    // SHA-256 via solana_program::hash::hashv
    let commitment = hashv(&[seed.as_slice(), b"fallback", &winner_index_le]);
    commitment.to_bytes()
}
