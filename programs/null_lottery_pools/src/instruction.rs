//! Instruction encoding (1-byte tag, little-endian fields) and builders.
//!
//! | Tag | Instruction | Data after the tag | Accounts |
//! |---|---|---|---|
//! | 0 | CreatePool | nonce u64, seed u64, ticket_price u64, fee_max_bps u16, fee_min_bps u16, reserve_bps u16, cap_bps u16, pick_k u8, range_n u8, round_slots u64, claim_window_slots u64, [tier2_bps u16] | creator (s,w), pool (w), system program |
//! | 1 | BuyTicket | round_id u64, owner [32], numbers [8] | payer (s,w), pool (w), system program |
//! | 2 | Draw | - | cranker (s,w), pool (w), round (w), SlotHashes sysvar, system program |
//! | 3 | Claim | ticket_index u64, numbers [8], proof 20 x [32] | claimant (s,w), pool, round (w), claim (w), system program |
//! | 4 | Settle | - | pool (w), round (w) |
//! | 5 | Payout | - | pool (w), round (w), claim (w), owner (w) |
//! | 6 | WithdrawCreatorFees | amount u64 | creator (s,w), pool (w) |
//! | 7 | Retire | - | creator (s), pool (w) |
//! | 8 | CloseRound | - | pool, round (w), rent payer (w) |

use crate::{
    econ::PoolParams,
    state::{CLAIM_SEED, POOL_SEED, ROUND_SEED},
    tree::TREE_DEPTH,
};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
    sysvar::slot_hashes,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PoolInstruction {
    CreatePool { nonce: u64, params: PoolParams },
    BuyTicket { round_id: u64, owner: [u8; 32], numbers: [u8; 8] },
    Draw,
    Claim { ticket_index: u64, numbers: [u8; 8], proof: Box<[[u8; 32]; TREE_DEPTH]> },
    Settle,
    Payout,
    WithdrawCreatorFees { amount: u64 },
    Retire,
    CloseRound,
}

/// CreatePool without the tier-2 field (tier 2 off).
pub const CREATE_POOL_LEN: usize = 1 + 8 * 3 + 2 * 4 + 2 + 8 * 2;
/// CreatePool with a trailing `tier2_bps` u16.
pub const CREATE_POOL_TIER2_LEN: usize = CREATE_POOL_LEN + 2;
pub const BUY_TICKET_LEN: usize = 1 + 8 + 32 + 8;
pub const CLAIM_DATA_LEN: usize = 1 + 8 + 8 + 32 * TREE_DEPTH;

fn u64_at(d: &[u8], o: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[o..o + 8]);
    u64::from_le_bytes(b)
}
fn u16_at(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([d[o], d[o + 1]])
}
fn arr_at<const N: usize>(d: &[u8], o: usize) -> [u8; N] {
    let mut a = [0u8; N];
    a.copy_from_slice(&d[o..o + N]);
    a
}

impl PoolInstruction {
    /// Parse instruction data; `None` for an unknown tag or a wrong length.
    pub fn unpack(d: &[u8]) -> Option<Self> {
        let (&tag, _) = d.split_first()?;
        let exact = |n: usize| d.len() == n;
        Some(match tag {
            0 if exact(CREATE_POOL_LEN) || exact(CREATE_POOL_TIER2_LEN) => PoolInstruction::CreatePool {
                nonce: u64_at(d, 1),
                params: PoolParams {
                    seed: u64_at(d, 9),
                    ticket_price: u64_at(d, 17),
                    fee_max_bps: u16_at(d, 25),
                    fee_min_bps: u16_at(d, 27),
                    reserve_bps: u16_at(d, 29),
                    cap_bps: u16_at(d, 31),
                    pick_k: d[33],
                    range_n: d[34],
                    round_slots: u64_at(d, 35),
                    claim_window_slots: u64_at(d, 43),
                    tier2_bps: if d.len() == CREATE_POOL_TIER2_LEN { u16_at(d, 51) } else { 0 },
                },
            },
            1 if exact(BUY_TICKET_LEN) => PoolInstruction::BuyTicket {
                round_id: u64_at(d, 1),
                owner: arr_at(d, 9),
                numbers: arr_at(d, 41),
            },
            2 if exact(1) => PoolInstruction::Draw,
            3 if exact(CLAIM_DATA_LEN) => {
                let mut proof = Box::new([[0u8; 32]; TREE_DEPTH]);
                for (i, p) in proof.iter_mut().enumerate() {
                    *p = arr_at(d, 17 + 32 * i);
                }
                PoolInstruction::Claim { ticket_index: u64_at(d, 1), numbers: arr_at(d, 9), proof }
            }
            4 if exact(1) => PoolInstruction::Settle,
            5 if exact(1) => PoolInstruction::Payout,
            6 if exact(9) => PoolInstruction::WithdrawCreatorFees { amount: u64_at(d, 1) },
            7 if exact(1) => PoolInstruction::Retire,
            8 if exact(1) => PoolInstruction::CloseRound,
            _ => return None,
        })
    }

    pub fn pack(&self) -> Vec<u8> {
        let mut v = Vec::new();
        match self {
            PoolInstruction::CreatePool { nonce, params: p } => {
                v.push(0);
                v.extend_from_slice(&nonce.to_le_bytes());
                v.extend_from_slice(&p.seed.to_le_bytes());
                v.extend_from_slice(&p.ticket_price.to_le_bytes());
                v.extend_from_slice(&p.fee_max_bps.to_le_bytes());
                v.extend_from_slice(&p.fee_min_bps.to_le_bytes());
                v.extend_from_slice(&p.reserve_bps.to_le_bytes());
                v.extend_from_slice(&p.cap_bps.to_le_bytes());
                v.push(p.pick_k);
                v.push(p.range_n);
                v.extend_from_slice(&p.round_slots.to_le_bytes());
                v.extend_from_slice(&p.claim_window_slots.to_le_bytes());
                // The v1 encoding (no field) means tier 2 off.
                if p.tier2_bps > 0 {
                    v.extend_from_slice(&p.tier2_bps.to_le_bytes());
                }
            }
            PoolInstruction::BuyTicket { round_id, owner, numbers } => {
                v.push(1);
                v.extend_from_slice(&round_id.to_le_bytes());
                v.extend_from_slice(owner);
                v.extend_from_slice(numbers);
            }
            PoolInstruction::Draw => v.push(2),
            PoolInstruction::Claim { ticket_index, numbers, proof } => {
                v.push(3);
                v.extend_from_slice(&ticket_index.to_le_bytes());
                v.extend_from_slice(numbers);
                for p in proof.iter() {
                    v.extend_from_slice(p);
                }
            }
            PoolInstruction::Settle => v.push(4),
            PoolInstruction::Payout => v.push(5),
            PoolInstruction::WithdrawCreatorFees { amount } => {
                v.push(6);
                v.extend_from_slice(&amount.to_le_bytes());
            }
            PoolInstruction::Retire => v.push(7),
            PoolInstruction::CloseRound => v.push(8),
        }
        v
    }
}

// ── PDA helpers ─────────────────────────────────────────────────────────────

pub fn pool_address(program_id: &Pubkey, creator: &Pubkey, nonce: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[POOL_SEED, creator.as_ref(), &nonce.to_le_bytes()], program_id)
}

pub fn round_address(program_id: &Pubkey, pool: &Pubkey, round_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ROUND_SEED, pool.as_ref(), &round_id.to_le_bytes()], program_id)
}

pub fn claim_address(
    program_id: &Pubkey,
    pool: &Pubkey,
    round_id: u64,
    ticket_index: u64,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[CLAIM_SEED, pool.as_ref(), &round_id.to_le_bytes(), &ticket_index.to_le_bytes()],
        program_id,
    )
}

// ── Instruction builders ────────────────────────────────────────────────────

pub fn create_pool(program_id: &Pubkey, creator: &Pubkey, nonce: u64, params: PoolParams) -> Instruction {
    let (pool, _) = pool_address(program_id, creator, nonce);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*creator, true),
            AccountMeta::new(pool, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: PoolInstruction::CreatePool { nonce, params }.pack(),
    }
}

pub fn buy_ticket(
    program_id: &Pubkey,
    payer: &Pubkey,
    pool: &Pubkey,
    round_id: u64,
    owner: &Pubkey,
    numbers: [u8; 8],
) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(*pool, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: PoolInstruction::BuyTicket { round_id, owner: owner.to_bytes(), numbers }.pack(),
    }
}

pub fn draw(program_id: &Pubkey, cranker: &Pubkey, pool: &Pubkey, round_id: u64) -> Instruction {
    draw_with_sysvar(program_id, cranker, pool, round_id, &slot_hashes::id())
}

/// Draw with an explicit SlotHashes account (tests pass a wrong one).
pub fn draw_with_sysvar(
    program_id: &Pubkey,
    cranker: &Pubkey,
    pool: &Pubkey,
    round_id: u64,
    slot_hashes_account: &Pubkey,
) -> Instruction {
    let (round, _) = round_address(program_id, pool, round_id);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*cranker, true),
            AccountMeta::new(*pool, false),
            AccountMeta::new(round, false),
            AccountMeta::new_readonly(*slot_hashes_account, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: PoolInstruction::Draw.pack(),
    }
}

pub fn claim(
    program_id: &Pubkey,
    claimant: &Pubkey,
    pool: &Pubkey,
    round_id: u64,
    ticket_index: u64,
    numbers: [u8; 8],
    proof: [[u8; 32]; TREE_DEPTH],
) -> Instruction {
    let (round, _) = round_address(program_id, pool, round_id);
    let (claim, _) = claim_address(program_id, pool, round_id, ticket_index);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*claimant, true),
            AccountMeta::new_readonly(*pool, false),
            AccountMeta::new(round, false),
            AccountMeta::new(claim, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: PoolInstruction::Claim { ticket_index, numbers, proof: Box::new(proof) }.pack(),
    }
}

pub fn settle(program_id: &Pubkey, pool: &Pubkey, round_id: u64) -> Instruction {
    let (round, _) = round_address(program_id, pool, round_id);
    Instruction {
        program_id: *program_id,
        accounts: vec![AccountMeta::new(*pool, false), AccountMeta::new(round, false)],
        data: PoolInstruction::Settle.pack(),
    }
}

pub fn payout(
    program_id: &Pubkey,
    pool: &Pubkey,
    round_id: u64,
    ticket_index: u64,
    owner: &Pubkey,
) -> Instruction {
    let (round, _) = round_address(program_id, pool, round_id);
    let (claim, _) = claim_address(program_id, pool, round_id, ticket_index);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*pool, false),
            AccountMeta::new(round, false),
            AccountMeta::new(claim, false),
            AccountMeta::new(*owner, false),
        ],
        data: PoolInstruction::Payout.pack(),
    }
}

pub fn withdraw_creator_fees(program_id: &Pubkey, creator: &Pubkey, pool: &Pubkey, amount: u64) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![AccountMeta::new(*creator, true), AccountMeta::new(*pool, false)],
        data: PoolInstruction::WithdrawCreatorFees { amount }.pack(),
    }
}

pub fn retire(program_id: &Pubkey, creator: &Pubkey, pool: &Pubkey) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![AccountMeta::new_readonly(*creator, true), AccountMeta::new(*pool, false)],
        data: PoolInstruction::Retire.pack(),
    }
}

pub fn close_round(program_id: &Pubkey, pool: &Pubkey, round_id: u64, rent_payer: &Pubkey) -> Instruction {
    let (round, _) = round_address(program_id, pool, round_id);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(*pool, false),
            AccountMeta::new(round, false),
            AccountMeta::new(*rent_payer, false),
        ],
        data: PoolInstruction::CloseRound.pack(),
    }
}
