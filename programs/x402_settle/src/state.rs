//! Account layouts. Every account starts with an 8-byte discriminator and the
//! canonical bump of its PDA (found with `find_program_address` at creation,
//! re-checked with `create_program_address` on every later use).
//!
//! | Account | Seeds | Size |
//! |---|---|---|
//! | Ledger (one per mint; for SOL it is also the vault) | `["ledger", mint]` (mint = 32 zero bytes for SOL) | 192 |
//! | Vault (SPL token account, authority = ledger) | `["vault", ledger]` | 165 |
//! | Escrow (one per payer) | `["escrow", ledger, payer]` | 120 + 56 per pair |
//! | Book (shared payee balances) | `["book", ledger, page_le32]` | 48 + 40 x 64 |
//! | Channel | `["channel", ledger, payer, payee, channel_id_le]` | 168 |
//! | Batch (two-phase commit) | `["batch", ledger, batch_id_le]` | 968 |

use crate::error::XsError;
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

pub const LEDGER_SEED: &[u8] = b"ledger";
pub const VAULT_SEED: &[u8] = b"vault";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const BOOK_SEED: &[u8] = b"book";
pub const CHANNEL_SEED: &[u8] = b"channel";
pub const BATCH_SEED: &[u8] = b"batch";

pub const DISC_LEDGER: &[u8; 8] = b"x4sLEDGR";
pub const DISC_ESCROW: &[u8; 8] = b"x4sESCRW";
pub const DISC_BOOK: &[u8; 8] = b"x4sBOOK_";
pub const DISC_CHANNEL: &[u8; 8] = b"x4sCHANL";
pub const DISC_BATCH: &[u8; 8] = b"x4sBATCH";

// ---------------------------------------------------------------------------
// Program constants
// ---------------------------------------------------------------------------

/// Delay between an escrow exit request and the withdrawal (about one hour
/// at 400 ms slots). Vouchers already handed to payees settle during it.
pub const EXIT_DELAY_SLOTS: u64 = 9_000;
/// Dispute window of a channel close that the payee did not sign.
pub const DISPUTE_SLOTS: u64 = 1_500;
/// A two-phase batch must commit within this many slots of BeginBatch;
/// after that anyone can abort it.
pub const BATCH_TIMEOUT_SLOTS: u64 = 1_500;
/// Longest channel lifetime at open.
pub const MAX_CHANNEL_SLOTS: u64 = 6_480_000;
/// Pair table capacity limit of one escrow (pair index is a u8).
pub const MAX_PAIRS: usize = 255;
/// Payee slots per book page (slot index is a u8).
pub const BOOK_SLOTS: usize = 64;
/// Chunks per two-phase batch.
pub const MAX_CHUNKS: u32 = 256;
/// Chunk subtree height limit (32 leaves).
pub const MAX_CHUNK_LOG: u8 = 5;
/// Distinct payee slots one two-phase batch may credit.
pub const MAX_BATCH_PAYEES: usize = 16;

pub const KIND_SOL: u8 = 0;
pub const KIND_TOKEN: u8 = 1;
pub const KIND_TOKEN_2022: u8 = 2;

pub const CH_OPEN: u8 = 1;
pub const CH_CLOSING: u8 = 2;
pub const CH_CLOSED: u8 = 3;

pub const B_STAGING: u8 = 1;
pub const B_COMMITTED: u8 = 2;
pub const B_ABORTED: u8 = 3;

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

#[inline(always)]
pub fn rd_u64(d: &[u8], o: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[o..o + 8]);
    u64::from_le_bytes(b)
}
#[inline(always)]
pub fn wr_u64(d: &mut [u8], o: usize, v: u64) {
    d[o..o + 8].copy_from_slice(&v.to_le_bytes());
}
#[inline(always)]
pub fn rd_u32(d: &[u8], o: usize) -> u32 {
    let mut b = [0u8; 4];
    b.copy_from_slice(&d[o..o + 4]);
    u32::from_le_bytes(b)
}
#[inline(always)]
pub fn wr_u32(d: &mut [u8], o: usize, v: u32) {
    d[o..o + 4].copy_from_slice(&v.to_le_bytes());
}
#[inline(always)]
pub fn rd_u16(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([d[o], d[o + 1]])
}
#[inline(always)]
pub fn wr_u16(d: &mut [u8], o: usize, v: u16) {
    d[o..o + 2].copy_from_slice(&v.to_le_bytes());
}
#[inline(always)]
pub fn rd_key(d: &[u8], o: usize) -> [u8; 32] {
    let mut k = [0u8; 32];
    k.copy_from_slice(&d[o..o + 32]);
    k
}

/// Checks owner, size and discriminator of a program account.
pub fn check_program_account(acc: &AccountInfo, program_id: &Pubkey, disc: &[u8; 8], len: Option<usize>) -> Result<(), ProgramError> {
    if acc.owner != program_id {
        return Err(XsError::InvalidAccount.into());
    }
    let d = acc.try_borrow_data()?;
    if d.len() < 9 || &d[0..8] != disc {
        return Err(XsError::InvalidAccount.into());
    }
    if let Some(l) = len {
        if d.len() != l {
            return Err(XsError::InvalidAccount.into());
        }
    }
    Ok(())
}

/// Re-derives a PDA with its stored canonical bump.
pub fn check_pda(key: &Pubkey, seeds: &[&[u8]], bump: u8, program_id: &Pubkey) -> Result<(), ProgramError> {
    let b = [bump];
    let mut s: [&[u8]; 6] = [&[]; 6];
    s[..seeds.len()].copy_from_slice(seeds);
    s[seeds.len()] = &b;
    let pda = Pubkey::create_program_address(&s[..seeds.len() + 1], program_id).map_err(|_| XsError::InvalidAccount)?;
    if pda != *key {
        return Err(XsError::InvalidAccount.into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

pub const LEDGER_LEN: usize = 192;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ledger {
    pub bump: u8,
    pub vault_bump: u8,
    pub kind: u8,
    pub decimals: u8,
    /// 32 zero bytes for SOL.
    pub mint: [u8; 32],
    /// 32 zero bytes for SOL.
    pub token_program: [u8; 32],
    /// The vault token account; the ledger itself for SOL.
    pub vault: [u8; 32],
    pub salt: [u8; 32],
    pub exit_delay_slots: u64,
    pub dispute_slots: u64,
    pub batch_timeout_slots: u64,
    /// Sum of every escrow balance, channel balance, batch hold and payee
    /// balance of this ledger.
    pub liabilities: u64,
    /// Next escrow / channel scope; scopes are never reused.
    pub next_scope: u64,
    pub created_slot: u64,
}

impl Ledger {
    pub fn unpack(d: &[u8]) -> Self {
        Ledger {
            bump: d[8],
            vault_bump: d[9],
            kind: d[10],
            decimals: d[11],
            mint: rd_key(d, 16),
            token_program: rd_key(d, 48),
            vault: rd_key(d, 80),
            salt: rd_key(d, 112),
            exit_delay_slots: rd_u64(d, 144),
            dispute_slots: rd_u64(d, 152),
            batch_timeout_slots: rd_u64(d, 160),
            liabilities: rd_u64(d, 168),
            next_scope: rd_u64(d, 176),
            created_slot: rd_u64(d, 184),
        }
    }
    pub fn pack(&self, d: &mut [u8]) {
        d[0..8].copy_from_slice(DISC_LEDGER);
        d[8] = self.bump;
        d[9] = self.vault_bump;
        d[10] = self.kind;
        d[11] = self.decimals;
        d[12..16].fill(0);
        d[16..48].copy_from_slice(&self.mint);
        d[48..80].copy_from_slice(&self.token_program);
        d[80..112].copy_from_slice(&self.vault);
        d[112..144].copy_from_slice(&self.salt);
        wr_u64(d, 144, self.exit_delay_slots);
        wr_u64(d, 152, self.dispute_slots);
        wr_u64(d, 160, self.batch_timeout_slots);
        wr_u64(d, 168, self.liabilities);
        wr_u64(d, 176, self.next_scope);
        wr_u64(d, 184, self.created_slot);
    }
    /// Loads a ledger after owner, size, discriminator and PDA checks.
    pub fn load(acc: &AccountInfo, program_id: &Pubkey) -> Result<Self, ProgramError> {
        check_program_account(acc, program_id, DISC_LEDGER, Some(LEDGER_LEN))?;
        let l = Ledger::unpack(&acc.try_borrow_data()?);
        check_pda(acc.key, &[LEDGER_SEED, &l.mint], l.bump, program_id)?;
        Ok(l)
    }
    pub fn store(&self, acc: &AccountInfo) -> Result<(), ProgramError> {
        self.pack(&mut acc.try_borrow_mut_data()?);
        Ok(())
    }
    pub fn liabilities_add(&mut self, v: u64) -> Result<(), ProgramError> {
        self.liabilities = self.liabilities.checked_add(v).ok_or(XsError::MathOverflow)?;
        Ok(())
    }
    pub fn liabilities_sub(&mut self, v: u64) -> Result<(), ProgramError> {
        self.liabilities = self.liabilities.checked_sub(v).ok_or(XsError::MathOverflow)?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Escrow
// ---------------------------------------------------------------------------

pub const ESCROW_HDR: usize = 120;
pub const PAIR_LEN: usize = 56;

pub fn escrow_len(capacity: usize) -> usize {
    ESCROW_HDR + capacity * PAIR_LEN
}

pub mod escrow {
    //! Field offsets.
    pub const BUMP: usize = 8;
    pub const CAPACITY: usize = 10; // u8
    pub const PAIR_COUNT: usize = 11; // u8
    pub const PENDING_COUNT: usize = 12; // u16
    pub const LEDGER: usize = 16;
    pub const PAYER: usize = 48;
    pub const SCOPE: usize = 80;
    pub const BALANCE: usize = 88;
    pub const EXIT_AMOUNT: usize = 96;
    pub const EXIT_READY: usize = 104;
    pub const OPEN_CHANNELS: usize = 112; // u32
    // pair entry: payee 32 | settled u64 | pending_cum u64 | pending_batch u64
    pub const P_PAYEE: usize = 0;
    pub const P_SETTLED: usize = 32;
    pub const P_PENDING_CUM: usize = 40;
    pub const P_PENDING_BATCH: usize = 48;
}

/// Checks an escrow account (owner, discriminator, size, PDA) and returns
/// `(ledger, payer)`.
pub fn check_escrow(acc: &AccountInfo, program_id: &Pubkey) -> Result<([u8; 32], [u8; 32]), ProgramError> {
    check_program_account(acc, program_id, DISC_ESCROW, None)?;
    let d = acc.try_borrow_data()?;
    if d.len() < ESCROW_HDR || d.len() != escrow_len(d[escrow::CAPACITY] as usize) {
        return Err(XsError::InvalidAccount.into());
    }
    let ledger = rd_key(&d, escrow::LEDGER);
    let payer = rd_key(&d, escrow::PAYER);
    check_pda(acc.key, &[ESCROW_SEED, &ledger, &payer], d[escrow::BUMP], program_id)?;
    Ok((ledger, payer))
}

#[inline(always)]
pub fn pair_off(i: usize) -> usize {
    ESCROW_HDR + i * PAIR_LEN
}

// ---------------------------------------------------------------------------
// Book (shared payee balances)
// ---------------------------------------------------------------------------

pub const BOOK_HDR: usize = 48;
pub const SLOT_LEN: usize = 40;
pub const BOOK_LEN: usize = BOOK_HDR + BOOK_SLOTS * SLOT_LEN;

pub mod book {
    pub const BUMP: usize = 8;
    pub const USED: usize = 10; // u16
    pub const PAGE: usize = 12; // u32
    pub const LEDGER: usize = 16;
    // slot: owner 32 | balance u64
    pub const S_OWNER: usize = 0;
    pub const S_BALANCE: usize = 32;
}

#[inline(always)]
pub fn slot_off(i: usize) -> usize {
    BOOK_HDR + i * SLOT_LEN
}

/// Checks a book page and returns its ledger.
pub fn check_book(acc: &AccountInfo, program_id: &Pubkey) -> Result<[u8; 32], ProgramError> {
    check_program_account(acc, program_id, DISC_BOOK, Some(BOOK_LEN))?;
    let d = acc.try_borrow_data()?;
    let ledger = rd_key(&d, book::LEDGER);
    let page = rd_u32(&d, book::PAGE).to_le_bytes();
    check_pda(acc.key, &[BOOK_SEED, &ledger, &page], d[book::BUMP], program_id)?;
    Ok(ledger)
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

pub const CHANNEL_LEN: usize = 168;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Channel {
    pub bump: u8,
    pub status: u8,
    pub ledger: [u8; 32],
    pub payer: [u8; 32],
    pub payee: [u8; 32],
    pub channel_id: u64,
    pub scope: u64,
    pub deposit: u64,
    /// Funds still held by the channel.
    pub balance: u64,
    /// Highest cumulative voucher submitted (paid to the payee on close).
    pub best_cum: u64,
    pub expiry_slot: u64,
    pub dispute_end_slot: u64,
}

impl Channel {
    pub fn unpack(d: &[u8]) -> Self {
        Channel {
            bump: d[8],
            status: d[9],
            ledger: rd_key(d, 16),
            payer: rd_key(d, 48),
            payee: rd_key(d, 80),
            channel_id: rd_u64(d, 112),
            scope: rd_u64(d, 120),
            deposit: rd_u64(d, 128),
            balance: rd_u64(d, 136),
            best_cum: rd_u64(d, 144),
            expiry_slot: rd_u64(d, 152),
            dispute_end_slot: rd_u64(d, 160),
        }
    }
    pub fn pack(&self, d: &mut [u8]) {
        d[0..8].copy_from_slice(DISC_CHANNEL);
        d[8] = self.bump;
        d[9] = self.status;
        d[10..16].fill(0);
        d[16..48].copy_from_slice(&self.ledger);
        d[48..80].copy_from_slice(&self.payer);
        d[80..112].copy_from_slice(&self.payee);
        wr_u64(d, 112, self.channel_id);
        wr_u64(d, 120, self.scope);
        wr_u64(d, 128, self.deposit);
        wr_u64(d, 136, self.balance);
        wr_u64(d, 144, self.best_cum);
        wr_u64(d, 152, self.expiry_slot);
        wr_u64(d, 160, self.dispute_end_slot);
    }
    pub fn load(acc: &AccountInfo, program_id: &Pubkey) -> Result<Self, ProgramError> {
        check_program_account(acc, program_id, DISC_CHANNEL, Some(CHANNEL_LEN))?;
        let c = Channel::unpack(&acc.try_borrow_data()?);
        check_pda(
            acc.key,
            &[CHANNEL_SEED, &c.ledger, &c.payer, &c.payee, &c.channel_id.to_le_bytes()],
            c.bump,
            program_id,
        )?;
        Ok(c)
    }
    pub fn store(&self, acc: &AccountInfo) -> Result<(), ProgramError> {
        self.pack(&mut acc.try_borrow_mut_data()?);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Batch (two-phase commit)
// ---------------------------------------------------------------------------

pub const BATCH_HDR: usize = 168;
pub const BITMAP_LEN: usize = (MAX_CHUNKS / 8) as usize;
pub const BATCH_PAYEE_LEN: usize = 48;
pub const BATCH_PAYEES_OFF: usize = BATCH_HDR + BITMAP_LEN;
pub const BATCH_LEN: usize = BATCH_PAYEES_OFF + MAX_BATCH_PAYEES * BATCH_PAYEE_LEN;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BatchHdr {
    pub bump: u8,
    pub status: u8,
    pub chunk_log: u8,
    pub chunk_size: u8,
    pub n_payees: u8,
    pub num_chunks: u16,
    pub chunks_staged: u16,
    pub ledger: [u8; 32],
    pub submitter: [u8; 32],
    pub batch_id: u64,
    pub root: [u8; 32],
    pub count: u32,
    pub staged_count: u32,
    pub total: u64,
    pub staged_total: u64,
    /// Funds taken from escrows by staging and not yet credited or returned.
    pub held: u64,
    pub deadline_slot: u64,
    /// Escrow pairs still marked pending with this batch.
    pub outstanding: u32,
}

impl BatchHdr {
    pub fn unpack(d: &[u8]) -> Self {
        BatchHdr {
            bump: d[8],
            status: d[9],
            chunk_log: d[10],
            chunk_size: d[11],
            n_payees: d[12],
            num_chunks: rd_u16(d, 13),
            chunks_staged: rd_u16(d, 15),
            ledger: rd_key(d, 24),
            submitter: rd_key(d, 56),
            batch_id: rd_u64(d, 88),
            root: rd_key(d, 96),
            count: rd_u32(d, 128),
            staged_count: rd_u32(d, 132),
            total: rd_u64(d, 136),
            staged_total: rd_u64(d, 144),
            held: rd_u64(d, 152),
            deadline_slot: rd_u64(d, 160),
            outstanding: rd_u32(d, 17),
        }
    }
    pub fn pack(&self, d: &mut [u8]) {
        d[0..8].copy_from_slice(DISC_BATCH);
        d[8] = self.bump;
        d[9] = self.status;
        d[10] = self.chunk_log;
        d[11] = self.chunk_size;
        d[12] = self.n_payees;
        wr_u16(d, 13, self.num_chunks);
        wr_u16(d, 15, self.chunks_staged);
        wr_u32(d, 17, self.outstanding);
        d[21..24].fill(0);
        d[24..56].copy_from_slice(&self.ledger);
        d[56..88].copy_from_slice(&self.submitter);
        wr_u64(d, 88, self.batch_id);
        d[96..128].copy_from_slice(&self.root);
        wr_u32(d, 128, self.count);
        wr_u32(d, 132, self.staged_count);
        wr_u64(d, 136, self.total);
        wr_u64(d, 144, self.staged_total);
        wr_u64(d, 152, self.held);
        wr_u64(d, 160, self.deadline_slot);
    }
    pub fn load(acc: &AccountInfo, program_id: &Pubkey) -> Result<Self, ProgramError> {
        check_program_account(acc, program_id, DISC_BATCH, Some(BATCH_LEN))?;
        let b = BatchHdr::unpack(&acc.try_borrow_data()?);
        check_pda(acc.key, &[BATCH_SEED, &b.ledger, &b.batch_id.to_le_bytes()], b.bump, program_id)?;
        Ok(b)
    }
}

/// Batch payee entry: book 32 | amount u64 | slot u8 | pad 7.
pub fn batch_payee_off(i: usize) -> usize {
    BATCH_PAYEES_OFF + i * BATCH_PAYEE_LEN
}
