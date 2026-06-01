//! NullLive — continuous hardware attestation for live streams.
//!
//! A live stream verification program for the AI-generated media era.
//! Instead of proving a file was real after the fact, NullLive proves
//! the stream heartbeat is real RIGHT NOW — and goes dark when it stops.
//!
//! Proof levels:
//!   Level 1 (AppSigned):   stream output signed by app. Proves the exact
//!                          bytes existed at this time, not modified after.
//!                          Does NOT prove camera origin.
//!   Level 2 (TeeCamera):   frame came through a trusted camera capture path
//!                          (Secure Enclave / Android CameraX TEE / Qualcomm ISP).
//!                          Prevents arbitrary app-memory injection.
//!   Level 3 (IspPhysical): ISP-level heuristics (moiré, flicker, depth) suggest
//!                          physical capture vs. screen recording. Research /
//!                          best-effort. NOT absolute proof of physical reality.
//!
//! Architecture:
//!   Client samples a frame every 5-30 seconds.
//!   Off-chain: sign frame_hash with device key, build attestation packet.
//!   Every 1-5 min: batch packets into Merkle tree, store on Arweave/Irys,
//!   call anchor_attestation_root with the Merkle root.
//!   Badge reads latest signed packet + latest anchored root.
//!   Badge turns yellow if heartbeat >30s old. Dark if >90s or verification fails.
//!
//! What it does NOT claim:
//!   - Does not prove physical reality in absolute terms.
//!   - Level 1 alone does not prove camera origin.
//!   - Secure Enclave signing alone does not prevent a fake stream from
//!     generating frames and handing hashes to the enclave.
//!
//! IS_MAINNET_READY = false — proof-of-concept pilot, unaudited.
//! ⚠️  EXTERNALLY UNAUDITED. Deploy only for pilot/demo use.

pub mod error;
pub mod processor;
pub mod state;

pub const IS_MAINNET_READY: bool = false;

#[cfg(not(feature = "no-entrypoint"))]
use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    pubkey::Pubkey,
};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

#[cfg(not(feature = "no-entrypoint"))]
fn process_instruction(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    processor::process(program_id, accounts, data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{
        AttestationLevel, SessionStatus, StreamSession,
        STREAM_SESSION_DISC, STREAM_SESSION_LEN,
    };
    use solana_program::program_pack::Pack;

    #[test]
    fn is_not_mainnet_ready() {
        assert!(!IS_MAINNET_READY);
    }

    #[test]
    fn session_pack_roundtrip() {
        let s = StreamSession {
            disc:              STREAM_SESSION_DISC,
            streamer_pubkey:   [0xABu8; 32],
            device_pubkey:     [0xCDu8; 32],
            session_id:        [0x01u8; 32],
            started_slot:      12345678,
            last_anchor_slot:  12345999,
            last_root:         [0x42u8; 32],
            total_frame_count: 720,
            status:            SessionStatus::Active as u8,
            attestation_level: AttestationLevel::TeeCamera as u8,
            bump:              253,
        };
        let mut buf = [0u8; STREAM_SESSION_LEN];
        StreamSession::pack(s.clone(), &mut buf).unwrap();
        let s2 = StreamSession::unpack(&buf).unwrap();
        assert_eq!(s, s2);
    }

    #[test]
    fn session_len_correct() {
        assert_eq!(STREAM_SESSION_LEN, StreamSession::LEN);
    }

    #[test]
    fn attestation_levels_valid() {
        assert!(AttestationLevel::from_u8(1).is_some());
        assert!(AttestationLevel::from_u8(2).is_some());
        assert!(AttestationLevel::from_u8(3).is_some());
        assert!(AttestationLevel::from_u8(0).is_none());
        assert!(AttestationLevel::from_u8(4).is_none());
    }

    #[test]
    fn error_codes_no_collision() {
        use crate::error::LiveAttestationError::*;
        let codes: Vec<u32> = vec![
            SessionAlreadyExists.into(),
            SessionNotFound.into(),
            SessionEnded.into(),
            NotStreamer.into(),
            InvalidAttestationLevel.into(),
            InvalidInstructionData.into(),
            InvalidBatchTimestamp.into(),
        ].into_iter().map(|e: solana_program::program_error::ProgramError| {
            if let solana_program::program_error::ProgramError::Custom(c) = e { c } else { 0 }
        }).collect();
        let unique: std::collections::HashSet<_> = codes.iter().collect();
        assert_eq!(codes.len(), unique.len());
    }
}
