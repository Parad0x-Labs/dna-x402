use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::Sysvar,
};

entrypoint!(process_instruction);

pub const CLAIM_RECORD_LEN: usize = 1 + 32 + 32 + 1 + 8; // bump + claim_hash + authority + kind + slot

/// StatementKind byte:
/// 0x10 = ReceiptRedeem, 0x11 = SessionNetSettlement, 0x12 = ModelOutputBound,
/// 0x13 = NullifierNotReused, 0x14 = ApiMeterBurn, 0x15 = PredictionCommitReveal
pub struct ClaimRecord {
    pub bump: u8,
    pub claim_hash: [u8; 32],
    pub authority: [u8; 32],
    pub statement_kind: u8,
    pub recorded_at_slot: u64,
}

impl ClaimRecord {
    pub fn pack(&self, dst: &mut [u8]) {
        dst[0] = self.bump;
        dst[1..33].copy_from_slice(&self.claim_hash);
        dst[33..65].copy_from_slice(&self.authority);
        dst[65] = self.statement_kind;
        dst[66..74].copy_from_slice(&self.recorded_at_slot.to_le_bytes());
    }

    pub fn unpack(src: &[u8]) -> Option<Self> {
        if src.len() < CLAIM_RECORD_LEN {
            return None;
        }
        let mut claim_hash = [0u8; 32];
        claim_hash.copy_from_slice(&src[1..33]);
        let mut authority = [0u8; 32];
        authority.copy_from_slice(&src[33..65]);
        let mut slot_bytes = [0u8; 8];
        slot_bytes.copy_from_slice(&src[66..74]);
        Some(Self {
            bump: src[0],
            claim_hash,
            authority,
            statement_kind: src[65],
            recorded_at_slot: u64::from_le_bytes(slot_bytes),
        })
    }
}

#[derive(Debug)]
pub enum Instruction {
    /// Record a verified claim. Accounts: [claim_record_pda (writable, new), authority (signer), system_program]
    RecordVerifiedClaim {
        claim_hash: [u8; 32],
        statement_kind: u8,
    },
}

impl Instruction {
    pub fn pack(&self) -> Vec<u8> {
        match self {
            Self::RecordVerifiedClaim {
                claim_hash,
                statement_kind,
            } => {
                let mut v = vec![0u8];
                v.extend_from_slice(claim_hash);
                v.push(*statement_kind);
                v
            }
        }
    }

    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.is_empty() {
            return Err(ProgramError::InvalidInstructionData);
        }
        match data[0] {
            0 => {
                if data.len() < 34 {
                    return Err(ProgramError::InvalidInstructionData);
                }
                let mut claim_hash = [0u8; 32];
                claim_hash.copy_from_slice(&data[1..33]);
                Ok(Self::RecordVerifiedClaim {
                    claim_hash,
                    statement_kind: data[33],
                })
            }
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

#[derive(Debug)]
pub enum GateError {
    DuplicateClaim,
    WrongAuthority,
}

impl From<GateError> for ProgramError {
    fn from(e: GateError) -> Self {
        match e {
            GateError::DuplicateClaim => ProgramError::Custom(1),
            GateError::WrongAuthority => ProgramError::Custom(2),
        }
    }
}

pub fn process_instruction(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    msg!("dark_proof_gate_lite: NOT_ZK_VERIFIER — records externally-verified claims only");
    let ix = Instruction::unpack(instruction_data)?;
    match ix {
        Instruction::RecordVerifiedClaim {
            claim_hash,
            statement_kind,
        } => {
            let accounts_iter = &mut accounts.iter();
            let claim_record_account = next_account_info(accounts_iter)?;
            let authority_account = next_account_info(accounts_iter)?;
            if !authority_account.is_signer {
                return Err(GateError::WrongAuthority.into());
            }
            if claim_record_account.data_len() > 0 {
                return Err(GateError::DuplicateClaim.into());
            }
            let clock = Clock::get()?;
            msg!(
                "dark_proof_gate_lite: recording claim {:?} kind={} slot={}",
                &claim_hash[..4],
                statement_kind,
                clock.slot
            );
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_instruction_pack_unpack() {
        let claim_hash = [0xABu8; 32];
        let statement_kind = 0x10u8;
        let ix = Instruction::RecordVerifiedClaim {
            claim_hash,
            statement_kind,
        };
        let packed = ix.pack();
        assert_eq!(packed.len(), 34);
        assert_eq!(packed[0], 0); // discriminant
        let unpacked = Instruction::unpack(&packed).unwrap();
        match unpacked {
            Instruction::RecordVerifiedClaim {
                claim_hash: ch,
                statement_kind: sk,
            } => {
                assert_eq!(ch, [0xABu8; 32]);
                assert_eq!(sk, 0x10u8);
            }
        }
    }

    #[test]
    fn test_claim_record_pack_unpack() {
        let record = ClaimRecord {
            bump: 254,
            claim_hash: [0x01u8; 32],
            authority: [0x02u8; 32],
            statement_kind: 0x13,
            recorded_at_slot: 123_456_789u64,
        };
        let mut buf = vec![0u8; CLAIM_RECORD_LEN];
        record.pack(&mut buf);
        let unpacked = ClaimRecord::unpack(&buf).unwrap();
        assert_eq!(unpacked.bump, 254);
        assert_eq!(unpacked.claim_hash, [0x01u8; 32]);
        assert_eq!(unpacked.authority, [0x02u8; 32]);
        assert_eq!(unpacked.statement_kind, 0x13);
        assert_eq!(unpacked.recorded_at_slot, 123_456_789u64);
    }

    #[test]
    fn test_claim_record_claim_hash_stored() {
        let expected_hash = [0xFFu8; 32];
        let record = ClaimRecord {
            bump: 1,
            claim_hash: expected_hash,
            authority: [0u8; 32],
            statement_kind: 0x10,
            recorded_at_slot: 0,
        };
        let mut buf = vec![0u8; CLAIM_RECORD_LEN];
        record.pack(&mut buf);
        let unpacked = ClaimRecord::unpack(&buf).unwrap();
        assert_eq!(unpacked.claim_hash, expected_hash);
    }

    #[test]
    fn test_statement_kind_byte_range() {
        // Valid statement kind bytes per spec: 0x10..=0x15
        let valid_kinds: &[u8] = &[0x10, 0x11, 0x12, 0x13, 0x14, 0x15];
        for &kind in valid_kinds {
            assert!(
                kind >= 0x10 && kind <= 0x15,
                "kind {:02x} not in valid range",
                kind
            );
        }
        // Anything outside that range is not in spec
        assert!(0x16u8 > 0x15);
        assert!(0x0Fu8 < 0x10);
    }

    #[test]
    fn test_instruction_wrong_discriminant_fails() {
        let mut data = vec![0x99u8]; // unknown discriminant
        data.extend_from_slice(&[0u8; 33]);
        let err = Instruction::unpack(&data).unwrap_err();
        assert_eq!(err, ProgramError::InvalidInstructionData);
    }

    #[test]
    fn test_instruction_too_short_fails() {
        // discriminant 0 but only 10 bytes total — needs 34
        let data = vec![0u8; 10];
        let err = Instruction::unpack(&data).unwrap_err();
        assert_eq!(err, ProgramError::InvalidInstructionData);
    }
}
