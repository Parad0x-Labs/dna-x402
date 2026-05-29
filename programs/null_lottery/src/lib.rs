//! dark-null-lottery — Provably-fair NULL lottery with commit-reveal randomness
//!
//! Commit-reveal randomness via Poseidon-compatible hashing.
//! Off-chain tickets (Liquefy bridge pattern), 1 tx per 5-min round.
//! House fee: 0.5% (50 bps).
//!
//! IS_MAINNET_READY = false:
//!   - secp / SPL token transfers are skipped.
//!   - Winner verification is off-chain only; on-chain just marks state.

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
        error::LotteryError,
        instruction::LotteryInstruction,
        processor::{draw_numbers, fallback_winner_nullifier},
        state::{
            CLAIM_NULLIFIER_DISC, CLAIM_NULLIFIER_SIZE,
            LOTTERY_CONFIG_DISC, LOTTERY_CONFIG_SIZE,
            ROUND_STATE_DISC, ROUND_STATE_SIZE,
            ClaimNullifier, LotteryConfig, RoundState, RoundStatus,
        },
    };
    use solana_program::{hash::hashv, program_error::ProgramError};

    // ── 1. LotteryConfig pack/unpack round-trip ───────────────────────────

    #[test]
    fn test_lottery_config_pack_unpack() {
        let admin = [0xABu8; 32];
        let cfg = LotteryConfig {
            disc:              LOTTERY_CONFIG_DISC,
            admin,
            ticket_price_null: 1_000_000,
            house_fee_bps:     50,
            numbers_count:     5,
            numbers_range:     30,
            fallback_after:    3,
            current_round_id:  42,
            is_active:         true,
        };

        let mut buf = vec![0u8; LOTTERY_CONFIG_SIZE];
        cfg.pack_into(&mut buf);

        let unpacked = LotteryConfig::unpack_from(&buf)
            .expect("unpack failed");
        assert_eq!(unpacked.disc,              LOTTERY_CONFIG_DISC);
        assert_eq!(unpacked.admin,             admin);
        assert_eq!(unpacked.ticket_price_null, 1_000_000);
        assert_eq!(unpacked.house_fee_bps,     50);
        assert_eq!(unpacked.numbers_count,     5);
        assert_eq!(unpacked.numbers_range,     30);
        assert_eq!(unpacked.fallback_after,    3);
        assert_eq!(unpacked.current_round_id,  42);
        assert!(unpacked.is_active);
    }

    // ── 2. RoundState pack/unpack round-trip ─────────────────────────────

    #[test]
    fn test_round_state_pack_unpack() {
        let commitment = [0x11u8; 32];
        let nullifier  = [0x22u8; 32];
        let round = RoundState {
            disc:                 ROUND_STATE_DISC,
            round_id:             7,
            tickets_root:         [0x33u8; 32],
            ticket_count:         500,
            total_null_deposited: 50_000_000,
            seed_commitment:      commitment,
            seed_revealed:        [0u8; 32],
            drawn_numbers:        [3, 7, 15, 22, 28],
            status:               RoundStatus::Drawn,
            winner_nullifier:     nullifier,
            no_winner_count:      2,
        };

        let mut buf = vec![0u8; ROUND_STATE_SIZE];
        round.pack_into(&mut buf);

        let unpacked = RoundState::unpack_from(&buf)
            .expect("unpack failed");
        assert_eq!(unpacked.disc,                 ROUND_STATE_DISC);
        assert_eq!(unpacked.round_id,             7);
        assert_eq!(unpacked.ticket_count,         500);
        assert_eq!(unpacked.total_null_deposited, 50_000_000);
        assert_eq!(unpacked.seed_commitment,      commitment);
        assert_eq!(unpacked.drawn_numbers,        [3, 7, 15, 22, 28]);
        assert_eq!(unpacked.status,               RoundStatus::Drawn);
        assert_eq!(unpacked.winner_nullifier,     nullifier);
        assert_eq!(unpacked.no_winner_count,      2);
    }

    // ── 3. ClaimNullifier pack/unpack round-trip ─────────────────────────

    #[test]
    fn test_claim_nullifier_pack_unpack() {
        let claim = ClaimNullifier {
            disc:       CLAIM_NULLIFIER_DISC,
            used:       true,
            round_id:   99,
            claimed_at: 12345678,
        };

        let mut buf = vec![0u8; CLAIM_NULLIFIER_SIZE];
        claim.pack_into(&mut buf);

        let unpacked = ClaimNullifier::unpack_from(&buf)
            .expect("unpack failed");
        assert_eq!(unpacked.disc,       CLAIM_NULLIFIER_DISC);
        assert!(unpacked.used);
        assert_eq!(unpacked.round_id,   99);
        assert_eq!(unpacked.claimed_at, 12345678);
    }

    // ── 4. Instruction unpack 0x01 valid ─────────────────────────────────

    #[test]
    fn test_unpack_0x01_valid() {
        let mut data = vec![0x01u8];
        data.extend_from_slice(&1_000_000u64.to_le_bytes()); // ticket_price
        data.extend_from_slice(&50u16.to_le_bytes());        // house_fee_bps
        data.push(5);                                        // numbers_count
        data.push(30);                                       // numbers_range
        data.push(3);                                        // fallback_after

        match LotteryInstruction::unpack(&data).expect("unpack failed") {
            LotteryInstruction::InitLottery {
                ticket_price_null,
                house_fee_bps,
                numbers_count,
                numbers_range,
                fallback_after,
            } => {
                assert_eq!(ticket_price_null, 1_000_000);
                assert_eq!(house_fee_bps,     50);
                assert_eq!(numbers_count,     5);
                assert_eq!(numbers_range,     30);
                assert_eq!(fallback_after,    3);
            }
            _ => panic!("wrong variant"),
        }
    }

    // ── 5. Instruction unpack 0x01 too short → error ─────────────────────

    #[test]
    fn test_unpack_0x01_too_short() {
        let data = vec![0x01u8, 0x00, 0x01]; // only 2 payload bytes, need 13
        // The error code is 0x6001 = 24577
        let err = LotteryInstruction::unpack(&data).unwrap_err();
        match err {
            ProgramError::Custom(c) => assert_eq!(c, 0x6001),
            _ => panic!("wrong error type"),
        }
    }

    // ── 6. Instruction unpack 0x02 valid (commitment round-trip) ─────────

    #[test]
    fn test_unpack_0x02_valid() {
        let commitment = [0xDEu8; 32];
        let mut data = vec![0x02u8];
        data.extend_from_slice(&commitment);

        match LotteryInstruction::unpack(&data).expect("unpack failed") {
            LotteryInstruction::CommitRound { seed_commitment } => {
                assert_eq!(seed_commitment, commitment);
            }
            _ => panic!("wrong variant"),
        }
    }

    // ── 7. Instruction unpack 0x03 valid ─────────────────────────────────

    #[test]
    fn test_unpack_0x03_valid() {
        let root = [0xAAu8; 32];
        let mut data = vec![0x03u8];
        data.extend_from_slice(&root);
        data.extend_from_slice(&200u64.to_le_bytes()); // ticket_count
        data.extend_from_slice(&20_000u64.to_le_bytes()); // total_null

        match LotteryInstruction::unpack(&data).expect("unpack failed") {
            LotteryInstruction::AnchorTickets {
                tickets_root,
                ticket_count,
                total_null_deposited,
            } => {
                assert_eq!(tickets_root,         root);
                assert_eq!(ticket_count,         200);
                assert_eq!(total_null_deposited, 20_000);
            }
            _ => panic!("wrong variant"),
        }
    }

    // ── 8. Instruction unpack 0x04 valid ─────────────────────────────────

    #[test]
    fn test_unpack_0x04_valid() {
        let seed = [0xBBu8; 32];
        let mut data = vec![0x04u8];
        data.extend_from_slice(&seed);

        match LotteryInstruction::unpack(&data).expect("unpack failed") {
            LotteryInstruction::RevealDraw { seed: s } => {
                assert_eq!(s, seed);
            }
            _ => panic!("wrong variant"),
        }
    }

    // ── 9. Instruction unpack 0x05 valid ─────────────────────────────────

    #[test]
    fn test_unpack_0x05_valid() {
        let seed       = [0xCCu8; 32];
        let fb_root    = [0xDDu8; 32];
        let pool_size  = 1500u64;

        let mut data = vec![0x05u8];
        data.extend_from_slice(&seed);
        data.extend_from_slice(&fb_root);
        data.extend_from_slice(&pool_size.to_le_bytes());

        match LotteryInstruction::unpack(&data).expect("unpack failed") {
            LotteryInstruction::FallbackDraw {
                seed: s,
                fallback_tickets_root,
                fallback_pool_size,
            } => {
                assert_eq!(s,                     seed);
                assert_eq!(fallback_tickets_root, fb_root);
                assert_eq!(fallback_pool_size,    pool_size);
            }
            _ => panic!("wrong variant"),
        }
    }

    // ── 10. Instruction unpack 0x06 valid ────────────────────────────────

    #[test]
    fn test_unpack_0x06_valid() {
        let nullifier = [0xEEu8; 32];
        let mut data = vec![0x06u8];
        data.extend_from_slice(&nullifier);

        match LotteryInstruction::unpack(&data).expect("unpack failed") {
            LotteryInstruction::ClaimJackpot { winner_nullifier } => {
                assert_eq!(winner_nullifier, nullifier);
            }
            _ => panic!("wrong variant"),
        }
    }

    // ── 11. draw_numbers produces 5 distinct values in 1..=30 ────────────

    #[test]
    fn test_draw_numbers_distinct_in_range() {
        let seed    = [0x42u8; 32];
        let drawn   = draw_numbers(&seed, 0);

        assert_eq!(drawn.len(), 5);
        for &n in drawn.iter() {
            assert!(n >= 1 && n <= 30, "number {} out of range 1..=30", n);
        }
        // All distinct
        for i in 0..5 {
            for j in (i + 1)..5 {
                assert_ne!(drawn[i], drawn[j], "duplicate draw: {}", drawn[i]);
            }
        }
    }

    // Draw should be deterministic
    #[test]
    fn test_draw_numbers_deterministic() {
        let seed  = [0x99u8; 32];
        let d1    = draw_numbers(&seed, 5);
        let d2    = draw_numbers(&seed, 5);
        assert_eq!(d1, d2);

        // Different round_id → different draw
        let d3 = draw_numbers(&seed, 6);
        assert_ne!(d1, d3);
    }

    // ── 12. SHA-256 seed verify: SHA-256(b"test-seed") matches commitment ─

    #[test]
    fn test_sha256_seed_commitment() {
        let seed_bytes = b"test-seed-bytes-padded-to-32bytes";
        // Build exactly 32 bytes
        let mut seed = [0u8; 32];
        let copy_len = seed_bytes.len().min(32);
        seed[..copy_len].copy_from_slice(&seed_bytes[..copy_len]);

        // Compute commitment as the program does (solana_program::hash::hashv)
        let commitment = hashv(&[&seed]);
        let commitment_bytes = commitment.to_bytes();

        // Re-verify: same call should yield the same hash
        let verify = hashv(&[&seed]);
        assert_eq!(commitment_bytes, verify.to_bytes());

        // A different seed must NOT match
        let mut bad_seed = seed;
        bad_seed[0] ^= 0xFF;
        let bad_commitment = hashv(&[&bad_seed]);
        assert_ne!(commitment_bytes, bad_commitment.to_bytes());
    }

    // ── 13. fallback_winner_index: deterministic given seed + pool_size ───

    #[test]
    fn test_fallback_winner_deterministic() {
        let seed      = [0x77u8; 32];
        let pool_size = 500u64;

        let n1 = fallback_winner_nullifier(&seed, pool_size);
        let n2 = fallback_winner_nullifier(&seed, pool_size);
        assert_eq!(n1, n2, "must be deterministic");

        // Different pool_size → different result
        let n3 = fallback_winner_nullifier(&seed, pool_size + 1);
        assert_ne!(n1, n3);

        // Non-zero result
        assert_ne!(n1, [0u8; 32]);
    }

    // ── 14. Double-commitment protection: WrongStatus on re-commit ────────
    // (pure state-logic test: simulates what the processor checks)

    #[test]
    fn test_double_commit_wrong_status() {
        // A round that was already committed (any non-Open status)
        // When the processor finds an existing ROUND_STATE_DISC record,
        // it returns WrongStatus.  We verify the error code is correct.
        let err: ProgramError = LotteryError::WrongStatus.into();
        match err {
            ProgramError::Custom(c) => assert_eq!(c, 0x6007),
            _ => panic!("expected Custom error"),
        }

        // Also verify a packed RoundState with Committed status can be detected.
        let round = RoundState {
            disc:                 ROUND_STATE_DISC,
            round_id:             0,
            tickets_root:         [0u8; 32],
            ticket_count:         0,
            total_null_deposited: 0,
            seed_commitment:      [0u8; 32],
            seed_revealed:        [0u8; 32],
            drawn_numbers:        [0u8; 5],
            status:               RoundStatus::Committed,
            winner_nullifier:     [0u8; 32],
            no_winner_count:      0,
        };
        let mut buf = vec![0u8; ROUND_STATE_SIZE];
        round.pack_into(&mut buf);

        let parsed = RoundState::unpack_from(&buf).expect("unpack");
        // Processor would detect buf[0] == ROUND_STATE_DISC and reject with WrongStatus.
        assert_eq!(buf[0], ROUND_STATE_DISC);
        assert_eq!(parsed.status, RoundStatus::Committed);
        // Attempting commit again while status != non-existent → WrongStatus
        assert_ne!(parsed.status, RoundStatus::Open);
    }
}
