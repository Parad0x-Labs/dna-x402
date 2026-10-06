//! Program errors. Custom codes use the range `0x5853_0001..=0x5853_00FF`
//! ("XS" for x402 settle), distinct from every other program in this repo.

use solana_program::program_error::ProgramError;

/// Base of this program's custom error codes.
pub const ERROR_BASE: u32 = 0x5853_0000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum XsError {
    /// Instruction data is malformed or the tag is unknown.
    InvalidInstruction = 1,
    /// An account has the wrong owner, discriminator, size, address (PDA with
    /// the canonical bump) or ledger, or a program / sysvar id is wrong.
    InvalidAccount = 2,
    /// A PDA to be created already holds data or belongs to another program.
    AccountInUse = 3,
    /// The mint's token program is not Token or Token-2022, or the mint
    /// carries a Token-2022 extension outside the allowlist.
    MintNotAllowed = 4,
    /// A required signer is missing or is not the expected key.
    Unauthorized = 5,
    /// The escrow, channel or payee balance is below the amount.
    InsufficientFunds = 6,
    /// Checked arithmetic overflowed.
    MathOverflow = 7,
    /// The voucher signature does not verify for the rebuilt message.
    BadSignature = 8,
    /// The voucher's expiry slot is in the past.
    VoucherExpired = 9,
    /// The voucher's cumulative amount does not exceed the recorded one
    /// (replay or out-of-date voucher).
    StaleVoucher = 10,
    /// The payer-payee pair is reserved by a two-phase batch.
    PairPending = 11,
    /// The pair entry belongs to another payee.
    PairMismatch = 12,
    /// The escrow pair table is full (grow the escrow).
    PairTableFull = 13,
    /// The payee slot is empty, taken, or not owned by the expected payee.
    SlotMismatch = 14,
    /// Escrow withdraw before the exit delay has passed, or with no exit
    /// request.
    ExitNotReady = 15,
    /// Escrow close while it still holds funds, reservations or channels.
    EscrowBusy = 16,
    /// The payer key is non-canonical or of small order.
    InvalidPayerKey = 17,
    /// The channel is not in the state this instruction needs.
    ChannelState = 18,
    /// Voucher submitted to an open channel at or after its expiry slot.
    ChannelExpired = 19,
    /// Reclaim of an open channel before its expiry slot.
    ChannelNotExpired = 20,
    /// Finalize while the dispute window is still open.
    DisputeOpen = 21,
    /// The channel voucher exceeds the channel balance.
    OverDeposit = 22,
    /// The batch is not in the state this instruction needs.
    BatchState = 23,
    /// Stage or commit after the batch deadline.
    BatchDeadline = 24,
    /// Abort by someone other than the submitter before the deadline.
    BatchNotTimedOut = 25,
    /// The chunk was already staged.
    ChunkAlreadyStaged = 26,
    /// Chunk index, voucher count or proof length does not match the batch.
    BadChunk = 27,
    /// The chunk does not hash to the batch root.
    BadMerkleProof = 28,
    /// Commit before every chunk is staged.
    BatchIncomplete = 29,
    /// The staged total differs from the total fixed at BeginBatch.
    BatchTotalMismatch = 30,
    /// The batch already credits the maximum number of payee slots.
    BatchPayeesFull = 31,
    /// Close of a batch that still has pending pairs.
    BatchOutstanding = 32,
    /// Vault holdings would fall below the ledger's liabilities.
    Insolvent = 33,
    /// Parameters out of the program bounds.
    InvalidParams = 34,
    /// Resolve of a pair that is not pending in this batch.
    WrongPendingBatch = 35,
    /// A voucher tried to append a second pair entry for a payee that
    /// already has one in this escrow.
    DuplicatePair = 36,
}

impl XsError {
    pub const fn code(self) -> u32 {
        ERROR_BASE + self as u32
    }
}

impl From<XsError> for ProgramError {
    fn from(e: XsError) -> Self {
        ProgramError::Custom(e.code())
    }
}
