pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

pub const SCRATCH_SEED: &[u8] = b"scratch";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        error::ScratchError,
        state::{ScratchAccount, SCRATCH_LEN, SCRATCH_VERSION},
    };

    #[test]
    fn test_scratch_seed_content() {
        assert_eq!(SCRATCH_SEED, b"scratch");
    }

    #[test]
    fn test_scratch_seed_len() {
        assert_eq!(SCRATCH_SEED.len(), 7);
    }

    #[test]
    fn test_scratch_len() {
        assert_eq!(SCRATCH_LEN, 58);
    }

    #[test]
    fn test_scratch_version() {
        assert_eq!(SCRATCH_VERSION, 1);
    }

    #[test]
    fn test_scratch_pack_unpack_roundtrip() {
        let acc = ScratchAccount {
            version: SCRATCH_VERSION,
            bump: 2,
            owner: [0xbbu8; 32],
            expires_at_slot: 50_000,
            tag: [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08],
            created_at_slot: 10_000,
        };
        let mut buf = [0u8; SCRATCH_LEN];
        acc.pack_into(&mut buf);
        let unpacked = ScratchAccount::unpack(&buf).expect("should unpack");
        assert_eq!(unpacked.version, acc.version);
        assert_eq!(unpacked.bump, acc.bump);
        assert_eq!(unpacked.owner, acc.owner);
        assert_eq!(unpacked.expires_at_slot, acc.expires_at_slot);
        assert_eq!(unpacked.tag, acc.tag);
        assert_eq!(unpacked.created_at_slot, acc.created_at_slot);
    }

    #[test]
    fn test_scratch_unpack_version_mismatch() {
        let mut buf = [0u8; SCRATCH_LEN];
        buf[0] = 2; // wrong version
        assert!(ScratchAccount::unpack(&buf).is_none());
    }

    #[test]
    fn test_scratch_unpack_too_short() {
        let buf = [SCRATCH_VERSION; 20];
        assert!(ScratchAccount::unpack(&buf).is_none());
    }

    #[test]
    fn test_owner_preserved() {
        let acc = ScratchAccount {
            version: SCRATCH_VERSION,
            bump: 0,
            owner: [0xddu8; 32],
            expires_at_slot: 1,
            tag: [0u8; 8],
            created_at_slot: 0,
        };
        let mut buf = [0u8; SCRATCH_LEN];
        acc.pack_into(&mut buf);
        let unpacked = ScratchAccount::unpack(&buf).unwrap();
        assert_eq!(unpacked.owner, [0xddu8; 32]);
    }

    #[test]
    fn test_expires_at_slot_preserved() {
        let acc = ScratchAccount {
            version: SCRATCH_VERSION,
            bump: 0,
            owner: [0u8; 32],
            expires_at_slot: u64::MAX,
            tag: [0u8; 8],
            created_at_slot: 0,
        };
        let mut buf = [0u8; SCRATCH_LEN];
        acc.pack_into(&mut buf);
        let unpacked = ScratchAccount::unpack(&buf).unwrap();
        assert_eq!(unpacked.expires_at_slot, u64::MAX);
    }

    #[test]
    fn test_tag_preserved() {
        let tag = [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xefu8];
        let acc = ScratchAccount {
            version: SCRATCH_VERSION,
            bump: 0,
            owner: [0u8; 32],
            expires_at_slot: 0,
            tag,
            created_at_slot: 0,
        };
        let mut buf = [0u8; SCRATCH_LEN];
        acc.pack_into(&mut buf);
        let unpacked = ScratchAccount::unpack(&buf).unwrap();
        assert_eq!(unpacked.tag, tag);
    }

    #[test]
    fn test_error_invalid_instruction_code() {
        assert_eq!(ScratchError::InvalidInstruction as u32, 0);
    }

    #[test]
    fn test_error_invalid_pda_code() {
        assert_eq!(ScratchError::InvalidPda as u32, 1);
    }

    #[test]
    fn test_error_missing_owner_sig_code() {
        assert_eq!(ScratchError::MissingOwnerSignature as u32, 2);
    }

    #[test]
    fn test_error_not_expired_code() {
        assert_eq!(ScratchError::NotExpired as u32, 3);
    }

    #[test]
    fn test_error_missing_system_program_code() {
        assert_eq!(ScratchError::MissingSystemProgram as u32, 4);
    }

    #[test]
    fn test_error_arithmetic_overflow_code() {
        assert_eq!(ScratchError::ArithmeticOverflow as u32, 5);
    }
}

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    use crate::processor::process;
    use solana_program::{
        account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
    };
    entrypoint!(process_instruction);
    fn process_instruction(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        data: &[u8],
    ) -> ProgramResult {
        process(program_id, accounts, data)
    }
}
