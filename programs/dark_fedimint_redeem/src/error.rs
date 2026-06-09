use solana_program::program_error::ProgramError;

/// Custom error codes for the federated-eNULL redeem program. Stable values —
/// the e2e harness asserts on these.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RedeemError {
    AlreadyInitialized = 0,
    NotInitialized = 1,
    ZeroDenomination = 2,
    /// The token's nullifier PDA already exists — double-spend.
    NullifierAlreadySpent = 3,
    /// `Y != H2C(secret)` — the point does not bind the revealed secret.
    PointMismatch = 4,
    /// The DLEQ proof did not verify under the stored group key.
    DleqInvalid = 5,
    /// Reserve vault has less than one denomination.
    InsufficientReserve = 6,
    InvalidInstruction = 7,
    ArithmeticOverflow = 8,
    /// Stored group key on the config doesn't match the artifact's group key.
    WrongMintKey = 9,
    /// `recipient == reserve_vault` — would burn a single-use token for a
    /// net-zero payout (the vault would pay itself). Rejected before the
    /// nullifier is created so the token is preserved.
    RecipientIsReserveVault = 10,
}

impl From<RedeemError> for ProgramError {
    fn from(e: RedeemError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
