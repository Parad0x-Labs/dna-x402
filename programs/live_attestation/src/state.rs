//! On-chain state for NullLive stream sessions.

use solana_program::{
    program_error::ProgramError,
    program_pack::{IsInitialized, Pack, Sealed},
};

/// Discriminant written at byte 0 of every StreamSession account.
pub const STREAM_SESSION_DISC: u8 = 0x4E; // 'N' for NullLive

/// Attestation levels — what the client claims about the capture path.
/// Higher is stronger. Clients self-report; verifiers should display level.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AttestationLevel {
    /// Level 1 — App signed: proves the stream output existed at this time
    /// and was not modified after signing. Does NOT prove camera origin.
    AppSigned  = 1,
    /// Level 2 — TEE/camera path: frame came through a trusted camera
    /// capture path (Secure Enclave, Android CameraX TEE, Qualcomm ISP).
    /// Prevents arbitrary app-memory injection.
    TeeCamera  = 2,
    /// Level 3 — Physical-scene confidence: ISP-level moiré/flicker/depth
    /// heuristics suggest physical capture vs. screen recording.
    /// Research / best-effort. NOT absolute proof of physical reality.
    IspPhysical = 3,
}

impl AttestationLevel {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            1 => Some(Self::AppSigned),
            2 => Some(Self::TeeCamera),
            3 => Some(Self::IspPhysical),
            _ => None,
        }
    }
}

/// Stream session status.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SessionStatus {
    Active = 0,
    Ended  = 1,
}

/// On-chain record for one live stream session.
///
/// PDA seeds: [b"stream", session_id[0..8]]
/// Size: 163 bytes
#[derive(Clone, Debug, PartialEq)]
pub struct StreamSession {
    /// Discriminant.
    pub disc:               u8,
    /// Wallet of the streamer (signer for start/end).
    pub streamer_pubkey:    [u8; 32],
    /// Public key of the attesting device (Secure Enclave / TEE key).
    pub device_pubkey:      [u8; 32],
    /// Unique session identifier (client-generated, 32 bytes).
    pub session_id:         [u8; 32],
    /// Solana slot when start_stream was called.
    pub started_slot:       u64,
    /// Slot of the last anchor_attestation_root call.
    pub last_anchor_slot:   u64,
    /// Merkle root of the most recently anchored attestation batch.
    pub last_root:          [u8; 32],
    /// Cumulative frame count across all anchored batches.
    pub total_frame_count:  u64,
    /// Current session status.
    pub status:             u8,
    /// Highest attestation level claimed for this session.
    pub attestation_level:  u8,
    /// PDA bump.
    pub bump:               u8,
}

pub const STREAM_SESSION_LEN: usize = 163;

impl Sealed for StreamSession {}

impl IsInitialized for StreamSession {
    fn is_initialized(&self) -> bool { self.disc == STREAM_SESSION_DISC }
}

impl Pack for StreamSession {
    const LEN: usize = STREAM_SESSION_LEN;

    fn pack_into_slice(&self, dst: &mut [u8]) {
        dst[0]      = self.disc;
        dst[1..33]  .copy_from_slice(&self.streamer_pubkey);
        dst[33..65] .copy_from_slice(&self.device_pubkey);
        dst[65..97] .copy_from_slice(&self.session_id);
        dst[97..105].copy_from_slice(&self.started_slot.to_le_bytes());
        dst[105..113].copy_from_slice(&self.last_anchor_slot.to_le_bytes());
        dst[113..145].copy_from_slice(&self.last_root);
        dst[145..153].copy_from_slice(&self.total_frame_count.to_le_bytes());
        dst[153]    = self.status;
        dst[154]    = self.attestation_level;
        dst[155]    = self.bump;
        // 156..163 reserved
    }

    fn unpack_from_slice(src: &[u8]) -> Result<Self, ProgramError> {
        if src.len() < STREAM_SESSION_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self {
            disc:               src[0],
            streamer_pubkey:    src[1..33].try_into().unwrap(),
            device_pubkey:      src[33..65].try_into().unwrap(),
            session_id:         src[65..97].try_into().unwrap(),
            started_slot:       u64::from_le_bytes(src[97..105].try_into().unwrap()),
            last_anchor_slot:   u64::from_le_bytes(src[105..113].try_into().unwrap()),
            last_root:          src[113..145].try_into().unwrap(),
            total_frame_count:  u64::from_le_bytes(src[145..153].try_into().unwrap()),
            status:             src[153],
            attestation_level:  src[154],
            bump:               src[155],
        })
    }
}
