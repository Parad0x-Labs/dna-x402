//! Program errors. Custom codes use the range `0x4644_0001..=0x4644_00FF`
//! ("FD" for fair draw), distinct from every other program in this repo.

use solana_program::program_error::ProgramError;

/// Base of this program's custom error codes.
pub const ERROR_BASE: u32 = 0x4644_0000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum DrawError {
    /// Instruction data is malformed or the tag is unknown.
    InvalidInstruction = 1,
    /// CreateDraw or CommitList parameters are outside the bounds.
    InvalidParams = 2,
    /// An account has the wrong owner, discriminator, size or address.
    InvalidAccount = 3,
    /// A PDA to create already holds data or belongs to another program.
    AccountInUse = 4,
    /// The draw is not in the status this instruction needs.
    WrongStatus = 5,
    /// Enter at or after the close slot.
    EntriesClosed = 6,
    /// Draw of an open raffle before its close slot.
    EntriesOpen = 7,
    /// The entry would take the wallet above the per-wallet cap.
    WalletCapExceeded = 8,
    /// The entry tree is full (2^20 leaves).
    TreeFull = 9,
    /// The SlotHashes account is wrong or malformed.
    InvalidSysvar = 10,
    /// The target slot (or the active fallback slot) has no hash yet.
    DrawTooEarly = 11,
    /// A leaf proof does not lead to the committed root and total.
    InvalidProof = 12,
    /// The proven leaf does not contain the drawn point.
    PointNotInLeaf = 13,
    /// A weighted Resolve carried no proof for the next winner.
    MissingProof = 14,
    /// Claim by a key that is not the slot's winner, or of a slot not won.
    NotWinner = 15,
    /// Claim after the claim window.
    ClaimWindowClosed = 16,
    /// Advance before the claim window ended.
    ClaimWindowOpen = 17,
    /// The signer is not the organizer.
    NotOrganizer = 18,
    /// The vault would hold less than the unpaid prizes.
    Insolvent = 19,
    /// Checked arithmetic overflowed.
    MathOverflow = 20,
    /// A token account has the wrong mint, owner or state.
    InvalidTokenAccount = 21,
    /// Resolve with no slot left to resolve in the current round.
    NothingToResolve = 22,
    /// A leaf with weight zero.
    ZeroWeight = 23,
    /// Claim of a slot that was already claimed.
    AlreadyClaimed = 24,
    /// CloseEntrant while entries are still open.
    EntrantInUse = 25,
    /// FundPrizes before the draw account reached its full size (Extend).
    AccountNotExtended = 26,
}

impl DrawError {
    pub const fn code(self) -> u32 {
        ERROR_BASE + self as u32
    }
}

impl From<DrawError> for ProgramError {
    fn from(e: DrawError) -> Self {
        ProgramError::Custom(e.code())
    }
}
