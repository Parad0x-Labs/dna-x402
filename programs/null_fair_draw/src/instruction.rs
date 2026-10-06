//! Instruction encoding (1-byte tag, little-endian fields), PDA helpers and
//! builders. The builders are also the CPI interface: a calling program
//! builds the same instructions and signs as organizer or funder with its PDA
//! (`invoke_signed`), see the README.
//!
//! | Tag | Instruction | Data after the tag | Accounts |
//! |---|---|---|---|
//! | 0 | CreateDraw | draw_id u64, mode u8, weighted u8, redraw_rounds u8, tier_count u8, tier_count x (count u32, amount u64), entry_price u64, wallet_cap u64, close_slot u64, claim_window_slots u64, prize_mint [32], entry_mint [32], fee_dest [32] | organizer (s,w), draw (w), system; SPL prize: vault (w), prize mint, token program |
//! | 1 | FundPrizes | - | funder (s,w), draw (w), system; SPL: funder token (w), vault (w), token program |
//! | 2 | Enter | count u32, owner [32] | payer (s,w), draw (w), system, entrant record (w), fee destination (w); SPL entry: payer token (w), token program |
//! | 3 | CommitList | root [32], total_weight u64, leaf_count u64, depth u8 | organizer (s), draw (w) |
//! | 4 | Draw | - | draw (w), SlotHashes sysvar |
//! | 5 | Resolve | max u8, n u8, n x proof | draw (w) |
//! | 6 | Claim | slot u16, has_proof u8, [proof] | winner (s,w), draw (w); SPL: winner token (w), vault (w), token program |
//! | 7 | Advance | - | draw (w) |
//! | 8 | Reclaim | - | organizer (s,w), draw (w); SPL: organizer token (w), vault (w), token program |
//! | 9 | Close | - | organizer (s,w), draw (w); SPL: organizer token (w), vault (w), token program |
//! | 10 | Cancel | - | organizer (s,w), draw (w); SPL: organizer token (w), vault (w), token program |
//! | 11 | ProveEntry | proof | draw |
//! | 12 | CloseEntrant | - | owner (s,w), draw, entrant record (w) |
//! | 13 | Extend | - | payer (s,w), draw (w), system |
//!
//! A draw account larger than 10 KiB (one CPI allocation) is created at 10 KiB
//! and grown by up to 10 KiB per Extend while it is unfunded; FundPrizes needs
//! the full size. [`create_draw_with_extends`] returns CreateDraw followed by
//! the Extend instructions it needs (they fit in the same transaction).
//!
//! A proof is `leaf_index u64, wallet [32], weight u64, depth u8, depth x (hash [32], weight u64)`.

use crate::{
    state::{Tier, DRAW_SEED, ENTRANT_SEED, MAX_TIERS, VAULT_SEED},
    sumtree::{MAX_LIST_DEPTH, PAIR_LEN},
    token::TOKEN_PROGRAM_ID,
};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
    sysvar::slot_hashes,
};

/// CreateDraw parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateParams {
    /// [`crate::state::MODE_OPEN`] or [`crate::state::MODE_LIST`].
    pub mode: u8,
    /// Weighted draw (leaf weight = chance) or unweighted (every leaf weight 1).
    pub weighted: bool,
    /// Re-draw rounds for unclaimed prizes (0 = return them right away).
    pub redraw_rounds: u8,
    /// Prize tiers, top prize to smallest: tier 0 goes to the winner of slot 0.
    pub tiers: Vec<Tier>,
    /// Open raffle: price of one entry (0 = free), in lamports or entry-mint units.
    pub entry_price: u64,
    /// Open raffle: largest entry count per owner (0 = no cap).
    pub wallet_cap: u64,
    /// Open raffle: entries close at this slot; the draw target is 32 slots later.
    pub close_slot: u64,
    pub claim_window_slots: u64,
    /// Zero for SOL prizes.
    pub prize_mint: [u8; 32],
    /// Zero for SOL entry fees.
    pub entry_mint: [u8; 32],
    /// Receiver of entry fees: a wallet (SOL) or a token account (SPL).
    pub fee_dest: [u8; 32],
}

/// Membership proof of one leaf.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeafProof {
    pub leaf_index: u64,
    pub wallet: [u8; 32],
    pub weight: u64,
    /// `depth * 40` bytes of sibling `(hash, weight)` pairs from the leaf up.
    pub path: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DrawInstruction {
    CreateDraw { draw_id: u64, params: CreateParams },
    FundPrizes,
    Enter { count: u32, owner: [u8; 32] },
    CommitList { root: [u8; 32], total_weight: u64, leaf_count: u64, depth: u8 },
    Draw,
    Resolve { max: u8, proofs: Vec<LeafProof> },
    Claim { slot: u16, proof: Option<LeafProof> },
    Advance,
    Reclaim,
    Close,
    Cancel,
    ProveEntry { proof: LeafProof },
    CloseEntrant,
    Extend,
}

struct Cur<'a> {
    d: &'a [u8],
    o: usize,
}
impl<'a> Cur<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.d.get(self.o..self.o.checked_add(n)?)?;
        self.o += n;
        Some(s)
    }
    fn arr<const N: usize>(&mut self) -> Option<[u8; N]> {
        let mut a = [0u8; N];
        a.copy_from_slice(self.take(N)?);
        Some(a)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn u16(&mut self) -> Option<u16> {
        Some(u16::from_le_bytes(self.arr()?))
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.arr()?))
    }
    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.arr()?))
    }
    fn proof(&mut self) -> Option<LeafProof> {
        let leaf_index = self.u64()?;
        let wallet = self.arr()?;
        let weight = self.u64()?;
        let depth = self.u8()? as usize;
        if depth > MAX_LIST_DEPTH {
            return None;
        }
        let path = self.take(depth * PAIR_LEN)?.to_vec();
        Some(LeafProof { leaf_index, wallet, weight, path })
    }
    fn done(&self) -> bool {
        self.o == self.d.len()
    }
}

fn put_proof(v: &mut Vec<u8>, p: &LeafProof) {
    v.extend_from_slice(&p.leaf_index.to_le_bytes());
    v.extend_from_slice(&p.wallet);
    v.extend_from_slice(&p.weight.to_le_bytes());
    v.push((p.path.len() / PAIR_LEN) as u8);
    v.extend_from_slice(&p.path);
}

impl DrawInstruction {
    /// Parse instruction data; `None` for an unknown tag or malformed data.
    pub fn unpack(d: &[u8]) -> Option<Self> {
        let mut c = Cur { d, o: 1 };
        let ix = match *d.get(0)? {
            0 => {
                let draw_id = c.u64()?;
                let mode = c.u8()?;
                let weighted = match c.u8()? {
                    0 => false,
                    1 => true,
                    _ => return None,
                };
                let redraw_rounds = c.u8()?;
                let tier_count = c.u8()? as usize;
                if tier_count == 0 || tier_count > MAX_TIERS {
                    return None;
                }
                let mut tiers = Vec::with_capacity(tier_count);
                for _ in 0..tier_count {
                    tiers.push(Tier { count: c.u32()?, amount: c.u64()? });
                }
                DrawInstruction::CreateDraw {
                    draw_id,
                    params: CreateParams {
                        mode,
                        weighted,
                        redraw_rounds,
                        tiers,
                        entry_price: c.u64()?,
                        wallet_cap: c.u64()?,
                        close_slot: c.u64()?,
                        claim_window_slots: c.u64()?,
                        prize_mint: c.arr()?,
                        entry_mint: c.arr()?,
                        fee_dest: c.arr()?,
                    },
                }
            }
            1 => DrawInstruction::FundPrizes,
            2 => DrawInstruction::Enter { count: c.u32()?, owner: c.arr()? },
            3 => DrawInstruction::CommitList {
                root: c.arr()?,
                total_weight: c.u64()?,
                leaf_count: c.u64()?,
                depth: c.u8()?,
            },
            4 => DrawInstruction::Draw,
            5 => {
                let max = c.u8()?;
                let n = c.u8()?;
                let mut proofs = Vec::with_capacity(n as usize);
                for _ in 0..n {
                    proofs.push(c.proof()?);
                }
                DrawInstruction::Resolve { max, proofs }
            }
            6 => {
                let slot = c.u16()?;
                let proof = match c.u8()? {
                    0 => None,
                    1 => Some(c.proof()?),
                    _ => return None,
                };
                DrawInstruction::Claim { slot, proof }
            }
            7 => DrawInstruction::Advance,
            8 => DrawInstruction::Reclaim,
            9 => DrawInstruction::Close,
            10 => DrawInstruction::Cancel,
            11 => DrawInstruction::ProveEntry { proof: c.proof()? },
            12 => DrawInstruction::CloseEntrant,
            13 => DrawInstruction::Extend,
            _ => return None,
        };
        if !c.done() {
            return None;
        }
        Some(ix)
    }

    pub fn pack(&self) -> Vec<u8> {
        let mut v = Vec::new();
        match self {
            DrawInstruction::CreateDraw { draw_id, params: p } => {
                v.push(0);
                v.extend_from_slice(&draw_id.to_le_bytes());
                v.push(p.mode);
                v.push(p.weighted as u8);
                v.push(p.redraw_rounds);
                v.push(p.tiers.len() as u8);
                for t in &p.tiers {
                    v.extend_from_slice(&t.count.to_le_bytes());
                    v.extend_from_slice(&t.amount.to_le_bytes());
                }
                v.extend_from_slice(&p.entry_price.to_le_bytes());
                v.extend_from_slice(&p.wallet_cap.to_le_bytes());
                v.extend_from_slice(&p.close_slot.to_le_bytes());
                v.extend_from_slice(&p.claim_window_slots.to_le_bytes());
                v.extend_from_slice(&p.prize_mint);
                v.extend_from_slice(&p.entry_mint);
                v.extend_from_slice(&p.fee_dest);
            }
            DrawInstruction::FundPrizes => v.push(1),
            DrawInstruction::Enter { count, owner } => {
                v.push(2);
                v.extend_from_slice(&count.to_le_bytes());
                v.extend_from_slice(owner);
            }
            DrawInstruction::CommitList { root, total_weight, leaf_count, depth } => {
                v.push(3);
                v.extend_from_slice(root);
                v.extend_from_slice(&total_weight.to_le_bytes());
                v.extend_from_slice(&leaf_count.to_le_bytes());
                v.push(*depth);
            }
            DrawInstruction::Draw => v.push(4),
            DrawInstruction::Resolve { max, proofs } => {
                v.push(5);
                v.push(*max);
                v.push(proofs.len() as u8);
                for p in proofs {
                    put_proof(&mut v, p);
                }
            }
            DrawInstruction::Claim { slot, proof } => {
                v.push(6);
                v.extend_from_slice(&slot.to_le_bytes());
                match proof {
                    None => v.push(0),
                    Some(p) => {
                        v.push(1);
                        put_proof(&mut v, p);
                    }
                }
            }
            DrawInstruction::Advance => v.push(7),
            DrawInstruction::Reclaim => v.push(8),
            DrawInstruction::Close => v.push(9),
            DrawInstruction::Cancel => v.push(10),
            DrawInstruction::ProveEntry { proof } => {
                v.push(11);
                put_proof(&mut v, proof);
            }
            DrawInstruction::CloseEntrant => v.push(12),
            DrawInstruction::Extend => v.push(13),
        }
        v
    }
}

// ── PDA helpers ─────────────────────────────────────────────────────────────

pub fn draw_address(program_id: &Pubkey, organizer: &Pubkey, draw_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[DRAW_SEED, organizer.as_ref(), &draw_id.to_le_bytes()], program_id)
}

pub fn vault_address(program_id: &Pubkey, draw: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_SEED, draw.as_ref()], program_id)
}

pub fn entrant_address(program_id: &Pubkey, draw: &Pubkey, owner: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ENTRANT_SEED, draw.as_ref(), owner.as_ref()], program_id)
}

// ── builders (also the CPI interface) ───────────────────────────────────────

fn spl(params_mint: &[u8; 32]) -> bool {
    *params_mint != [0u8; 32]
}

pub fn create_draw(program_id: &Pubkey, organizer: &Pubkey, draw_id: u64, params: CreateParams) -> Instruction {
    let (draw, _) = draw_address(program_id, organizer, draw_id);
    let mut accounts = vec![
        AccountMeta::new(*organizer, true),
        AccountMeta::new(draw, false),
        AccountMeta::new_readonly(system_program::id(), false),
    ];
    if spl(&params.prize_mint) {
        let (vault, _) = vault_address(program_id, &draw);
        accounts.push(AccountMeta::new(vault, false));
        accounts.push(AccountMeta::new_readonly(Pubkey::new_from_array(params.prize_mint), false));
        accounts.push(AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false));
    }
    Instruction { program_id: *program_id, accounts, data: DrawInstruction::CreateDraw { draw_id, params }.pack() }
}

pub fn extend(program_id: &Pubkey, payer: &Pubkey, draw: &Pubkey) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(*draw, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: DrawInstruction::Extend.pack(),
    }
}

/// CreateDraw plus the Extend instructions a draw of this size needs.
pub fn create_draw_with_extends(
    program_id: &Pubkey,
    organizer: &Pubkey,
    draw_id: u64,
    params: CreateParams,
) -> Vec<Instruction> {
    let prizes: u64 = params.tiers.iter().map(|t| t.count as u64).sum();
    let capacity = (prizes * (1 + params.redraw_rounds as u64)) as usize;
    let full = crate::state::draw_len(params.mode, capacity);
    let (draw, _) = draw_address(program_id, organizer, draw_id);
    let mut v = vec![create_draw(program_id, organizer, draw_id, params)];
    let mut have = full.min(crate::state::MAX_ALLOC_STEP);
    while have < full {
        v.push(extend(program_id, organizer, &draw));
        have += crate::state::MAX_ALLOC_STEP;
    }
    v
}

/// `funder_token` is the funder's prize-mint token account (SPL prizes only).
pub fn fund_prizes(program_id: &Pubkey, funder: &Pubkey, draw: &Pubkey, funder_token: Option<&Pubkey>) -> Instruction {
    let mut accounts = vec![
        AccountMeta::new(*funder, true),
        AccountMeta::new(*draw, false),
        AccountMeta::new_readonly(system_program::id(), false),
    ];
    if let Some(t) = funder_token {
        accounts.push(AccountMeta::new(*t, false));
        accounts.push(AccountMeta::new(vault_address(program_id, draw).0, false));
        accounts.push(AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false));
    }
    Instruction { program_id: *program_id, accounts, data: DrawInstruction::FundPrizes.pack() }
}

/// `payer_token` is the payer's entry-mint token account (SPL entry fee only).
pub fn enter(
    program_id: &Pubkey,
    payer: &Pubkey,
    draw: &Pubkey,
    owner: &Pubkey,
    count: u32,
    fee_dest: &Pubkey,
    payer_token: Option<&Pubkey>,
) -> Instruction {
    let mut accounts = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new(*draw, false),
        AccountMeta::new_readonly(system_program::id(), false),
        AccountMeta::new(entrant_address(program_id, draw, owner).0, false),
        AccountMeta::new(*fee_dest, false),
    ];
    if let Some(t) = payer_token {
        accounts.push(AccountMeta::new(*t, false));
        accounts.push(AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false));
    }
    Instruction {
        program_id: *program_id,
        accounts,
        data: DrawInstruction::Enter { count, owner: owner.to_bytes() }.pack(),
    }
}

pub fn commit_list(
    program_id: &Pubkey,
    organizer: &Pubkey,
    draw: &Pubkey,
    root: [u8; 32],
    total_weight: u64,
    leaf_count: u64,
    depth: u8,
) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![AccountMeta::new_readonly(*organizer, true), AccountMeta::new(*draw, false)],
        data: DrawInstruction::CommitList { root, total_weight, leaf_count, depth }.pack(),
    }
}

pub fn draw(program_id: &Pubkey, draw: &Pubkey) -> Instruction {
    draw_with_sysvar(program_id, draw, &slot_hashes::id())
}

/// Draw with an explicit SlotHashes account (tests pass a wrong one).
pub fn draw_with_sysvar(program_id: &Pubkey, draw: &Pubkey, hashes: &Pubkey) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![AccountMeta::new(*draw, false), AccountMeta::new_readonly(*hashes, false)],
        data: DrawInstruction::Draw.pack(),
    }
}

pub fn resolve(program_id: &Pubkey, draw: &Pubkey, max: u8, proofs: Vec<LeafProof>) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![AccountMeta::new(*draw, false)],
        data: DrawInstruction::Resolve { max, proofs }.pack(),
    }
}

/// `winner_token` is the winner's prize-mint token account (SPL prizes only).
pub fn claim(
    program_id: &Pubkey,
    winner: &Pubkey,
    draw: &Pubkey,
    slot: u16,
    proof: Option<LeafProof>,
    winner_token: Option<&Pubkey>,
) -> Instruction {
    let mut accounts = vec![AccountMeta::new(*winner, true), AccountMeta::new(*draw, false)];
    if let Some(t) = winner_token {
        accounts.push(AccountMeta::new(*t, false));
        accounts.push(AccountMeta::new(vault_address(program_id, draw).0, false));
        accounts.push(AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false));
    }
    Instruction { program_id: *program_id, accounts, data: DrawInstruction::Claim { slot, proof }.pack() }
}

pub fn advance(program_id: &Pubkey, draw: &Pubkey) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![AccountMeta::new(*draw, false)],
        data: DrawInstruction::Advance.pack(),
    }
}

fn organizer_ix(
    program_id: &Pubkey,
    organizer: &Pubkey,
    draw: &Pubkey,
    organizer_token: Option<&Pubkey>,
    ix: DrawInstruction,
) -> Instruction {
    let mut accounts = vec![AccountMeta::new(*organizer, true), AccountMeta::new(*draw, false)];
    if let Some(t) = organizer_token {
        accounts.push(AccountMeta::new(*t, false));
        accounts.push(AccountMeta::new(vault_address(program_id, draw).0, false));
        accounts.push(AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false));
    }
    Instruction { program_id: *program_id, accounts, data: ix.pack() }
}

pub fn reclaim(program_id: &Pubkey, organizer: &Pubkey, draw: &Pubkey, organizer_token: Option<&Pubkey>) -> Instruction {
    organizer_ix(program_id, organizer, draw, organizer_token, DrawInstruction::Reclaim)
}

pub fn close(program_id: &Pubkey, organizer: &Pubkey, draw: &Pubkey, organizer_token: Option<&Pubkey>) -> Instruction {
    organizer_ix(program_id, organizer, draw, organizer_token, DrawInstruction::Close)
}

pub fn cancel(program_id: &Pubkey, organizer: &Pubkey, draw: &Pubkey, organizer_token: Option<&Pubkey>) -> Instruction {
    organizer_ix(program_id, organizer, draw, organizer_token, DrawInstruction::Cancel)
}

pub fn prove_entry(program_id: &Pubkey, draw: &Pubkey, proof: LeafProof) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![AccountMeta::new_readonly(*draw, false)],
        data: DrawInstruction::ProveEntry { proof }.pack(),
    }
}

pub fn close_entrant(program_id: &Pubkey, owner: &Pubkey, draw: &Pubkey) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new_readonly(*draw, false),
            AccountMeta::new(entrant_address(program_id, draw, owner).0, false),
        ],
        data: DrawInstruction::CloseEntrant.pack(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let proof = LeafProof { leaf_index: 9, wallet: [3; 32], weight: 4, path: vec![7; 3 * PAIR_LEN] };
        let all = vec![
            DrawInstruction::CreateDraw {
                draw_id: 1,
                params: CreateParams {
                    mode: 1,
                    weighted: true,
                    redraw_rounds: 2,
                    tiers: vec![Tier { count: 1, amount: 5 }, Tier { count: 5, amount: 1 }],
                    entry_price: 2,
                    wallet_cap: 3,
                    close_slot: 4,
                    claim_window_slots: 5,
                    prize_mint: [6; 32],
                    entry_mint: [7; 32],
                    fee_dest: [8; 32],
                },
            },
            DrawInstruction::FundPrizes,
            DrawInstruction::Enter { count: 3, owner: [1; 32] },
            DrawInstruction::CommitList { root: [2; 32], total_weight: 3, leaf_count: 4, depth: 5 },
            DrawInstruction::Draw,
            DrawInstruction::Resolve { max: 4, proofs: vec![proof.clone(), proof.clone()] },
            DrawInstruction::Claim { slot: 7, proof: None },
            DrawInstruction::Claim { slot: 7, proof: Some(proof.clone()) },
            DrawInstruction::Advance,
            DrawInstruction::Reclaim,
            DrawInstruction::Close,
            DrawInstruction::Cancel,
            DrawInstruction::ProveEntry { proof },
            DrawInstruction::CloseEntrant,
            DrawInstruction::Extend,
        ];
        for ix in all {
            let b = ix.pack();
            assert_eq!(DrawInstruction::unpack(&b), Some(ix.clone()));
            let mut longer = b.clone();
            longer.push(0);
            assert_eq!(DrawInstruction::unpack(&longer), None, "trailing byte {ix:?}");
            if b.len() > 1 {
                assert_eq!(DrawInstruction::unpack(&b[..b.len() - 1]), None, "short {ix:?}");
            }
        }
        assert_eq!(DrawInstruction::unpack(&[14]), None);
        assert_eq!(DrawInstruction::unpack(&[]), None);
    }
}
