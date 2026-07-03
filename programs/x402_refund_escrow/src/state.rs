use solana_program::{
    program_error::ProgramError,
    program_pack::{IsInitialized, Pack, Sealed},
};

use crate::error::EscrowError;

pub const ESCROW_STATE_VERSION: u8 = 1;

/// Lifecycle of one escrowed x402 call.
///
/// Open → SettledSuccess (seller vouched success in time)
///      → Refunded        (deadline passed with no success vouch)
///      → Slashed         (seller equivocated: two conflicting signed receipts)
pub mod status {
    pub const OPEN: u8 = 0;
    pub const SETTLED_SUCCESS: u8 = 1;
    pub const REFUNDED: u8 = 2;
    pub const SLASHED: u8 = 3;
}

/// PDA seed prefix: [b"x402-escrow", payment_commitment].
pub const ESCROW_SEED_PREFIX: &[u8] = b"x402-escrow";

pub const ESCROW_ACCOUNT_LEN: usize =
    1 + 1 + 1 + 32 + 32 + 8 + 8 + 32 + 8 + 8 + 32 + 8 + 8; // = 179

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Escrow {
    pub version: u8,
    pub bump: u8,
    pub status: u8,
    pub buyer: [u8; 32],
    /// Seller's key — both the payout recipient and the ed25519 vouch key.
    pub seller: [u8; 32],
    /// Lamports the buyer escrowed for the call.
    pub amount: u64,
    /// Lamports the seller bonded; slashable on equivocation.
    pub bond: u64,
    /// Binds the escrow to one x402 request (hash of quote/req_id/payment).
    pub payment_commitment: [u8; 32],
    /// Unix seconds; after this with no success vouch, buyer auto-refunds.
    pub deadline: i64,
    /// Unix seconds; until this, an equivocation proof can still slash a
    /// settled seller. 0 until settled.
    pub dispute_deadline: i64,
    /// response_hash from the accepted success receipt (0 until settled).
    pub response_hash: [u8; 32],
    pub created_at: i64,
    /// Seconds of dispute grace the buyer chose at open; used at settle to set
    /// `dispute_deadline = settle_time + dispute_window`.
    pub dispute_window: i64,
}

impl Sealed for Escrow {}

impl IsInitialized for Escrow {
    fn is_initialized(&self) -> bool {
        self.version == ESCROW_STATE_VERSION
    }
}

impl Pack for Escrow {
    const LEN: usize = ESCROW_ACCOUNT_LEN;

    fn unpack_from_slice(src: &[u8]) -> Result<Self, ProgramError> {
        if src.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let version = src[0];
        if version != ESCROW_STATE_VERSION {
            return Err(EscrowError::StateVersionMismatch.into());
        }
        let mut buyer = [0u8; 32];
        buyer.copy_from_slice(&src[3..35]);
        let mut seller = [0u8; 32];
        seller.copy_from_slice(&src[35..67]);
        let mut amount_raw = [0u8; 8];
        amount_raw.copy_from_slice(&src[67..75]);
        let mut bond_raw = [0u8; 8];
        bond_raw.copy_from_slice(&src[75..83]);
        let mut pc = [0u8; 32];
        pc.copy_from_slice(&src[83..115]);
        let mut deadline_raw = [0u8; 8];
        deadline_raw.copy_from_slice(&src[115..123]);
        let mut dispute_raw = [0u8; 8];
        dispute_raw.copy_from_slice(&src[123..131]);
        let mut rh = [0u8; 32];
        rh.copy_from_slice(&src[131..163]);
        let mut created_raw = [0u8; 8];
        created_raw.copy_from_slice(&src[163..171]);
        let mut window_raw = [0u8; 8];
        window_raw.copy_from_slice(&src[171..179]);

        Ok(Self {
            version,
            bump: src[1],
            status: src[2],
            buyer,
            seller,
            amount: u64::from_le_bytes(amount_raw),
            bond: u64::from_le_bytes(bond_raw),
            payment_commitment: pc,
            deadline: i64::from_le_bytes(deadline_raw),
            dispute_deadline: i64::from_le_bytes(dispute_raw),
            response_hash: rh,
            created_at: i64::from_le_bytes(created_raw),
            dispute_window: i64::from_le_bytes(window_raw),
        })
    }

    fn pack_into_slice(&self, dst: &mut [u8]) {
        dst[..Self::LEN].fill(0);
        dst[0] = self.version;
        dst[1] = self.bump;
        dst[2] = self.status;
        dst[3..35].copy_from_slice(&self.buyer);
        dst[35..67].copy_from_slice(&self.seller);
        dst[67..75].copy_from_slice(&self.amount.to_le_bytes());
        dst[75..83].copy_from_slice(&self.bond.to_le_bytes());
        dst[83..115].copy_from_slice(&self.payment_commitment);
        dst[115..123].copy_from_slice(&self.deadline.to_le_bytes());
        dst[123..131].copy_from_slice(&self.dispute_deadline.to_le_bytes());
        dst[131..163].copy_from_slice(&self.response_hash);
        dst[163..171].copy_from_slice(&self.created_at.to_le_bytes());
        dst[171..179].copy_from_slice(&self.dispute_window.to_le_bytes());
    }
}
