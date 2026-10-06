use crate::error::LotteryError;
use solana_program::program_error::ProgramError;

/// Parsed instructions for the dark-null-lottery program.
#[derive(Debug)]
pub enum LotteryInstruction {
    /// 0x01 InitLottery
    /// Data: [0x01, ticket_price[8], house_fee_bps[2], numbers_count[1],
    ///        numbers_range[1], fallback_after[1]] = 14 bytes total
    InitLottery {
        ticket_price_null: u64,
        house_fee_bps:     u16,
        numbers_count:     u8,
        numbers_range:     u8,
        fallback_after:    u8,
    },

    /// 0x02 CommitRound
    /// Data: [0x02, seed_commitment[32]] = 33 bytes total
    CommitRound {
        seed_commitment: [u8; 32],
    },

    /// 0x03 AnchorTickets
    /// Data: [0x03, tickets_root[32], ticket_count[8], total_null_deposited[8]]
    ///       = 49 bytes total
    /// Accounts: [round_state (w), admin (signer), lottery_config PDA]
    AnchorTickets {
        tickets_root:         [u8; 32],
        ticket_count:         u64,
        total_null_deposited: u64,
    },

    /// 0x04 RevealDraw
    /// Data: [0x04, seed[32]] = 33 bytes total
    /// Accounts: [round_state (w), admin (signer), lottery_config PDA]
    RevealDraw {
        seed: [u8; 32],
    },

    /// 0x05 FallbackDraw
    /// Data: [0x05, seed[32], fallback_tickets_root[32], fallback_pool_size[8]]
    ///       = 73 bytes total
    FallbackDraw {
        seed:                  [u8; 32],
        fallback_tickets_root: [u8; 32],
        fallback_pool_size:    u64,
    },

    /// 0x06 ClaimJackpot
    /// Data, Drawn round (ticket proof required):
    ///   [0x06, nullifier[32], numbers[5], leaf_index[8] (u64 LE), proof_len[1],
    ///    proof[32 * proof_len]]
    /// Data, Won round (FallbackDraw winner): [0x06, nullifier[32]] = 33 bytes;
    ///   a ticket section, if present, is ignored.
    /// `numbers` ascending; `proof` = sibling hashes from the leaf up (see ticket.rs).
    ClaimJackpot {
        winner_nullifier: [u8; 32],
        ticket:           Option<TicketClaim>,
    },
}

/// The ticket a ClaimJackpot presents on a Drawn round.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketClaim {
    pub numbers:    [u8; 5],
    pub leaf_index: u64,
    pub proof:      Vec<[u8; 32]>,
}

impl LotteryInstruction {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        let (&tag, rest) = data.split_first()
            .ok_or::<ProgramError>(LotteryError::InvalidInstruction.into())?;

        match tag {
            // ── 0x01 InitLottery ─────────────────────────────────────────
            0x01 => {
                // 8 + 2 + 1 + 1 + 1 = 13 bytes after discriminant
                if rest.len() < 13 {
                    return Err(LotteryError::InvalidInstruction.into());
                }
                let mut price_bytes = [0u8; 8];
                let mut fee_bytes   = [0u8; 2];
                price_bytes.copy_from_slice(&rest[0..8]);
                fee_bytes.copy_from_slice(&rest[8..10]);
                Ok(Self::InitLottery {
                    ticket_price_null: u64::from_le_bytes(price_bytes),
                    house_fee_bps:     u16::from_le_bytes(fee_bytes),
                    numbers_count:     rest[10],
                    numbers_range:     rest[11],
                    fallback_after:    rest[12],
                })
            }

            // ── 0x02 CommitRound ─────────────────────────────────────────
            0x02 => {
                if rest.len() < 32 {
                    return Err(LotteryError::InvalidInstruction.into());
                }
                let mut seed_commitment = [0u8; 32];
                seed_commitment.copy_from_slice(&rest[0..32]);
                Ok(Self::CommitRound { seed_commitment })
            }

            // ── 0x03 AnchorTickets ───────────────────────────────────────
            0x03 => {
                // 32 + 8 + 8 = 48 bytes after discriminant
                if rest.len() < 48 {
                    return Err(LotteryError::InvalidInstruction.into());
                }
                let mut tickets_root      = [0u8; 32];
                let mut count_bytes       = [0u8; 8];
                let mut total_null_bytes  = [0u8; 8];
                tickets_root.copy_from_slice(&rest[0..32]);
                count_bytes.copy_from_slice(&rest[32..40]);
                total_null_bytes.copy_from_slice(&rest[40..48]);
                Ok(Self::AnchorTickets {
                    tickets_root,
                    ticket_count:         u64::from_le_bytes(count_bytes),
                    total_null_deposited: u64::from_le_bytes(total_null_bytes),
                })
            }

            // ── 0x04 RevealDraw ──────────────────────────────────────────
            0x04 => {
                if rest.len() < 32 {
                    return Err(LotteryError::InvalidInstruction.into());
                }
                let mut seed = [0u8; 32];
                seed.copy_from_slice(&rest[0..32]);
                Ok(Self::RevealDraw { seed })
            }

            // ── 0x05 FallbackDraw ────────────────────────────────────────
            0x05 => {
                // 32 + 32 + 8 = 72 bytes after discriminant
                if rest.len() < 72 {
                    return Err(LotteryError::InvalidInstruction.into());
                }
                let mut seed                  = [0u8; 32];
                let mut fallback_tickets_root = [0u8; 32];
                let mut pool_size_bytes       = [0u8; 8];
                seed.copy_from_slice(&rest[0..32]);
                fallback_tickets_root.copy_from_slice(&rest[32..64]);
                pool_size_bytes.copy_from_slice(&rest[64..72]);
                Ok(Self::FallbackDraw {
                    seed,
                    fallback_tickets_root,
                    fallback_pool_size: u64::from_le_bytes(pool_size_bytes),
                })
            }

            // ── 0x06 ClaimJackpot ────────────────────────────────────────
            0x06 => {
                if rest.len() < 32 {
                    return Err(LotteryError::InvalidInstruction.into());
                }
                let mut winner_nullifier = [0u8; 32];
                winner_nullifier.copy_from_slice(&rest[0..32]);
                let tail = &rest[32..];
                if tail.is_empty() {
                    return Ok(Self::ClaimJackpot { winner_nullifier, ticket: None });
                }
                // numbers[5] + leaf_index[8] + proof_len[1] + proof[32 * proof_len]
                if tail.len() < 14 {
                    return Err(LotteryError::InvalidInstruction.into());
                }
                let mut numbers = [0u8; 5];
                numbers.copy_from_slice(&tail[0..5]);
                let mut idx_bytes = [0u8; 8];
                idx_bytes.copy_from_slice(&tail[5..13]);
                let proof_len = tail[13] as usize;
                if proof_len > crate::ticket::MAX_PROOF_DEPTH || tail.len() != 14 + 32 * proof_len {
                    return Err(LotteryError::InvalidInstruction.into());
                }
                let proof = tail[14..]
                    .chunks_exact(32)
                    .map(|c| {
                        let mut h = [0u8; 32];
                        h.copy_from_slice(c);
                        h
                    })
                    .collect();
                Ok(Self::ClaimJackpot {
                    winner_nullifier,
                    ticket: Some(TicketClaim {
                        numbers,
                        leaf_index: u64::from_le_bytes(idx_bytes),
                        proof,
                    }),
                })
            }

            _ => Err(LotteryError::InvalidInstruction.into()),
        }
    }
}
