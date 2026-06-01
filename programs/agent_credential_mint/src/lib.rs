//! agent-credential-mint — Soulbound Agent Passport via Token-2022
//!
//! Issues a NonTransferable Token-2022 credential token alongside each Dark Passport
//! PDA binding (secp256r1 / secp256k1). The protocol retains a PermanentDelegate PDA
//! for revocation (burn) without requiring the agent's cooperation.
//!
//! Production flow (IS_MAINNET_READY = true, `--features mainnet`):
//!   IssueCredential  — Mints 1 NonTransferable token; PermanentDelegate = protocol_authority.
//!                      TokenMetadata stores agent_id, device_pubkey, binding_type, issued_at.
//!                      0.01 USDC issuance fee verified via x402 receipt in instruction data.
//!   RevokeCredential — Protocol burns the token via PermanentDelegate (no agent sig needed).
//!                      CredentialRecord PDA is zeroed + flagged revoked (kept for audit log).
//!   UpgradeCredential — Burns old token, mints new token with updated device_pubkey.
//!                       0.001 USDC re-issuance fee via x402.
//!
//! Devnet flow (IS_MAINNET_READY = false, default):
//!   All Token-2022 CPIs are SKIPPED. Only CredentialRecord PDAs are written/updated.
//!   This preserves the devnet trust model used by dark_secp256r1_vault and
//!   dark_secp256k1_auth.
//!
//! ⚠️  EXTERNALLY UNAUDITED — test pilot. Not reviewed by any third-party auditor.
//!    Deploy: `cargo build-sbf --features mainnet`
//!
//! Instruction layout:
//!   0x01  IssueCredential    [agent_pubkey[32], device_pubkey[33], binding_type[1],
//!                             x402_receipt_hash[32]]
//!   0x02  RevokeCredential   [agent_pubkey[32]]
//!   0x03  UpgradeCredential  [old_device_pubkey[33], new_device_pubkey[33],
//!                             x402_receipt_hash[32]]

use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    pubkey::Pubkey,
};

pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    processor::process(program_id, accounts, data)
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/// Set to true only after a third-party audit and mainnet safety review.
/// Until then all Token-2022 CPIs are skipped; only PDA records are written.
pub const IS_MAINNET_READY: bool = false;

/// Issuance fee in USDC micro-units (6 decimals): 0.01 USDC = 10_000
pub const ISSUE_FEE_USDC_MICRO: u64 = 10_000;

/// Re-issuance fee (device upgrade): 0.001 USDC = 1_000
pub const REISSUE_FEE_USDC_MICRO: u64 = 1_000;

/// PermanentDelegate PDA seeds
pub const PROTOCOL_AUTHORITY_SEED: &[u8] = b"protocol_authority";

/// CredentialRecord PDA seeds prefix
pub const CRED_RECORD_SEED: &[u8] = b"cred";

/// Current passport schema version
pub const PASSPORT_VERSION: u8 = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        error::CredentialError,
        instruction::CredentialInstruction,
        state::{
            BindingType, CredentialRecord, CredentialStatus,
            CRED_DISC, CRED_RECORD_SIZE,
        },
    };
    use solana_program::program_error::ProgramError;

    // ── Compile-time gate: IS_MAINNET_READY must remain false until audited ──

    #[test]
    fn test_not_mainnet_ready() {
        assert!(
            !IS_MAINNET_READY,
            "IS_MAINNET_READY must stay false until third-party audit completes"
        );
    }

    // ── Fee constants sanity ──────────────────────────────────────────────────

    #[test]
    fn test_issue_fee_is_10000_micro_usdc() {
        assert_eq!(ISSUE_FEE_USDC_MICRO, 10_000);
    }

    #[test]
    fn test_reissue_fee_is_1000_micro_usdc() {
        assert_eq!(REISSUE_FEE_USDC_MICRO, 1_000);
    }

    #[test]
    fn test_reissue_fee_less_than_issue_fee() {
        assert!(REISSUE_FEE_USDC_MICRO < ISSUE_FEE_USDC_MICRO);
    }

    // ── Seeds are non-empty ───────────────────────────────────────────────────

    #[test]
    fn test_protocol_authority_seed_nonempty() {
        assert!(!PROTOCOL_AUTHORITY_SEED.is_empty());
    }

    #[test]
    fn test_cred_record_seed_nonempty() {
        assert!(!CRED_RECORD_SEED.is_empty());
    }

    // ── Passport version ─────────────────────────────────────────────────────

    #[test]
    fn test_passport_version_is_one() {
        assert_eq!(PASSPORT_VERSION, 1);
    }

    // ── CredentialRecord size matches layout spec (155 bytes) ─────────────────

    #[test]
    fn test_cred_record_size_is_155() {
        assert_eq!(
            CRED_RECORD_SIZE,
            155,
            "CredentialRecord must be exactly 155 bytes per spec"
        );
    }

    // ── CredentialRecord pack / unpack round-trip (secp256r1) ─────────────────

    #[test]
    fn test_cred_record_pack_unpack_secp256r1() {
        let agent_pubkey = [0xAAu8; 32];
        let mut device_pubkey = [0u8; 33];
        device_pubkey[0] = 0x02;
        for i in 1..33 {
            device_pubkey[i] = i as u8;
        }
        let credential_mint = [0xBBu8; 32];
        let agent_id_hash   = [0xCCu8; 32];

        let record = CredentialRecord {
            disc:             CRED_DISC,
            agent_pubkey,
            device_pubkey,
            binding_type:     BindingType::Secp256r1,
            credential_mint,
            issued_at_slot:   123_456_789_u64,
            issued_at_unix:   1_717_000_000_u64,
            passport_version: PASSPORT_VERSION,
            agent_id_hash,
            status:           CredentialStatus::Active,
            binding_version:  0,
            _reserved:        [0u8; 4],
        };

        let mut buf = [0u8; CRED_RECORD_SIZE];
        record.pack_into(&mut buf);

        let unpacked = CredentialRecord::unpack_from(&buf).expect("unpack must succeed");

        assert_eq!(unpacked.agent_pubkey,       agent_pubkey);
        assert_eq!(unpacked.device_pubkey,      device_pubkey);
        assert_eq!(unpacked.binding_type,       BindingType::Secp256r1);
        assert_eq!(unpacked.credential_mint,    credential_mint);
        assert_eq!(unpacked.issued_at_slot,     123_456_789_u64);
        assert_eq!(unpacked.issued_at_unix,     1_717_000_000_u64);
        assert_eq!(unpacked.passport_version,   PASSPORT_VERSION);
        assert_eq!(unpacked.agent_id_hash,      agent_id_hash);
        assert_eq!(unpacked.status,             CredentialStatus::Active);
        assert_eq!(unpacked.binding_version,    0);
    }

    // ── CredentialRecord pack / unpack round-trip (secp256k1) ─────────────────

    #[test]
    fn test_cred_record_pack_unpack_secp256k1() {
        let agent_pubkey    = [0x11u8; 32];
        let device_pubkey   = [0x04u8; 33]; // uncompressed prefix, ETH style
        let credential_mint = [0x22u8; 32];
        let agent_id_hash   = [0x33u8; 32];

        let record = CredentialRecord {
            disc:             CRED_DISC,
            agent_pubkey,
            device_pubkey,
            binding_type:     BindingType::Secp256k1,
            credential_mint,
            issued_at_slot:   9_999_u64,
            issued_at_unix:   2_000_000_000_u64,
            passport_version: PASSPORT_VERSION,
            agent_id_hash,
            status:           CredentialStatus::Active,
            binding_version:  1,
            _reserved:        [0u8; 4],
        };

        let mut buf = [0u8; CRED_RECORD_SIZE];
        record.pack_into(&mut buf);

        let unpacked = CredentialRecord::unpack_from(&buf).expect("unpack must succeed");

        assert_eq!(unpacked.binding_type,  BindingType::Secp256k1);
        assert_eq!(unpacked.binding_version, 1);
        assert_eq!(unpacked.issued_at_unix, 2_000_000_000_u64);
    }

    // ── Revoked status round-trip ─────────────────────────────────────────────

    #[test]
    fn test_cred_record_revoked_status_roundtrip() {
        let mut record = CredentialRecord {
            disc:             CRED_DISC,
            agent_pubkey:     [0xFFu8; 32],
            device_pubkey:    [0x02u8; 33],
            binding_type:     BindingType::Secp256r1,
            credential_mint:  [0xEEu8; 32],
            issued_at_slot:   1_u64,
            issued_at_unix:   2_u64,
            passport_version: PASSPORT_VERSION,
            agent_id_hash:    [0xDDu8; 32],
            status:           CredentialStatus::Active,
            binding_version:  0,
            _reserved:        [0u8; 4],
        };

        // Simulate revocation
        record.status = CredentialStatus::Revoked;

        let mut buf = [0u8; CRED_RECORD_SIZE];
        record.pack_into(&mut buf);
        let unpacked = CredentialRecord::unpack_from(&buf).expect("unpack must succeed");

        assert_eq!(unpacked.status, CredentialStatus::Revoked);
        // agent_pubkey and other fields preserved for audit log
        assert_eq!(unpacked.agent_pubkey, [0xFFu8; 32]);
    }

    // ── Instruction 0x01 unpack valid ─────────────────────────────────────────

    #[test]
    fn test_instruction_issue_credential_unpack_valid() {
        let agent_pubkey      = [0x01u8; 32];
        let device_pubkey     = [0x02u8; 33];
        let binding_type_byte = 0x01u8; // secp256r1
        let x402_receipt_hash = [0x03u8; 32];

        let mut data = vec![0x01u8];
        data.extend_from_slice(&agent_pubkey);
        data.extend_from_slice(&device_pubkey);
        data.push(binding_type_byte);
        data.extend_from_slice(&x402_receipt_hash);

        // Total: 1 + 32 + 33 + 1 + 32 = 99 bytes
        assert_eq!(data.len(), 99);

        match CredentialInstruction::unpack(&data).expect("unpack must succeed") {
            CredentialInstruction::IssueCredential {
                agent_pubkey:      ap,
                device_pubkey:     dp,
                binding_type:      bt,
                x402_receipt_hash: rh,
            } => {
                assert_eq!(ap, agent_pubkey);
                assert_eq!(dp, device_pubkey);
                assert_eq!(bt, BindingType::Secp256r1);
                assert_eq!(rh, x402_receipt_hash);
            }
            _ => panic!("expected IssueCredential"),
        }
    }

    // ── Instruction 0x01 unpack secp256k1 binding type ───────────────────────

    #[test]
    fn test_instruction_issue_credential_secp256k1() {
        let mut data = vec![0x01u8];
        data.extend_from_slice(&[0xAAu8; 32]); // agent_pubkey
        data.extend_from_slice(&[0x04u8; 33]); // device_pubkey
        data.push(0x02u8);                       // secp256k1
        data.extend_from_slice(&[0xBBu8; 32]); // x402_receipt_hash

        match CredentialInstruction::unpack(&data).expect("unpack must succeed") {
            CredentialInstruction::IssueCredential { binding_type, .. } => {
                assert_eq!(binding_type, BindingType::Secp256k1);
            }
            _ => panic!("expected IssueCredential"),
        }
    }

    // ── Instruction 0x01 too short → InvalidInstructionData ──────────────────

    #[test]
    fn test_instruction_issue_too_short() {
        // 50 bytes of payload (need >= 98 after discriminant)
        let data: Vec<u8> = std::iter::once(0x01u8).chain(vec![0u8; 50]).collect();
        let err = CredentialInstruction::unpack(&data).unwrap_err();
        match err {
            ProgramError::Custom(c) => assert_eq!(c, CredentialError::InvalidInstructionData as u32),
            _ => panic!("expected Custom(CredentialError::InvalidInstructionData)"),
        }
    }

    // ── Instruction 0x02 unpack valid ─────────────────────────────────────────

    #[test]
    fn test_instruction_revoke_credential_unpack_valid() {
        let agent_pubkey = [0x55u8; 32];

        let mut data = vec![0x02u8];
        data.extend_from_slice(&agent_pubkey);
        // Total: 1 + 32 = 33 bytes

        match CredentialInstruction::unpack(&data).expect("unpack must succeed") {
            CredentialInstruction::RevokeCredential { agent_pubkey: ap } => {
                assert_eq!(ap, agent_pubkey);
            }
            _ => panic!("expected RevokeCredential"),
        }
    }

    // ── Instruction 0x02 too short → error ───────────────────────────────────

    #[test]
    fn test_instruction_revoke_too_short() {
        let data = vec![0x02u8; 10]; // only 9 bytes after disc, need 32
        assert!(CredentialInstruction::unpack(&data).is_err());
    }

    // ── Instruction 0x03 unpack valid ─────────────────────────────────────────

    #[test]
    fn test_instruction_upgrade_credential_unpack_valid() {
        let old_device = [0x10u8; 33];
        let new_device = [0x20u8; 33];
        let receipt    = [0x30u8; 32];

        let mut data = vec![0x03u8];
        data.extend_from_slice(&old_device);
        data.extend_from_slice(&new_device);
        data.extend_from_slice(&receipt);
        // Total: 1 + 33 + 33 + 32 = 99 bytes

        assert_eq!(data.len(), 99);

        match CredentialInstruction::unpack(&data).expect("unpack must succeed") {
            CredentialInstruction::UpgradeCredential {
                old_device_pubkey: od,
                new_device_pubkey: nd,
                x402_receipt_hash: rh,
            } => {
                assert_eq!(od, old_device);
                assert_eq!(nd, new_device);
                assert_eq!(rh, receipt);
            }
            _ => panic!("expected UpgradeCredential"),
        }
    }

    // ── Instruction 0x03 too short → error ───────────────────────────────────

    #[test]
    fn test_instruction_upgrade_too_short() {
        let data: Vec<u8> = std::iter::once(0x03u8).chain(vec![0u8; 60]).collect();
        assert!(CredentialInstruction::unpack(&data).is_err());
    }

    // ── Unknown instruction discriminant → InvalidInstructionData ────────────

    #[test]
    fn test_instruction_unknown_tag() {
        let data = vec![0xFFu8; 99];
        assert!(CredentialInstruction::unpack(&data).is_err());
    }

    // ── Binding type byte 0x00 → InvalidBindingType ───────────────────────────

    #[test]
    fn test_instruction_issue_invalid_binding_type() {
        let mut data = vec![0x01u8];
        data.extend_from_slice(&[0u8; 32]); // agent_pubkey
        data.extend_from_slice(&[0u8; 33]); // device_pubkey
        data.push(0x00u8);                   // invalid binding_type
        data.extend_from_slice(&[0u8; 32]); // x402_receipt_hash

        let err = CredentialInstruction::unpack(&data).unwrap_err();
        match err {
            ProgramError::Custom(c) => assert_eq!(c, CredentialError::InvalidBindingType as u32),
            _ => panic!("expected Custom(CredentialError::InvalidBindingType)"),
        }
    }

    // ── Error codes are in expected range ────────────────────────────────────

    #[test]
    fn test_error_codes_range() {
        // Verify first few error codes are non-overlapping and non-zero
        let not_mainnet_ready = CredentialError::NotMainnetReady as u32;
        let already_issued    = CredentialError::AlreadyIssued    as u32;
        let not_found         = CredentialError::CredentialNotFound as u32;
        let already_revoked   = CredentialError::AlreadyRevoked   as u32;
        let bad_ix            = CredentialError::InvalidInstructionData as u32;
        let bad_binding       = CredentialError::InvalidBindingType as u32;
        let unauthorized      = CredentialError::Unauthorized      as u32;

        assert_ne!(not_mainnet_ready, already_issued);
        assert_ne!(already_issued,    not_found);
        assert_ne!(not_found,         already_revoked);
        assert_ne!(already_revoked,   bad_ix);
        assert_ne!(bad_ix,            bad_binding);
        assert_ne!(bad_binding,       unauthorized);
    }

    // ── agent_id_hash is deterministic SHA-256(agent_pubkey || device_pubkey) ─

    #[test]
    fn test_agent_id_hash_deterministic() {
        use sha2::{Digest, Sha256};

        let agent_pubkey  = [0xA1u8; 32];
        let device_pubkey = [0xB2u8; 33];

        let mut h = Sha256::new();
        h.update(agent_pubkey);
        h.update(device_pubkey);
        let hash1: [u8; 32] = h.finalize().into();

        let mut h2 = Sha256::new();
        h2.update(agent_pubkey);
        h2.update(device_pubkey);
        let hash2: [u8; 32] = h2.finalize().into();

        assert_eq!(hash1, hash2);
        assert_ne!(hash1, [0u8; 32]);
    }

    // ── agent_id_hash differs for different inputs ────────────────────────────

    #[test]
    fn test_agent_id_hash_input_sensitive() {
        use sha2::{Digest, Sha256};

        let agent_a = [0xA1u8; 32];
        let agent_b = [0xA2u8; 32];
        let device  = [0xB1u8; 33];

        let mut h1 = Sha256::new();
        h1.update(agent_a);
        h1.update(device);
        let hash_a: [u8; 32] = h1.finalize().into();

        let mut h2 = Sha256::new();
        h2.update(agent_b);
        h2.update(device);
        let hash_b: [u8; 32] = h2.finalize().into();

        assert_ne!(hash_a, hash_b);
    }
}
