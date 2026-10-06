//! Instruction tags, wire formats and client-side builders.
//!
//! All integers are little-endian. Account lists are given per instruction in
//! the README and in the builders below; "w" = writable, "s" = signer.

use crate::state::{BATCH_SEED, BOOK_SEED, CHANNEL_SEED, ESCROW_SEED, LEDGER_SEED, VAULT_SEED};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program, sysvar,
};

pub mod tag {
    pub const INIT_LEDGER: u8 = 0;
    pub const OPEN_ESCROW: u8 = 1;
    pub const GROW_ESCROW: u8 = 2;
    pub const DEPOSIT: u8 = 3;
    pub const REQUEST_EXIT: u8 = 4;
    pub const WITHDRAW_ESCROW: u8 = 5;
    pub const CLOSE_ESCROW: u8 = 6;
    pub const CREATE_BOOK: u8 = 7;
    pub const REGISTER_PAYEE: u8 = 8;
    pub const WITHDRAW_PAYEE: u8 = 9;
    pub const SETTLE: u8 = 10;
    pub const OPEN_CHANNEL: u8 = 11;
    pub const CLOSE_CHANNELS: u8 = 12;
    pub const REQUEST_CHANNEL_CLOSE: u8 = 13;
    pub const FINALIZE_CHANNEL: u8 = 14;
    pub const RECLAIM_CHANNEL: u8 = 15;
    pub const BEGIN_BATCH: u8 = 16;
    pub const STAGE_CHUNK: u8 = 17;
    pub const COMMIT_BATCH: u8 = 18;
    pub const ABORT_BATCH: u8 = 19;
    pub const RESOLVE_STAGED: u8 = 20;
    pub const CLOSE_BATCH: u8 = 21;
}

/// Lane B2 voucher on the wire (Settle, StageChunk):
/// `escrow_ix u8 | pair_ix u8 | book_ix u8 | slot u8 | cumulative u64 |
/// expiry_slot u64 | quote_hash 32 | signature 64`. The account indexes point
/// into the instruction's account list.
pub const VOUCHER_WIRE_LEN: usize = 116;
/// Lane C close entry on the wire (CloseChannels):
/// `channel_ix u8 | book_ix u8 | slot u8 | cumulative u64 | expiry_slot u64 |
/// quote_hash 32 | signature 64`.
pub const CLOSE_WIRE_LEN: usize = 115;
/// `book_ix` value meaning "no book" in a CloseChannels entry.
pub const NO_BOOK: u8 = 0xff;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WireVoucher {
    pub escrow_ix: u8,
    pub pair_ix: u8,
    pub book_ix: u8,
    pub slot: u8,
    pub cumulative: u64,
    pub expiry_slot: u64,
    pub quote_hash: [u8; 32],
    pub sig: [u8; 64],
}

impl WireVoucher {
    pub fn decode(b: &[u8]) -> Self {
        let mut quote_hash = [0u8; 32];
        quote_hash.copy_from_slice(&b[20..52]);
        let mut sig = [0u8; 64];
        sig.copy_from_slice(&b[52..116]);
        WireVoucher {
            escrow_ix: b[0],
            pair_ix: b[1],
            book_ix: b[2],
            slot: b[3],
            cumulative: u64::from_le_bytes(b[4..12].try_into().unwrap()),
            expiry_slot: u64::from_le_bytes(b[12..20].try_into().unwrap()),
            quote_hash,
            sig,
        }
    }
    pub fn encode(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&[self.escrow_ix, self.pair_ix, self.book_ix, self.slot]);
        out.extend_from_slice(&self.cumulative.to_le_bytes());
        out.extend_from_slice(&self.expiry_slot.to_le_bytes());
        out.extend_from_slice(&self.quote_hash);
        out.extend_from_slice(&self.sig);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WireClose {
    pub channel_ix: u8,
    pub book_ix: u8,
    pub slot: u8,
    pub cumulative: u64,
    pub expiry_slot: u64,
    pub quote_hash: [u8; 32],
    pub sig: [u8; 64],
}

impl WireClose {
    pub fn decode(b: &[u8]) -> Self {
        let mut quote_hash = [0u8; 32];
        quote_hash.copy_from_slice(&b[19..51]);
        let mut sig = [0u8; 64];
        sig.copy_from_slice(&b[51..115]);
        WireClose {
            channel_ix: b[0],
            book_ix: b[1],
            slot: b[2],
            cumulative: u64::from_le_bytes(b[3..11].try_into().unwrap()),
            expiry_slot: u64::from_le_bytes(b[11..19].try_into().unwrap()),
            quote_hash,
            sig,
        }
    }
    pub fn encode(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&[self.channel_ix, self.book_ix, self.slot]);
        out.extend_from_slice(&self.cumulative.to_le_bytes());
        out.extend_from_slice(&self.expiry_slot.to_le_bytes());
        out.extend_from_slice(&self.quote_hash);
        out.extend_from_slice(&self.sig);
    }
}

// ---------------------------------------------------------------------------
// PDAs
// ---------------------------------------------------------------------------

/// Mint seed of the SOL ledger.
pub const SOL_MINT: [u8; 32] = [0u8; 32];

pub fn ledger_pda(program_id: &Pubkey, mint: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[LEDGER_SEED, mint], program_id)
}
pub fn vault_pda(program_id: &Pubkey, ledger: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_SEED, ledger.as_ref()], program_id)
}
pub fn escrow_pda(program_id: &Pubkey, ledger: &Pubkey, payer: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ESCROW_SEED, ledger.as_ref(), payer.as_ref()], program_id)
}
pub fn book_pda(program_id: &Pubkey, ledger: &Pubkey, page: u32) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[BOOK_SEED, ledger.as_ref(), &page.to_le_bytes()], program_id)
}
pub fn channel_pda(program_id: &Pubkey, ledger: &Pubkey, payer: &Pubkey, payee: &Pubkey, channel_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[CHANNEL_SEED, ledger.as_ref(), payer.as_ref(), payee.as_ref(), &channel_id.to_le_bytes()],
        program_id,
    )
}
pub fn batch_pda(program_id: &Pubkey, ledger: &Pubkey, batch_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[BATCH_SEED, ledger.as_ref(), &batch_id.to_le_bytes()], program_id)
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/// SPL accounts appended to Deposit / WithdrawEscrow / WithdrawPayee for a
/// token ledger: (vault, mint, token program).
#[derive(Clone, Copy, Debug)]
pub struct SplAccounts {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
}

fn ix(program_id: &Pubkey, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction { program_id: *program_id, accounts, data }
}

pub fn init_ledger_sol(program_id: &Pubkey, funder: &Pubkey) -> Instruction {
    let (ledger, _) = ledger_pda(program_id, &SOL_MINT);
    ix(
        program_id,
        vec![
            AccountMeta::new(*funder, true),
            AccountMeta::new(ledger, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(sysvar::slot_hashes::id(), false),
        ],
        vec![tag::INIT_LEDGER, crate::state::KIND_SOL],
    )
}

pub fn init_ledger_spl(program_id: &Pubkey, funder: &Pubkey, mint: &Pubkey, token_program: &Pubkey, kind: u8) -> Instruction {
    let (ledger, _) = ledger_pda(program_id, &mint.to_bytes());
    let (vault, _) = vault_pda(program_id, &ledger);
    ix(
        program_id,
        vec![
            AccountMeta::new(*funder, true),
            AccountMeta::new(ledger, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(*token_program, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(sysvar::slot_hashes::id(), false),
        ],
        vec![tag::INIT_LEDGER, kind],
    )
}

pub fn open_escrow(program_id: &Pubkey, ledger: &Pubkey, payer: &Pubkey, capacity: u8) -> Instruction {
    let (escrow, _) = escrow_pda(program_id, ledger, payer);
    ix(
        program_id,
        vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(*ledger, false),
            AccountMeta::new(escrow, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        vec![tag::OPEN_ESCROW, capacity],
    )
}

pub fn grow_escrow(program_id: &Pubkey, ledger: &Pubkey, payer: &Pubkey, capacity: u8) -> Instruction {
    let (escrow, _) = escrow_pda(program_id, ledger, payer);
    ix(
        program_id,
        vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(escrow, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        vec![tag::GROW_ESCROW, capacity],
    )
}

/// `source` is the depositor's token account (SPL) and is ignored for SOL.
pub fn deposit(
    program_id: &Pubkey,
    ledger: &Pubkey,
    depositor: &Pubkey,
    payer: &Pubkey,
    amount: u64,
    spl: Option<(Pubkey, SplAccounts)>,
) -> Instruction {
    let (escrow, _) = escrow_pda(program_id, ledger, payer);
    let mut data = vec![tag::DEPOSIT];
    data.extend_from_slice(&amount.to_le_bytes());
    let accounts = match spl {
        None => vec![
            AccountMeta::new(*depositor, true),
            AccountMeta::new(*ledger, false),
            AccountMeta::new(escrow, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        Some((source, s)) => vec![
            AccountMeta::new_readonly(*depositor, true),
            AccountMeta::new(*ledger, false),
            AccountMeta::new(escrow, false),
            AccountMeta::new(source, false),
            AccountMeta::new(s.vault, false),
            AccountMeta::new_readonly(s.mint, false),
            AccountMeta::new_readonly(s.token_program, false),
        ],
    };
    ix(program_id, accounts, data)
}

pub fn request_exit(program_id: &Pubkey, ledger: &Pubkey, payer: &Pubkey, amount: u64) -> Instruction {
    let (escrow, _) = escrow_pda(program_id, ledger, payer);
    let mut data = vec![tag::REQUEST_EXIT];
    data.extend_from_slice(&amount.to_le_bytes());
    ix(
        program_id,
        vec![
            AccountMeta::new_readonly(*payer, true),
            AccountMeta::new_readonly(*ledger, false),
            AccountMeta::new(escrow, false),
        ],
        data,
    )
}

fn with_spl(mut v: Vec<AccountMeta>, spl: Option<SplAccounts>) -> Vec<AccountMeta> {
    if let Some(s) = spl {
        v.push(AccountMeta::new(s.vault, false));
        v.push(AccountMeta::new_readonly(s.mint, false));
        v.push(AccountMeta::new_readonly(s.token_program, false));
    }
    v
}

pub fn withdraw_escrow(program_id: &Pubkey, ledger: &Pubkey, payer: &Pubkey, destination: &Pubkey, spl: Option<SplAccounts>) -> Instruction {
    let (escrow, _) = escrow_pda(program_id, ledger, payer);
    ix(
        program_id,
        with_spl(
            vec![
                AccountMeta::new_readonly(*payer, true),
                AccountMeta::new(*ledger, false),
                AccountMeta::new(escrow, false),
                AccountMeta::new(*destination, false),
            ],
            spl,
        ),
        vec![tag::WITHDRAW_ESCROW],
    )
}

pub fn close_escrow(program_id: &Pubkey, ledger: &Pubkey, payer: &Pubkey) -> Instruction {
    let (escrow, _) = escrow_pda(program_id, ledger, payer);
    ix(
        program_id,
        vec![AccountMeta::new(*payer, true), AccountMeta::new(escrow, false)],
        vec![tag::CLOSE_ESCROW],
    )
}

pub fn create_book(program_id: &Pubkey, ledger: &Pubkey, funder: &Pubkey, page: u32) -> Instruction {
    let (book, _) = book_pda(program_id, ledger, page);
    let mut data = vec![tag::CREATE_BOOK];
    data.extend_from_slice(&page.to_le_bytes());
    ix(
        program_id,
        vec![
            AccountMeta::new(*funder, true),
            AccountMeta::new_readonly(*ledger, false),
            AccountMeta::new(book, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data,
    )
}

pub fn register_payee(program_id: &Pubkey, book: &Pubkey, payee: &Pubkey, slot: u8) -> Instruction {
    ix(
        program_id,
        vec![AccountMeta::new_readonly(*payee, true), AccountMeta::new(*book, false)],
        vec![tag::REGISTER_PAYEE, slot],
    )
}

pub fn withdraw_payee(
    program_id: &Pubkey,
    ledger: &Pubkey,
    book: &Pubkey,
    payee: &Pubkey,
    slot: u8,
    amount: u64,
    destination: &Pubkey,
    spl: Option<SplAccounts>,
) -> Instruction {
    let mut data = vec![tag::WITHDRAW_PAYEE, slot];
    data.extend_from_slice(&amount.to_le_bytes());
    ix(
        program_id,
        with_spl(
            vec![
                AccountMeta::new_readonly(*payee, true),
                AccountMeta::new(*ledger, false),
                AccountMeta::new(*book, false),
                AccountMeta::new(*destination, false),
            ],
            spl,
        ),
        data,
    )
}

/// Settle: account 0 is the ledger; `accounts` are the escrows and books the
/// vouchers index (from 1).
pub fn settle(program_id: &Pubkey, ledger: &Pubkey, accounts: &[Pubkey], vouchers: &[WireVoucher]) -> Instruction {
    let mut metas = vec![AccountMeta::new_readonly(*ledger, false)];
    metas.extend(accounts.iter().map(|k| AccountMeta::new(*k, false)));
    let mut data = vec![tag::SETTLE, vouchers.len() as u8];
    for v in vouchers {
        v.encode(&mut data);
    }
    ix(program_id, metas, data)
}

pub fn open_channel(
    program_id: &Pubkey,
    ledger: &Pubkey,
    payer: &Pubkey,
    payee: &Pubkey,
    channel_id: u64,
    deposit: u64,
    expiry_slot: u64,
) -> Instruction {
    let (escrow, _) = escrow_pda(program_id, ledger, payer);
    let (channel, _) = channel_pda(program_id, ledger, payer, payee, channel_id);
    let mut data = vec![tag::OPEN_CHANNEL];
    data.extend_from_slice(&channel_id.to_le_bytes());
    data.extend_from_slice(payee.as_ref());
    data.extend_from_slice(&deposit.to_le_bytes());
    data.extend_from_slice(&expiry_slot.to_le_bytes());
    ix(
        program_id,
        vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(*ledger, false),
            AccountMeta::new(escrow, false),
            AccountMeta::new(channel, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data,
    )
}

/// CloseChannels: account 0 is the ledger; `writable` are the channels and
/// books the entries index (from 1); `signers` are payees signing to close
/// without a dispute window (appended after `writable`).
pub fn close_channels(program_id: &Pubkey, ledger: &Pubkey, writable: &[Pubkey], signers: &[Pubkey], entries: &[WireClose]) -> Instruction {
    let mut metas = vec![AccountMeta::new_readonly(*ledger, false)];
    metas.extend(writable.iter().map(|k| AccountMeta::new(*k, false)));
    metas.extend(signers.iter().map(|k| AccountMeta::new_readonly(*k, true)));
    let mut data = vec![tag::CLOSE_CHANNELS, entries.len() as u8];
    for e in entries {
        e.encode(&mut data);
    }
    ix(program_id, metas, data)
}

pub fn request_channel_close(program_id: &Pubkey, ledger: &Pubkey, payer: &Pubkey, channel: &Pubkey) -> Instruction {
    ix(
        program_id,
        vec![
            AccountMeta::new_readonly(*payer, true),
            AccountMeta::new_readonly(*ledger, false),
            AccountMeta::new(*channel, false),
        ],
        vec![tag::REQUEST_CHANNEL_CLOSE],
    )
}

/// FinalizeChannel: account 0 = channel, then the payee's book (needed when
/// the channel pays the payee) and the payee as signer (to finalize before
/// the dispute window ends, or to release an open channel).
pub fn finalize_channel(program_id: &Pubkey, channel: &Pubkey, book: Option<(&Pubkey, u8)>, payee_signer: Option<&Pubkey>) -> Instruction {
    let mut metas = vec![AccountMeta::new(*channel, false)];
    let mut slot = 0u8;
    if let Some((b, s)) = book {
        metas.push(AccountMeta::new(*b, false));
        slot = s;
    }
    if let Some(p) = payee_signer {
        metas.push(AccountMeta::new_readonly(*p, true));
    }
    ix(program_id, metas, vec![tag::FINALIZE_CHANNEL, slot])
}

pub fn reclaim_channel(program_id: &Pubkey, ledger: &Pubkey, channel: &Pubkey, payer: &Pubkey) -> Instruction {
    let (escrow, _) = escrow_pda(program_id, ledger, payer);
    ix(
        program_id,
        vec![AccountMeta::new(*channel, false), AccountMeta::new(escrow, false), AccountMeta::new(*payer, false)],
        vec![tag::RECLAIM_CHANNEL],
    )
}

#[allow(clippy::too_many_arguments)]
pub fn begin_batch(
    program_id: &Pubkey,
    ledger: &Pubkey,
    submitter: &Pubkey,
    batch_id: u64,
    root: &[u8; 32],
    count: u32,
    total: u64,
    chunk_log: u8,
    chunk_size: u8,
) -> Instruction {
    let (batch, _) = batch_pda(program_id, ledger, batch_id);
    let mut data = vec![tag::BEGIN_BATCH];
    data.extend_from_slice(&batch_id.to_le_bytes());
    data.extend_from_slice(root);
    data.extend_from_slice(&count.to_le_bytes());
    data.extend_from_slice(&total.to_le_bytes());
    data.push(chunk_log);
    data.push(chunk_size);
    ix(
        program_id,
        vec![
            AccountMeta::new(*submitter, true),
            AccountMeta::new_readonly(*ledger, false),
            AccountMeta::new(batch, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data,
    )
}

/// StageChunk: accounts 0 = ledger, 1 = batch, then `escrows` (writable,
/// indexed from 2) and `books` (read-only, after the escrows).
pub fn stage_chunk(
    program_id: &Pubkey,
    ledger: &Pubkey,
    batch: &Pubkey,
    escrows: &[Pubkey],
    books: &[Pubkey],
    chunk_index: u16,
    proof: &[[u8; 32]],
    vouchers: &[WireVoucher],
) -> Instruction {
    let mut metas = vec![AccountMeta::new_readonly(*ledger, false), AccountMeta::new(*batch, false)];
    metas.extend(escrows.iter().map(|k| AccountMeta::new(*k, false)));
    metas.extend(books.iter().map(|k| AccountMeta::new_readonly(*k, false)));
    let mut data = vec![tag::STAGE_CHUNK];
    data.extend_from_slice(&chunk_index.to_le_bytes());
    data.push(vouchers.len() as u8);
    data.push(proof.len() as u8);
    for p in proof {
        data.extend_from_slice(p);
    }
    for v in vouchers {
        v.encode(&mut data);
    }
    ix(program_id, metas, data)
}

pub fn commit_batch(program_id: &Pubkey, batch: &Pubkey, books: &[Pubkey]) -> Instruction {
    let mut metas = vec![AccountMeta::new(*batch, false)];
    metas.extend(books.iter().map(|k| AccountMeta::new(*k, false)));
    ix(program_id, metas, vec![tag::COMMIT_BATCH])
}

pub fn abort_batch(program_id: &Pubkey, batch: &Pubkey, caller: &Pubkey) -> Instruction {
    ix(
        program_id,
        vec![AccountMeta::new_readonly(*caller, true), AccountMeta::new(*batch, false)],
        vec![tag::ABORT_BATCH],
    )
}

/// ResolveStaged: account 0 = batch, then the escrows (indexed from 1);
/// entries are `(escrow_ix, pair_ix)`.
pub fn resolve_staged(program_id: &Pubkey, batch: &Pubkey, escrows: &[Pubkey], entries: &[(u8, u8)]) -> Instruction {
    let mut metas = vec![AccountMeta::new(*batch, false)];
    metas.extend(escrows.iter().map(|k| AccountMeta::new(*k, false)));
    let mut data = vec![tag::RESOLVE_STAGED, entries.len() as u8];
    for (e, p) in entries {
        data.push(*e);
        data.push(*p);
    }
    ix(program_id, metas, data)
}

pub fn close_batch(program_id: &Pubkey, batch: &Pubkey, submitter: &Pubkey) -> Instruction {
    ix(
        program_id,
        vec![AccountMeta::new(*batch, false), AccountMeta::new(*submitter, false)],
        vec![tag::CLOSE_BATCH],
    )
}
