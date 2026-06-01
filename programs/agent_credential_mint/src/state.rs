//! agent-credential-mint on-chain state
//!
//! CredentialRecord PDA layout (155 bytes):
//!
//! Offset  Len  Field
//!      0    2  disc = CRED_DISC [0x43, 0x52]
//!      2   32  agent_pubkey
//!     34   33  device_pubkey     (compressed 33 bytes: secp256r1 or secp256k1)
//!     67    1  binding_type      (0x01 = secp256r1, 0x02 = secp256k1)
//!     68   32  credential_mint   (Token-2022 mint address)
//!    100    8  issued_at_slot    (u64 le)
//!    108    8  issued_at_unix    (u64 le)
//!    116    1  passport_version  (u8)
//!    117   32  agent_id_hash     (SHA-256 of agent_pubkey || device_pubkey)
//!    149    1  status            (0x00 = active, 0x01 = revoked)
//!    150    1  binding_version   (u8, incremented on upgrade)
//!    151    4  _reserved         (zero-padded)
//! ─────────────────────────────────────────────────────────
//!  Total: 155 bytes
//!
//! Note: Spec shows 5 reserved bytes (offsets 150-154), but the first reserved
//! byte is reused as binding_version. This keeps CRED_RECORD_SIZE = 155.

use solana_program::program_error::ProgramError;
use crate::error::CredentialError;

/// Two-byte discriminator: 'C', 'R'
pub const CRED_DISC: [u8; 2] = [0x43, 0x52];

/// Total byte size of a packed CredentialRecord
pub const CRED_RECORD_SIZE: usize = 155;

// ── Field offsets ─────────────────────────────────────────────────────────────
pub const OFF_DISC:             usize = 0;
pub const OFF_AGENT_PUBKEY:     usize = 2;
pub const OFF_DEVICE_PUBKEY:    usize = 34;
pub const OFF_BINDING_TYPE:     usize = 67;
pub const OFF_CREDENTIAL_MINT:  usize = 68;
pub const OFF_ISSUED_AT_SLOT:   usize = 100;
pub const OFF_ISSUED_AT_UNIX:   usize = 108;
pub const OFF_PASSPORT_VERSION: usize = 116;
pub const OFF_AGENT_ID_HASH:    usize = 117;
pub const OFF_STATUS:           usize = 149;
pub const OFF_BINDING_VERSION:  usize = 150;
pub const OFF_RESERVED:         usize = 151;

// ── Enums ─────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BindingType {
    /// P-256 / WebAuthn passkey (secp256r1)
    Secp256r1 = 0x01,
    /// Ethereum address binding (secp256k1)
    Secp256k1 = 0x02,
}

impl BindingType {
    pub fn from_byte(b: u8) -> Result<Self, ProgramError> {
        match b {
            0x01 => Ok(BindingType::Secp256r1),
            0x02 => Ok(BindingType::Secp256k1),
            _    => Err(CredentialError::InvalidBindingType.into()),
        }
    }

    pub fn to_byte(self) -> u8 {
        self as u8
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CredentialStatus {
    /// Credential is valid and active
    Active  = 0x00,
    /// Credential has been revoked via PermanentDelegate burn
    Revoked = 0x01,
}

impl CredentialStatus {
    pub fn from_byte(b: u8) -> Result<Self, ProgramError> {
        match b {
            0x00 => Ok(CredentialStatus::Active),
            0x01 => Ok(CredentialStatus::Revoked),
            _    => Err(CredentialError::InvalidAccountSize.into()),
        }
    }

    pub fn to_byte(self) -> u8 {
        self as u8
    }
}

// ── CredentialRecord ──────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct CredentialRecord {
    pub disc:             [u8; 2],
    pub agent_pubkey:     [u8; 32],
    /// Compressed pubkey: 33 bytes (secp256r1 or secp256k1)
    pub device_pubkey:    [u8; 33],
    pub binding_type:     BindingType,
    /// Token-2022 mint for this credential
    pub credential_mint:  [u8; 32],
    pub issued_at_slot:   u64,
    pub issued_at_unix:   u64,
    pub passport_version: u8,
    /// SHA-256(agent_pubkey || device_pubkey)
    pub agent_id_hash:    [u8; 32],
    pub status:           CredentialStatus,
    pub binding_version:  u8,
    pub _reserved:        [u8; 4],
}

impl CredentialRecord {
    pub fn pack_into(&self, buf: &mut [u8]) {
        debug_assert_eq!(buf.len(), CRED_RECORD_SIZE);

        buf[OFF_DISC..OFF_DISC + 2]
            .copy_from_slice(&self.disc);
        buf[OFF_AGENT_PUBKEY..OFF_AGENT_PUBKEY + 32]
            .copy_from_slice(&self.agent_pubkey);
        buf[OFF_DEVICE_PUBKEY..OFF_DEVICE_PUBKEY + 33]
            .copy_from_slice(&self.device_pubkey);
        buf[OFF_BINDING_TYPE] = self.binding_type.to_byte();
        buf[OFF_CREDENTIAL_MINT..OFF_CREDENTIAL_MINT + 32]
            .copy_from_slice(&self.credential_mint);
        buf[OFF_ISSUED_AT_SLOT..OFF_ISSUED_AT_SLOT + 8]
            .copy_from_slice(&self.issued_at_slot.to_le_bytes());
        buf[OFF_ISSUED_AT_UNIX..OFF_ISSUED_AT_UNIX + 8]
            .copy_from_slice(&self.issued_at_unix.to_le_bytes());
        buf[OFF_PASSPORT_VERSION] = self.passport_version;
        buf[OFF_AGENT_ID_HASH..OFF_AGENT_ID_HASH + 32]
            .copy_from_slice(&self.agent_id_hash);
        buf[OFF_STATUS] = self.status.to_byte();
        buf[OFF_BINDING_VERSION] = self.binding_version;
        buf[OFF_RESERVED..OFF_RESERVED + 4]
            .copy_from_slice(&self._reserved);
    }

    pub fn unpack_from(buf: &[u8]) -> Result<Self, ProgramError> {
        if buf.len() < CRED_RECORD_SIZE {
            return Err(CredentialError::InvalidAccountSize.into());
        }

        let disc: [u8; 2] = buf[OFF_DISC..OFF_DISC + 2]
            .try_into().map_err(|_| ProgramError::InvalidAccountData)?;

        if disc != CRED_DISC {
            return Err(ProgramError::InvalidAccountData);
        }

        let agent_pubkey: [u8; 32] = buf[OFF_AGENT_PUBKEY..OFF_AGENT_PUBKEY + 32]
            .try_into().map_err(|_| ProgramError::InvalidAccountData)?;

        let device_pubkey: [u8; 33] = buf[OFF_DEVICE_PUBKEY..OFF_DEVICE_PUBKEY + 33]
            .try_into().map_err(|_| ProgramError::InvalidAccountData)?;

        let binding_type = BindingType::from_byte(buf[OFF_BINDING_TYPE])?;

        let credential_mint: [u8; 32] = buf[OFF_CREDENTIAL_MINT..OFF_CREDENTIAL_MINT + 32]
            .try_into().map_err(|_| ProgramError::InvalidAccountData)?;

        let issued_at_slot = u64::from_le_bytes(
            buf[OFF_ISSUED_AT_SLOT..OFF_ISSUED_AT_SLOT + 8]
                .try_into().map_err(|_| ProgramError::InvalidAccountData)?,
        );

        let issued_at_unix = u64::from_le_bytes(
            buf[OFF_ISSUED_AT_UNIX..OFF_ISSUED_AT_UNIX + 8]
                .try_into().map_err(|_| ProgramError::InvalidAccountData)?,
        );

        let passport_version = buf[OFF_PASSPORT_VERSION];

        let agent_id_hash: [u8; 32] = buf[OFF_AGENT_ID_HASH..OFF_AGENT_ID_HASH + 32]
            .try_into().map_err(|_| ProgramError::InvalidAccountData)?;

        let status = CredentialStatus::from_byte(buf[OFF_STATUS])?;

        let binding_version = buf[OFF_BINDING_VERSION];

        let _reserved: [u8; 4] = buf[OFF_RESERVED..OFF_RESERVED + 4]
            .try_into().map_err(|_| ProgramError::InvalidAccountData)?;

        Ok(CredentialRecord {
            disc,
            agent_pubkey,
            device_pubkey,
            binding_type,
            credential_mint,
            issued_at_slot,
            issued_at_unix,
            passport_version,
            agent_id_hash,
            status,
            binding_version,
            _reserved,
        })
    }
}
