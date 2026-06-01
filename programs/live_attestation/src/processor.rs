//! NullLive instruction processor.
//!
//! Three instructions:
//!   0x01 StartStream        — open a session, register device key
//!   0x02 AnchorAttestation  — anchor a batch Merkle root on-chain
//!   0x03 EndStream          — close the session

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

use crate::{
    error::LiveAttestationError,
    state::{
        AttestationLevel, SessionStatus, StreamSession,
        STREAM_SESSION_DISC, STREAM_SESSION_LEN,
    },
};

// ── Instruction discriminants ─────────────────────────────────────────────────
const IX_START_STREAM:       u8 = 0x01;
const IX_ANCHOR_ATTESTATION: u8 = 0x02;
const IX_END_STREAM:         u8 = 0x03;

pub fn process(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    if data.is_empty() {
        return Err(LiveAttestationError::InvalidInstructionData.into());
    }
    match data[0] {
        IX_START_STREAM       => process_start(program_id, accounts, &data[1..]),
        IX_ANCHOR_ATTESTATION => process_anchor(program_id, accounts, &data[1..]),
        IX_END_STREAM         => process_end(program_id, accounts, &data[1..]),
        _                     => Err(LiveAttestationError::InvalidInstructionData.into()),
    }
}

// ── StartStream ───────────────────────────────────────────────────────────────
//
// Instruction data (after discriminant): 65 bytes
//   session_id       [32B]
//   device_pubkey    [32B]
//   attestation_level [1B]  — 1=app, 2=tee, 3=isp
//
// Accounts:
//   0: session_pda   writable, PDA
//   1: streamer      signer, payer
//   2: system_program
fn process_start(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    if data.len() != 65 {
        return Err(LiveAttestationError::InvalidInstructionData.into());
    }

    let iter       = &mut accounts.iter();
    let session_pda = next_account_info(iter)?;
    let streamer    = next_account_info(iter)?;
    let system_prog = next_account_info(iter)?;

    if !streamer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let session_id:        [u8; 32] = data[0..32].try_into().unwrap();
    let device_pubkey:     [u8; 32] = data[32..64].try_into().unwrap();
    let attestation_level: u8       = data[64];

    if AttestationLevel::from_u8(attestation_level).is_none() {
        return Err(LiveAttestationError::InvalidAttestationLevel.into());
    }

    let (expected_pda, bump) = Pubkey::find_program_address(
        &[b"stream", &session_id[..8]],
        program_id,
    );
    if expected_pda != *session_pda.key {
        return Err(ProgramError::InvalidAccountData);
    }
    if !session_pda.data_is_empty() {
        return Err(LiveAttestationError::SessionAlreadyExists.into());
    }

    let rent     = Rent::get()?;
    let lamports = rent.minimum_balance(STREAM_SESSION_LEN);
    invoke_signed(
        &system_instruction::create_account(
            streamer.key, session_pda.key, lamports,
            STREAM_SESSION_LEN as u64, program_id,
        ),
        &[streamer.clone(), session_pda.clone(), system_prog.clone()],
        &[&[b"stream", &session_id[..8], &[bump]]],
    )?;

    let slot = Clock::get().map(|c| c.slot).unwrap_or(0);
    let session = StreamSession {
        disc:              STREAM_SESSION_DISC,
        streamer_pubkey:   streamer.key.to_bytes(),
        device_pubkey,
        session_id,
        started_slot:      slot,
        last_anchor_slot:  0,
        last_root:         [0u8; 32],
        total_frame_count: 0,
        status:            SessionStatus::Active as u8,
        attestation_level,
        bump,
    };
    StreamSession::pack(session, &mut session_pda.try_borrow_mut_data()?)?;

    let sid = hex8(&session_id);
    msg!("nulllive: StartStream session={} level={}",
        core::str::from_utf8(&sid).unwrap_or("?"), attestation_level);
    Ok(())
}

// ── AnchorAttestation ─────────────────────────────────────────────────────────
//
// Instruction data (after discriminant): 88 bytes
//   session_id       [32B]
//   merkle_root      [32B]  — root of the off-chain attestation packet batch
//   batch_start_ts   [8B LE u64]
//   batch_end_ts     [8B LE u64]
//   frame_count      [4B LE u32]
//   storage_uri_hash [4B]   — first 4 bytes of Arweave tx ID (full ID off-chain)
//
// Accounts:
//   0: session_pda   writable
//   1: streamer      signer
fn process_anchor(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    if data.len() != 88 {
        return Err(LiveAttestationError::InvalidInstructionData.into());
    }

    let iter        = &mut accounts.iter();
    let session_pda = next_account_info(iter)?;
    let streamer    = next_account_info(iter)?;

    if !streamer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let session_id:   [u8; 32] = data[0..32].try_into().unwrap();
    let merkle_root:  [u8; 32] = data[32..64].try_into().unwrap();
    let start_ts = u64::from_le_bytes(data[64..72].try_into().unwrap());
    let end_ts   = u64::from_le_bytes(data[72..80].try_into().unwrap());
    let frame_count = u32::from_le_bytes(data[80..84].try_into().unwrap());

    if end_ts < start_ts {
        return Err(LiveAttestationError::InvalidBatchTimestamp.into());
    }

    let (expected_pda, _) = Pubkey::find_program_address(
        &[b"stream", &session_id[..8]],
        program_id,
    );
    if expected_pda != *session_pda.key {
        return Err(ProgramError::InvalidAccountData);
    }

    let mut session = StreamSession::unpack(&session_pda.try_borrow_data()?)
        .map_err(|_| LiveAttestationError::SessionNotFound)?;

    if session.streamer_pubkey != streamer.key.to_bytes() {
        return Err(LiveAttestationError::NotStreamer.into());
    }
    if session.status != SessionStatus::Active as u8 {
        return Err(LiveAttestationError::SessionEnded.into());
    }

    let slot = Clock::get().map(|c| c.slot).unwrap_or(0);
    session.last_anchor_slot   = slot;
    session.last_root          = merkle_root;
    session.total_frame_count += frame_count as u64;
    StreamSession::pack(session, &mut session_pda.try_borrow_mut_data()?)?;

    let rhex = hex8(&merkle_root);
    msg!("nulllive: AnchorAttestation root={} frames={} ts={}-{}",
        core::str::from_utf8(&rhex).unwrap_or("?"), frame_count, start_ts, end_ts);
    Ok(())
}

// ── EndStream ─────────────────────────────────────────────────────────────────
//
// Instruction data (after discriminant): 32 bytes
//   session_id [32B]
//
// Accounts:
//   0: session_pda  writable
//   1: streamer     signer
fn process_end(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    if data.len() != 32 {
        return Err(LiveAttestationError::InvalidInstructionData.into());
    }

    let iter        = &mut accounts.iter();
    let session_pda = next_account_info(iter)?;
    let streamer    = next_account_info(iter)?;

    if !streamer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let session_id: [u8; 32] = data[0..32].try_into().unwrap();
    let (expected_pda, _) = Pubkey::find_program_address(
        &[b"stream", &session_id[..8]],
        program_id,
    );
    if expected_pda != *session_pda.key {
        return Err(ProgramError::InvalidAccountData);
    }

    let mut session = StreamSession::unpack(&session_pda.try_borrow_data()?)
        .map_err(|_| LiveAttestationError::SessionNotFound)?;

    if session.streamer_pubkey != streamer.key.to_bytes() {
        return Err(LiveAttestationError::NotStreamer.into());
    }

    session.status = SessionStatus::Ended as u8;
    StreamSession::pack(session, &mut session_pda.try_borrow_mut_data()?)?;

    let sid = hex8(&session_id);
    msg!("nulllive: EndStream session={}", core::str::from_utf8(&sid).unwrap_or("?"));
    Ok(())
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn hex8(bytes: &[u8; 32]) -> [u8; 16] {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut out = [0u8; 16];
    for (i, &b) in bytes[..8].iter().enumerate() {
        out[i * 2]     = H[(b >> 4) as usize];
        out[i * 2 + 1] = H[(b & 0xf) as usize];
    }
    out
}
