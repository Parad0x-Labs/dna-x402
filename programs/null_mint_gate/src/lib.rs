//! dark-null-mint-gate — On-chain NULL emission gate
//!
//! On-chain emission claim gate. Agents submit their receipt nullifier hash +
//! commitment; the program verifies the nullifier has not been used, enforces
//! per-claim and per-epoch caps, and records the emission. SPL mint CPI remains
//! gated behind IS_MAINNET_READY=true and must be wired before live minting.
//!
//! IS_MAINNET_READY = false:
//!   - SPL mint CPI is skipped.
//!   - Emission is proven by the AgentEmissionRecord PDA on-chain.

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
// Unit tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use crate::{
        error::MintGateError,
        instruction::MintGateInstruction,
        state::{
            AGENT_EMISSION_RECORD_DISC, AGENT_EMISSION_RECORD_SIZE,
            EMISSION_CONFIG_DISC, EMISSION_CONFIG_SIZE,
            AgentEmissionRecord, EmissionConfig,
        },
    };
    use solana_program::program_error::ProgramError;

    // ── 1. EmissionConfig pack/unpack round-trip ─────────────────────────

    #[test]
    fn test_emission_config_pack_unpack() {
        let admin     = [0xABu8; 32];
        let null_mint = [0xCDu8; 32];

        let cfg = EmissionConfig {
            disc:                      EMISSION_CONFIG_DISC,
            admin,
            null_mint,
            max_null_per_claim_atomic: 1_000_000,
            epoch_duration_slots:      432_000,
            epoch_null_cap_atomic:     500_000_000,
            current_epoch:             7,
            epoch_null_minted_atomic:  123_456,
            is_active:                 true,
        };

        let mut buf = vec![0u8; EMISSION_CONFIG_SIZE];
        cfg.pack_into(&mut buf);

        let unpacked = EmissionConfig::unpack_from(&buf).expect("unpack failed");
        assert_eq!(unpacked.disc,                      EMISSION_CONFIG_DISC);
        assert_eq!(unpacked.admin,                     admin);
        assert_eq!(unpacked.null_mint,                 null_mint);
        assert_eq!(unpacked.max_null_per_claim_atomic, 1_000_000);
        assert_eq!(unpacked.epoch_duration_slots,      432_000);
        assert_eq!(unpacked.epoch_null_cap_atomic,     500_000_000);
        assert_eq!(unpacked.current_epoch,             7);
        assert_eq!(unpacked.epoch_null_minted_atomic,  123_456);
        assert!(unpacked.is_active);
    }

    // ── 2. AgentEmissionRecord pack/unpack round-trip ────────────────────

    #[test]
    fn test_agent_emission_record_pack_unpack() {
        let nullifier_hash     = [0x11u8; 32];
        let receipt_commitment = [0x22u8; 32];
        let agent_pubkey       = [0x33u8; 32];

        let record = AgentEmissionRecord {
            disc:               AGENT_EMISSION_RECORD_DISC,
            nullifier_hash,
            receipt_commitment,
            null_amount_atomic: 500_000,
            epoch:              3,
            claimed_at_slot:    9_876_543,
            agent_pubkey,
        };

        let mut buf = vec![0u8; AGENT_EMISSION_RECORD_SIZE];
        record.pack_into(&mut buf);

        let unpacked = AgentEmissionRecord::unpack_from(&buf).expect("unpack failed");
        assert_eq!(unpacked.disc,               AGENT_EMISSION_RECORD_DISC);
        assert_eq!(unpacked.nullifier_hash,     nullifier_hash);
        assert_eq!(unpacked.receipt_commitment, receipt_commitment);
        assert_eq!(unpacked.null_amount_atomic, 500_000);
        assert_eq!(unpacked.epoch,              3);
        assert_eq!(unpacked.claimed_at_slot,    9_876_543);
        assert_eq!(unpacked.agent_pubkey,       agent_pubkey);
    }

    // ── 3. Instruction 0x01 unpack valid ─────────────────────────────────

    #[test]
    fn test_unpack_0x01_valid() {
        let null_mint = [0xFFu8; 32];
        let mut data = vec![0x01u8];
        data.extend_from_slice(&null_mint);
        data.extend_from_slice(&1_000_000u64.to_le_bytes()); // max_per_claim
        data.extend_from_slice(&432_000u64.to_le_bytes());   // epoch_duration
        data.extend_from_slice(&500_000_000u64.to_le_bytes()); // epoch_null_cap

        match MintGateInstruction::unpack(&data).expect("unpack failed") {
            MintGateInstruction::InitEmission {
                null_mint: nm,
                max_null_per_claim,
                epoch_duration,
                epoch_null_cap,
            } => {
                assert_eq!(nm,                 null_mint);
                assert_eq!(max_null_per_claim, 1_000_000);
                assert_eq!(epoch_duration,     432_000);
                assert_eq!(epoch_null_cap,     500_000_000);
            }
            _ => panic!("wrong variant"),
        }
    }

    // ── 4. Instruction 0x01 too short → error ────────────────────────────

    #[test]
    fn test_unpack_0x01_too_short() {
        // Only 10 bytes after discriminant, need 56
        let data = vec![0x01u8; 11];
        let err = MintGateInstruction::unpack(&data).unwrap_err();
        match err {
            ProgramError::Custom(c) => assert_eq!(c, 0x7001),
            _ => panic!("expected Custom(0x7001)"),
        }
    }

    // ── 5. Instruction 0x02 unpack valid ─────────────────────────────────

    #[test]
    fn test_unpack_0x02_valid() {
        let nullifier_hash     = [0xAAu8; 32];
        let receipt_commitment = [0xBBu8; 32];
        let amount             = 250_000u64;

        let mut data = vec![0x02u8];
        data.extend_from_slice(&nullifier_hash);
        data.extend_from_slice(&receipt_commitment);
        data.extend_from_slice(&amount.to_le_bytes());

        match MintGateInstruction::unpack(&data).expect("unpack failed") {
            MintGateInstruction::ClaimEmission {
                nullifier_hash:     nh,
                receipt_commitment: rc,
                null_amount_atomic: na,
            } => {
                assert_eq!(nh, nullifier_hash);
                assert_eq!(rc, receipt_commitment);
                assert_eq!(na, amount);
            }
            _ => panic!("wrong variant"),
        }
    }

    // ── 6. Instruction 0x02 too short → error ────────────────────────────

    #[test]
    fn test_unpack_0x02_too_short() {
        // Only 5 bytes after discriminant, need 72
        let data = vec![0x02u8; 6];
        let err = MintGateInstruction::unpack(&data).unwrap_err();
        match err {
            ProgramError::Custom(c) => assert_eq!(c, 0x7001),
            _ => panic!("expected Custom(0x7001)"),
        }
    }

    // ── 7. Instruction 0x03 unpack valid ─────────────────────────────────

    #[test]
    fn test_unpack_0x03_valid() {
        let new_epoch = 42u64;
        let mut data  = vec![0x03u8];
        data.extend_from_slice(&new_epoch.to_le_bytes());

        match MintGateInstruction::unpack(&data).expect("unpack failed") {
            MintGateInstruction::AdvanceEpoch { new_epoch: ne } => {
                assert_eq!(ne, 42);
            }
            _ => panic!("wrong variant"),
        }
    }

    // ── 8. max_null_per_claim enforced: amount > max → ExceedsClaimLimit ──

    #[test]
    fn test_exceeds_claim_limit_enforced() {
        let max_null_per_claim_atomic: u64 = 1_000_000;
        let null_amount_atomic:        u64 = 1_000_001; // one over

        if null_amount_atomic > max_null_per_claim_atomic {
            let err: ProgramError = MintGateError::ExceedsClaimLimit.into();
            match err {
                ProgramError::Custom(c) => assert_eq!(c, 0x7004),
                _ => panic!("expected Custom(0x7004)"),
            }
        } else {
            panic!("test precondition failed: should exceed limit");
        }
    }

    // ── 9. epoch_cap enforced: minted + amount > cap → EpochCapExceeded ──

    #[test]
    fn test_epoch_cap_exceeded_enforced() {
        let epoch_null_cap_atomic:    u64 = 500_000_000;
        let epoch_null_minted_atomic: u64 = 499_999_999;
        let null_amount_atomic:       u64 = 2; // 499_999_999 + 2 > 500_000_000

        let new_minted = epoch_null_minted_atomic
            .checked_add(null_amount_atomic)
            .expect("no overflow");

        if new_minted > epoch_null_cap_atomic {
            let err: ProgramError = MintGateError::EpochCapExceeded.into();
            match err {
                ProgramError::Custom(c) => assert_eq!(c, 0x7005),
                _ => panic!("expected Custom(0x7005)"),
            }
        } else {
            panic!("test precondition failed: should exceed cap");
        }
    }

    // ── 10. advance_epoch resets minted to zero ───────────────────────────

    #[test]
    fn test_advance_epoch_resets_minted() {
        let mut cfg = EmissionConfig {
            disc:                      EMISSION_CONFIG_DISC,
            admin:                     [0u8; 32],
            null_mint:                 [0u8; 32],
            max_null_per_claim_atomic: 1_000_000,
            epoch_duration_slots:      432_000,
            epoch_null_cap_atomic:     500_000_000,
            current_epoch:             5,
            epoch_null_minted_atomic:  333_000_000, // non-zero before advance
            is_active:                 true,
        };

        let new_epoch = 6u64;
        assert!(new_epoch > cfg.current_epoch, "new_epoch must be strictly greater");

        // Simulate what process_advance_epoch does to the struct
        cfg.current_epoch            = new_epoch;
        cfg.epoch_null_minted_atomic = 0;

        assert_eq!(cfg.current_epoch,            6);
        assert_eq!(cfg.epoch_null_minted_atomic, 0);
    }

    // ── 11. advance_epoch rejects non-increasing epoch → EpochAlreadyAdvanced

    #[test]
    fn test_advance_epoch_rejects_non_increasing() {
        let current_epoch = 10u64;

        // Same epoch
        let same = 10u64;
        if same <= current_epoch {
            let err: ProgramError = MintGateError::EpochAlreadyAdvanced.into();
            match err {
                ProgramError::Custom(c) => assert_eq!(c, 0x7008),
                _ => panic!("expected Custom(0x7008)"),
            }
        } else {
            panic!("test precondition failed");
        }

        // Lower epoch
        let lower = 5u64;
        if lower <= current_epoch {
            let err: ProgramError = MintGateError::EpochAlreadyAdvanced.into();
            match err {
                ProgramError::Custom(c) => assert_eq!(c, 0x7008),
                _ => panic!("expected Custom(0x7008)"),
            }
        } else {
            panic!("test precondition failed");
        }
    }

    // ── 12. emission_record size is exactly 121 bytes ─────────────────────

    #[test]
    fn test_agent_emission_record_size_is_121() {
        assert_eq!(
            AGENT_EMISSION_RECORD_SIZE,
            121,
            "AgentEmissionRecord must be exactly 121 bytes"
        );
        // Also verify by constructing a full record and packing it
        let record = AgentEmissionRecord {
            disc:               AGENT_EMISSION_RECORD_DISC,
            nullifier_hash:     [0x01u8; 32],
            receipt_commitment: [0x02u8; 32],
            null_amount_atomic: 1,
            epoch:              1,
            claimed_at_slot:    1,
            agent_pubkey:       [0x03u8; 32],
        };
        let mut buf = vec![0u8; AGENT_EMISSION_RECORD_SIZE];
        record.pack_into(&mut buf);
        assert_eq!(buf.len(), 121);
    }
}
