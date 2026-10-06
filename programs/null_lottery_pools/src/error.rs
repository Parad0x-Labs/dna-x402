//! Program errors. Custom codes use the range `0x4C50_0001..=0x4C50_00FF`
//! ("LP" for lottery pools), distinct from every other program in this repo.

use solana_program::program_error::ProgramError;

/// Base of this program's custom error codes.
pub const ERROR_BASE: u32 = 0x4C50_0000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum PoolError {
    /// Instruction data is malformed or the tag is unknown.
    InvalidInstruction = 1,
    /// CreatePool parameters are outside the program bounds.
    InvalidParams = 2,
    /// An account has the wrong owner, discriminator, size or address
    /// (PDA with the canonical bump), or a sysvar / program id is wrong.
    InvalidAccount = 3,
    /// A PDA to be created already holds data or is owned by another program.
    AccountInUse = 4,
    /// BuyTicket names a round that is not the pool's open round.
    WrongRound = 5,
    /// BuyTicket after the round's close slot.
    SalesClosed = 6,
    /// Draw before the round's close slot.
    SalesOpen = 7,
    /// Ticket numbers are not k strictly ascending values in 1..=n, zero padded.
    InvalidNumbers = 8,
    /// The round already holds 2^20 tickets.
    RoundFull = 9,
    /// Draw while the previous drawn round is not settled yet.
    PreviousRoundUnsettled = 10,
    /// The SlotHashes account is not the SlotHashes sysvar or is malformed.
    InvalidSysvar = 11,
    /// The fixed target slot (or the active fallback slot) has no hash yet.
    DrawTooEarly = 12,
    /// The round is not in the status this instruction needs.
    WrongStatus = 13,
    /// Claim after the claim window.
    ClaimWindowClosed = 14,
    /// Settle before the claim window ended.
    ClaimWindowOpen = 15,
    /// The ticket numbers are not the drawn numbers.
    TicketNotWinning = 16,
    /// The ticket leaf (built from the claimant key) is not under the round root.
    InvalidProof = 17,
    /// A claim record for this (pool, round, ticket index) already exists.
    AlreadyClaimed = 18,
    /// The signer is not the pool creator.
    NotCreator = 19,
    /// Withdraw amount is zero or above the accrued creator fees.
    InsufficientFees = 20,
    /// Pool lamports would fall below its liabilities plus rent.
    Insolvent = 21,
    /// Retire conditions are not met.
    RetireNotAllowed = 22,
    /// Checked arithmetic overflowed.
    MathOverflow = 23,
    /// Payout: the claim record or the owner account does not match.
    ClaimMismatch = 24,
    /// CloseRound before every registered winner was paid.
    RoundNotFinished = 25,
    /// CloseRound: the rent receiver is not the account that paid the rent.
    WrongRentPayer = 26,
    /// Retire on a pool that is already retired.
    AlreadyRetired = 27,
}

impl PoolError {
    pub const fn code(self) -> u32 {
        ERROR_BASE + self as u32
    }
}

impl From<PoolError> for ProgramError {
    fn from(e: PoolError) -> Self {
        ProgramError::Custom(e.code())
    }
}
