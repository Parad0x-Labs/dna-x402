//! null-registrar — .null domain name registrar for Solana
//!
//! The .null namespace belongs to no government, ICANN, or corporation.
//! Domains are registered by paying a fee that TRANSFERS to the protocol
//! treasury (never burned), and resolve to Arweave/IPFS content hashes —
//! permanent, unstoppable, agent-native.
//!
//! ⚠️  LEGACY / ILLUSTRATIVE SOURCE — NOT the live mainnet program.
//!     This is the v1 design (NULL-priced, IS_MAINNET_READY gate). The LIVE mainnet
//!     registrar is v2 — SOL-priced (~0.01 SOL all-in), config-driven via SetConfig,
//!     free during the pilot — at H4wbFJucY9shJt95N8Bra532Z4nnkKhGEfqWvLcYfuDm.
//!     Canonical v2 source/spec: the web0-internal repo. Do NOT deploy this v1 source.
//!
//! ⚠️  EXTERNALLY UNAUDITED — test pilot. Not reviewed by any third-party auditor.
//!    Deploy: `cargo build-sbf --features mainnet`
//!
//! IS_MAINNET_READY = false:
//!   - NULL token SPL transfer CPI is skipped (fee accounting only).
//!   - All PDA creation and state writes work normally.
//!   - Switch to `true` after security audit + treasury ATA wiring.

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

/// Pre-audit pilot flag.
/// When false, NULL token SPL transfer CPIs are skipped.
/// Flip to true only after third-party audit and treasury wiring.
pub const IS_MAINNET_READY: bool = false;

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    processor::process(program_id, accounts, data)
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use crate::{
        error::RegistrarError,
        instruction::{
            validate_name, RegistrarInstruction,
            IX_INIT_REGISTRY, IX_REGISTER, IX_UPDATE_CONTENT, IX_TRANSFER, IX_RESOLVE,
        },
        state::{
            NullDomain,    NULL_DOMAIN_SIZE,    NULL_DOMAIN_DISC,
            RegistryConfig, REGISTRY_CONFIG_SIZE, REGISTRY_CONFIG_DISC,
        },
    };
    use solana_program::program_error::ProgramError;

    // ── 1. NullDomain pack / unpack round-trip ────────────────────────────

    #[test]
    fn test_null_domain_pack_unpack() {
        let mut name = [0u8; 64];
        b"parad0x".iter().enumerate().for_each(|(i, &b)| name[i] = b);

        let owner        = [0xAAu8; 32];
        let content_hash = [0xBBu8; 32];

        let domain = NullDomain {
            disc:          NULL_DOMAIN_DISC,
            name,
            owner,
            content_hash,
            registered_at: 1_700_000_000,
            expires_at:    0,
            null_paid:     500_000_000,
            bump:          254,
        };

        let mut buf = vec![0u8; NULL_DOMAIN_SIZE];
        domain.pack_into(&mut buf);

        let unpacked = NullDomain::unpack_from(&buf).expect("unpack failed");
        assert_eq!(unpacked.disc,          NULL_DOMAIN_DISC);
        assert_eq!(unpacked.name,          name);
        assert_eq!(unpacked.owner,         owner);
        assert_eq!(unpacked.content_hash,  content_hash);
        assert_eq!(unpacked.registered_at, 1_700_000_000);
        assert_eq!(unpacked.expires_at,    0);
        assert_eq!(unpacked.null_paid,     500_000_000);
        assert_eq!(unpacked.bump,          254);
    }

    // ── 2. NullDomain size is exactly 154 bytes ───────────────────────────

    #[test]
    fn test_null_domain_size_is_154() {
        assert_eq!(NULL_DOMAIN_SIZE, 154, "NullDomain must be exactly 154 bytes");
    }

    // ── 3. RegistryConfig pack / unpack round-trip ────────────────────────

    #[test]
    fn test_registry_config_pack_unpack() {
        let authority  = [0x11u8; 32];
        let null_mint  = [0x22u8; 32];
        let treasury   = [0x33u8; 32];

        let cfg = RegistryConfig {
            disc:              REGISTRY_CONFIG_DISC,
            authority,
            registration_fee:  1_000_000_000,
            null_mint,
            treasury,
            total_registered:  42,
            bump:              255,
        };

        let mut buf = vec![0u8; REGISTRY_CONFIG_SIZE];
        cfg.pack_into(&mut buf);

        let unpacked = RegistryConfig::unpack_from(&buf).expect("unpack failed");
        assert_eq!(unpacked.disc,             REGISTRY_CONFIG_DISC);
        assert_eq!(unpacked.authority,        authority);
        assert_eq!(unpacked.registration_fee, 1_000_000_000);
        assert_eq!(unpacked.null_mint,        null_mint);
        assert_eq!(unpacked.treasury,         treasury);
        assert_eq!(unpacked.total_registered, 42);
        assert_eq!(unpacked.bump,             255);
    }

    // ── 4. RegistryConfig size is exactly 114 bytes ───────────────────────

    #[test]
    fn test_registry_config_size_is_114() {
        assert_eq!(REGISTRY_CONFIG_SIZE, 114, "RegistryConfig must be exactly 114 bytes");
    }

    // ── 5. Instruction 0x01 unpack valid ─────────────────────────────────

    #[test]
    fn test_unpack_0x01_valid() {
        let null_mint = [0xCCu8; 32];
        let treasury  = [0xDDu8; 32];
        let fee       = 5_000_000_000u64;

        let mut data = vec![IX_INIT_REGISTRY];
        data.extend_from_slice(&fee.to_le_bytes());
        data.extend_from_slice(&null_mint);
        data.extend_from_slice(&treasury);

        match RegistrarInstruction::unpack(&data).expect("unpack failed") {
            RegistrarInstruction::InitRegistry {
                registration_fee,
                null_mint: nm,
                treasury: tr,
            } => {
                assert_eq!(registration_fee, fee);
                assert_eq!(nm,              null_mint);
                assert_eq!(tr,              treasury);
            }
            _ => panic!("wrong variant"),
        }
    }

    // ── 6. Instruction 0x02 unpack valid ─────────────────────────────────

    #[test]
    fn test_unpack_0x02_valid() {
        let mut name = [0u8; 64];
        b"goblin".iter().enumerate().for_each(|(i, &b)| name[i] = b);
        let content_hash = [0xFFu8; 32];

        let mut data = vec![IX_REGISTER];
        data.extend_from_slice(&name);
        data.extend_from_slice(&content_hash);

        match RegistrarInstruction::unpack(&data).expect("unpack failed") {
            RegistrarInstruction::Register { name: n, content_hash: c } => {
                assert_eq!(n, name);
                assert_eq!(c, content_hash);
            }
            _ => panic!("wrong variant"),
        }
    }

    // ── 7. Instruction 0x03 unpack valid ─────────────────────────────────

    #[test]
    fn test_unpack_0x03_valid() {
        let mut name = [0u8; 64];
        b"parad0x".iter().enumerate().for_each(|(i, &b)| name[i] = b);
        let new_hash = [0xAAu8; 32];

        let mut data = vec![IX_UPDATE_CONTENT];
        data.extend_from_slice(&name);
        data.extend_from_slice(&new_hash);

        match RegistrarInstruction::unpack(&data).expect("unpack failed") {
            RegistrarInstruction::UpdateContent { name: n, new_content_hash: h } => {
                assert_eq!(n, name);
                assert_eq!(h, new_hash);
            }
            _ => panic!("wrong variant"),
        }
    }

    // ── 8. Instruction 0x04 unpack valid ─────────────────────────────────

    #[test]
    fn test_unpack_0x04_valid() {
        let mut name  = [0u8; 64];
        b"dark".iter().enumerate().for_each(|(i, &b)| name[i] = b);
        let new_owner = [0x55u8; 32];

        let mut data = vec![IX_TRANSFER];
        data.extend_from_slice(&name);
        data.extend_from_slice(&new_owner);

        match RegistrarInstruction::unpack(&data).expect("unpack failed") {
            RegistrarInstruction::Transfer { name: n, new_owner: o } => {
                assert_eq!(n, name);
                assert_eq!(o, new_owner);
            }
            _ => panic!("wrong variant"),
        }
    }

    // ── 9. Instruction 0x05 unpack valid ─────────────────────────────────

    #[test]
    fn test_unpack_0x05_valid() {
        let mut name = [0u8; 64];
        b"null".iter().enumerate().for_each(|(i, &b)| name[i] = b);

        let mut data = vec![IX_RESOLVE];
        data.extend_from_slice(&name);

        match RegistrarInstruction::unpack(&data).expect("unpack failed") {
            RegistrarInstruction::Resolve { name: n } => assert_eq!(n, name),
            _ => panic!("wrong variant"),
        }
    }

    // ── 10. validate_name: valid names ───────────────────────────────────

    #[test]
    fn test_validate_name_valid() {
        let cases: &[&[u8]] = &[
            b"parad0x",
            b"goblin",
            b"agent-007",
            b"x402",
            b"null",
            b"a",
        ];
        for &raw in cases {
            let mut name = [0u8; 64];
            name[..raw.len()].copy_from_slice(raw);
            validate_name(&name).unwrap_or_else(|_| panic!("expected valid: {:?}", raw));
        }
    }

    // ── 11. validate_name: too long (>32 chars) ───────────────────────────

    #[test]
    fn test_validate_name_too_long() {
        let raw = b"this-name-is-way-too-long-for-dot-null"; // 38 chars
        let mut name = [0u8; 64];
        name[..raw.len()].copy_from_slice(raw);
        let err = validate_name(&name).unwrap_err();
        match err {
            ProgramError::Custom(c) => assert_eq!(c, RegistrarError::NameTooLong as u32),
            _ => panic!("expected NameTooLong"),
        }
    }

    // ── 12. validate_name: uppercase letter → InvalidName ─────────────────

    #[test]
    fn test_validate_name_uppercase() {
        let mut name = [0u8; 64];
        b"Parad0x".iter().enumerate().for_each(|(i, &b)| name[i] = b);
        let err = validate_name(&name).unwrap_err();
        match err {
            ProgramError::Custom(c) => assert_eq!(c, RegistrarError::InvalidName as u32),
            _ => panic!("expected InvalidName"),
        }
    }

    // ── 13. validate_name: dot character → InvalidName ────────────────────

    #[test]
    fn test_validate_name_dot() {
        let mut name = [0u8; 64];
        b"para.d0x".iter().enumerate().for_each(|(i, &b)| name[i] = b);
        let err = validate_name(&name).unwrap_err();
        match err {
            ProgramError::Custom(c) => assert_eq!(c, RegistrarError::InvalidName as u32),
            _ => panic!("expected InvalidName"),
        }
    }

    // ── 14. validate_name: empty → InvalidName ───────────────────────────

    #[test]
    fn test_validate_name_empty() {
        let name = [0u8; 64];
        let err = validate_name(&name).unwrap_err();
        match err {
            ProgramError::Custom(c) => assert_eq!(c, RegistrarError::InvalidName as u32),
            _ => panic!("expected InvalidName"),
        }
    }

    // ── 15. Error codes match spec ───────────────────────────────────────

    #[test]
    fn test_error_codes() {
        assert_eq!(RegistrarError::NameAlreadyRegistered as u32, 0x7001);
        assert_eq!(RegistrarError::NameTooLong           as u32, 0x7002);
        assert_eq!(RegistrarError::InsufficientNullBalance as u32, 0x7003);
        assert_eq!(RegistrarError::NotOwner              as u32, 0x7004);
        assert_eq!(RegistrarError::InvalidName           as u32, 0x7005);
    }

    // ── 16. RegistryConfig wrong disc → unpack returns None ───────────────

    #[test]
    fn test_registry_config_wrong_disc() {
        let mut buf = vec![0u8; REGISTRY_CONFIG_SIZE];
        buf[0] = 0xFF; // wrong discriminant
        assert!(RegistryConfig::unpack_from(&buf).is_none());
    }

    // ── 17. NullDomain wrong disc → unpack returns None ───────────────────

    #[test]
    fn test_null_domain_wrong_disc() {
        let mut buf = vec![0u8; NULL_DOMAIN_SIZE];
        buf[0] = 0x00; // wrong discriminant
        assert!(NullDomain::unpack_from(&buf).is_none());
    }

    // ── 18. IS_MAINNET_READY is false (pre-audit guard) ───────────────────

    #[test]
    fn test_is_mainnet_ready_false() {
        assert!(
            !crate::IS_MAINNET_READY,
            "IS_MAINNET_READY must be false until post-audit"
        );
    }
}
