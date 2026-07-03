//! x402 refund-on-failure escrow — optimistic conditional settlement.
//!
//! Buyer escrows payment for one x402 call. The seller claims it by settling
//! with an ed25519-signed receipt that the settle tx carries through the native
//! ed25519 precompile; the program reads the signature back via the
//! instructions sysvar, so the seller's own key vouches for the outcome and no
//! oracle is trusted. Silence past the deadline auto-refunds the buyer;
//! equivocation (two conflicting signed receipts for one payment) is a
//! self-signed fraud proof that slashes the seller's bond. Response *quality*
//! (a valid-looking 200 with garbage) stays bonded, not adjudicated — the chain
//! bounds the cost, it doesn't judge truth.

pub mod ed25519;
pub mod error;
pub mod instruction;
pub mod processor;
pub mod receipt;
pub mod state;

#[cfg(not(feature = "no-entrypoint"))]
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

#[cfg(not(feature = "no-entrypoint"))]
fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    processor::process(program_id, accounts, instruction_data)
}

#[cfg(test)]
mod tests {
    use crate::error::EscrowError;
    use crate::instruction::EscrowInstruction;
    use crate::receipt::{
        receipts_conflict, SettleReceipt, RECEIPT_MSG_LEN, STATUS_FAIL, STATUS_SUCCESS,
    };
    use crate::state::{status, Escrow, ESCROW_ACCOUNT_LEN, ESCROW_STATE_VERSION};
    use solana_program::program_pack::Pack;

    fn sample_escrow() -> Escrow {
        Escrow {
            version: ESCROW_STATE_VERSION,
            bump: 254,
            status: status::SETTLED_SUCCESS,
            buyer: [1u8; 32],
            seller: [2u8; 32],
            amount: 1_000_000,
            bond: 500_000,
            payment_commitment: [3u8; 32],
            deadline: 1_777_000_000,
            dispute_deadline: 1_777_003_600,
            response_hash: [4u8; 32],
            created_at: 1_776_999_000,
            dispute_window: 3_600,
        }
    }

    #[test]
    fn escrow_len_is_179() {
        assert_eq!(ESCROW_ACCOUNT_LEN, 179);
        assert_eq!(Escrow::LEN, ESCROW_ACCOUNT_LEN);
    }

    #[test]
    fn escrow_pack_unpack_roundtrip() {
        let e = sample_escrow();
        let mut buf = [0u8; ESCROW_ACCOUNT_LEN];
        e.pack_into_slice(&mut buf);
        assert_eq!(Escrow::unpack_from_slice(&buf).unwrap(), e);
    }

    #[test]
    fn escrow_unpack_rejects_bad_version() {
        let mut buf = [0u8; ESCROW_ACCOUNT_LEN];
        buf[0] = 9;
        assert!(Escrow::unpack_from_slice(&buf).is_err());
    }

    fn receipt(pc: [u8; 32], status: u8, rh: [u8; 32]) -> SettleReceipt {
        SettleReceipt {
            payment_commitment: pc,
            status,
            response_hash: rh,
            deadline: 1_777_000_000,
        }
    }

    #[test]
    fn receipt_encode_decode_roundtrip() {
        let r = receipt([5u8; 32], STATUS_SUCCESS, [6u8; 32]);
        let m = r.encode();
        assert_eq!(m.len(), RECEIPT_MSG_LEN);
        assert_eq!(SettleReceipt::decode(&m).unwrap(), r);
    }

    #[test]
    fn receipt_decode_rejects_wrong_len_and_domain() {
        assert!(SettleReceipt::decode(&[0u8; 10]).is_err());
        let mut m = receipt([5u8; 32], STATUS_SUCCESS, [6u8; 32]).encode();
        m[0] ^= 0xff; // corrupt domain
        assert!(SettleReceipt::decode(&m).is_err());
    }

    #[test]
    fn receipt_decode_rejects_bad_status() {
        let mut m = receipt([5u8; 32], STATUS_SUCCESS, [6u8; 32]).encode();
        m[45] = 7; // not FAIL or SUCCESS
        assert!(SettleReceipt::decode(&m).is_err());
    }

    #[test]
    fn equivocation_truth_table() {
        let pc = [9u8; 32];
        let a = receipt(pc, STATUS_SUCCESS, [1u8; 32]);
        // same success, different response -> conflict
        assert!(receipts_conflict(&a, &receipt(pc, STATUS_SUCCESS, [2u8; 32])));
        // success vs fail -> conflict
        assert!(receipts_conflict(&a, &receipt(pc, STATUS_FAIL, [0u8; 32])));
        // identical -> NOT a conflict (blocks replay-one-receipt-twice griefing)
        assert!(!receipts_conflict(&a, &a));
        // different payment -> NOT a conflict
        assert!(!receipts_conflict(
            &a,
            &receipt([8u8; 32], STATUS_FAIL, [0u8; 32])
        ));
        // two fails over same payment -> consistent, NOT a conflict
        let f = receipt(pc, STATUS_FAIL, [0u8; 32]);
        assert!(!receipts_conflict(&f, &receipt(pc, STATUS_FAIL, [5u8; 32])));
    }

    #[test]
    fn instruction_pack_unpack_roundtrip() {
        let cases = [
            EscrowInstruction::OpenEscrow {
                seller: [7u8; 32],
                amount: 42,
                payment_commitment: [8u8; 32],
                deadline: 123,
                dispute_window: 456,
            },
            EscrowInstruction::PostBond { amount: 99 },
            EscrowInstruction::SettleSuccess { receipt_ix_index: 0 },
            EscrowInstruction::RefundOnTimeout,
            EscrowInstruction::ProveEquivocation {
                ix_index_a: 0,
                ix_index_b: 1,
            },
            EscrowInstruction::CloseAfterDispute,
        ];
        for c in cases {
            let packed = c.pack();
            assert_eq!(EscrowInstruction::unpack(&packed).unwrap(), c);
        }
    }

    #[test]
    fn instruction_unpack_rejects_junk() {
        assert!(EscrowInstruction::unpack(&[]).is_err());
        assert!(EscrowInstruction::unpack(&[99]).is_err());
        assert!(EscrowInstruction::unpack(&[1, 0, 0]).is_err()); // PostBond wrong len
    }

    /// Build a faithful ed25519-precompile data blob (same layout as
    /// solana_sdk::ed25519_instruction::new_ed25519_instruction) and confirm the
    /// parser recovers exactly the pubkey + message the precompile would verify.
    fn build_ed25519_blob(pubkey: &[u8; 32], message: &[u8], self_contained: bool) -> Vec<u8> {
        let pk_off: u16 = 16; // 2 header + 14 offsets
        let sig_off: u16 = pk_off + 32; // 48
        let msg_off: u16 = sig_off + 64; // 112
        let ii: u16 = if self_contained { u16::MAX } else { 0 };
        let mut d = vec![1u8, 0u8];
        d.extend_from_slice(&sig_off.to_le_bytes());
        d.extend_from_slice(&ii.to_le_bytes());
        d.extend_from_slice(&pk_off.to_le_bytes());
        d.extend_from_slice(&ii.to_le_bytes());
        d.extend_from_slice(&msg_off.to_le_bytes());
        d.extend_from_slice(&(message.len() as u16).to_le_bytes());
        d.extend_from_slice(&ii.to_le_bytes());
        d.extend_from_slice(pubkey);
        d.extend_from_slice(&[0u8; 64]); // signature (parser ignores)
        d.extend_from_slice(message);
        d
    }

    #[test]
    fn ed25519_parser_recovers_pubkey_and_message() {
        let pk = [7u8; 32];
        let msg = receipt([3u8; 32], STATUS_SUCCESS, [4u8; 32]).encode();
        let blob = build_ed25519_blob(&pk, &msg, true);
        let (got_pk, got_msg) = crate::ed25519::extract_pubkey_and_message(&blob, 0).unwrap();
        assert_eq!(got_pk, pk);
        assert_eq!(got_msg, msg.to_vec());
    }

    #[test]
    fn ed25519_parser_rejects_cross_instruction_reference() {
        // instruction_index != u16::MAX means the verified bytes live in a
        // different instruction — we must refuse to read them as "verified".
        let blob = build_ed25519_blob(&[7u8; 32], &[0u8; RECEIPT_MSG_LEN], false);
        assert_eq!(
            crate::ed25519::extract_pubkey_and_message(&blob, 0).unwrap_err(),
            EscrowError::InvalidReceiptSignature
        );
    }

    #[test]
    fn error_codes_stable() {
        assert_eq!(EscrowError::InvalidInstruction as u32, 0);
        assert_eq!(EscrowError::InvalidReceiptSignature as u32, 13);
        assert_eq!(EscrowError::ReceiptMismatch as u32, 14);
        assert_eq!(EscrowError::NotEquivocation as u32, 15);
    }
}
