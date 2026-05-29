/// ─── LotteryConfig ────────────────────────────────────────────────────────
/// PDA seeds: [b"lottery-config"]
///
/// Layout:
///   disc[1]                = 0xC1
///   admin[32]              — Pubkey (authority)
///   ticket_price_null[8]   — u64 atomic (LE)
///   house_fee_bps[2]       — u16 (LE), default 50 = 0.5%
///   numbers_count[1]       — u8,  default 5
///   numbers_range[1]       — u8,  default 30  (draw from 1..=30)
///   fallback_after[1]      — u8,  default 3
///   current_round_id[8]    — u64 (LE)
///   is_active[1]           — bool
///
/// Total: 55 bytes
pub const LOTTERY_CONFIG_SIZE: usize = 55;
pub const LOTTERY_CONFIG_DISC: u8 = 0xC1;

pub const CFG_OFF_DISC:              usize = 0;
pub const CFG_OFF_ADMIN:             usize = 1;
pub const CFG_OFF_TICKET_PRICE:      usize = 33;
pub const CFG_OFF_HOUSE_FEE_BPS:     usize = 41;
pub const CFG_OFF_NUMBERS_COUNT:     usize = 43;
pub const CFG_OFF_NUMBERS_RANGE:     usize = 44;
pub const CFG_OFF_FALLBACK_AFTER:    usize = 45;
pub const CFG_OFF_CURRENT_ROUND_ID:  usize = 46;
pub const CFG_OFF_IS_ACTIVE:         usize = 54;

pub struct LotteryConfig {
    pub disc:              u8,
    pub admin:             [u8; 32],
    pub ticket_price_null: u64,
    pub house_fee_bps:     u16,
    pub numbers_count:     u8,
    pub numbers_range:     u8,
    pub fallback_after:    u8,
    pub current_round_id:  u64,
    pub is_active:         bool,
}

impl LotteryConfig {
    pub fn pack_into(&self, dst: &mut [u8]) {
        dst[CFG_OFF_DISC] = self.disc;
        dst[CFG_OFF_ADMIN..CFG_OFF_ADMIN + 32].copy_from_slice(&self.admin);
        dst[CFG_OFF_TICKET_PRICE..CFG_OFF_TICKET_PRICE + 8]
            .copy_from_slice(&self.ticket_price_null.to_le_bytes());
        dst[CFG_OFF_HOUSE_FEE_BPS..CFG_OFF_HOUSE_FEE_BPS + 2]
            .copy_from_slice(&self.house_fee_bps.to_le_bytes());
        dst[CFG_OFF_NUMBERS_COUNT]  = self.numbers_count;
        dst[CFG_OFF_NUMBERS_RANGE]  = self.numbers_range;
        dst[CFG_OFF_FALLBACK_AFTER] = self.fallback_after;
        dst[CFG_OFF_CURRENT_ROUND_ID..CFG_OFF_CURRENT_ROUND_ID + 8]
            .copy_from_slice(&self.current_round_id.to_le_bytes());
        dst[CFG_OFF_IS_ACTIVE] = if self.is_active { 1 } else { 0 };
    }

    pub fn unpack_from(src: &[u8]) -> Option<Self> {
        if src.len() < LOTTERY_CONFIG_SIZE { return None; }
        if src[CFG_OFF_DISC] != LOTTERY_CONFIG_DISC { return None; }

        let mut admin = [0u8; 32];
        admin.copy_from_slice(&src[CFG_OFF_ADMIN..CFG_OFF_ADMIN + 32]);

        let mut price_bytes = [0u8; 8];
        price_bytes.copy_from_slice(&src[CFG_OFF_TICKET_PRICE..CFG_OFF_TICKET_PRICE + 8]);

        let mut fee_bytes = [0u8; 2];
        fee_bytes.copy_from_slice(&src[CFG_OFF_HOUSE_FEE_BPS..CFG_OFF_HOUSE_FEE_BPS + 2]);

        let mut round_bytes = [0u8; 8];
        round_bytes.copy_from_slice(&src[CFG_OFF_CURRENT_ROUND_ID..CFG_OFF_CURRENT_ROUND_ID + 8]);

        Some(Self {
            disc:              LOTTERY_CONFIG_DISC,
            admin,
            ticket_price_null: u64::from_le_bytes(price_bytes),
            house_fee_bps:     u16::from_le_bytes(fee_bytes),
            numbers_count:     src[CFG_OFF_NUMBERS_COUNT],
            numbers_range:     src[CFG_OFF_NUMBERS_RANGE],
            fallback_after:    src[CFG_OFF_FALLBACK_AFTER],
            current_round_id:  u64::from_le_bytes(round_bytes),
            is_active:         src[CFG_OFF_IS_ACTIVE] != 0,
        })
    }
}

/// ─── RoundState ───────────────────────────────────────────────────────────
/// PDA seeds: [b"round", round_id_le[8]]
///
/// Layout:
///   disc[1]                    = 0xC2
///   round_id[8]                — u64 LE
///   tickets_root[32]           — Poseidon Merkle root
///   ticket_count[8]            — u64 LE
///   total_null_deposited[8]    — u64 LE
///   seed_commitment[32]        — SHA-256(seed)
///   seed_revealed[32]          — actual seed (zeros until revealed)
///   drawn_numbers[5]           — u8 × 5 (zeros until drawn)
///   status[1]                  — RoundStatus byte
///   winner_nullifier[32]       — winning ticket nullifier (zeros until won)
///   no_winner_count[1]         — u8: consecutive rounds without a winner
///
/// Total: 1+8+32+8+8+32+32+5+1+32+1 = 160 bytes
pub const ROUND_STATE_SIZE: usize = 160;
pub const ROUND_STATE_DISC: u8 = 0xC2;

pub const RST_OFF_DISC:                usize = 0;
pub const RST_OFF_ROUND_ID:            usize = 1;
pub const RST_OFF_TICKETS_ROOT:        usize = 9;
pub const RST_OFF_TICKET_COUNT:        usize = 41;
pub const RST_OFF_TOTAL_NULL:          usize = 49;
pub const RST_OFF_SEED_COMMITMENT:     usize = 57;
pub const RST_OFF_SEED_REVEALED:       usize = 89;
pub const RST_OFF_DRAWN_NUMBERS:       usize = 121;
pub const RST_OFF_STATUS:              usize = 126;
pub const RST_OFF_WINNER_NULLIFIER:    usize = 127;
pub const RST_OFF_NO_WINNER_COUNT:     usize = 159;

/// Round lifecycle status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum RoundStatus {
    Open      = 0,
    Committed = 1,
    Anchored  = 2,
    Drawn     = 3,
    Won       = 4,
    NoWinner  = 5,
}

impl RoundStatus {
    pub fn from_byte(b: u8) -> Option<Self> {
        match b {
            0 => Some(Self::Open),
            1 => Some(Self::Committed),
            2 => Some(Self::Anchored),
            3 => Some(Self::Drawn),
            4 => Some(Self::Won),
            5 => Some(Self::NoWinner),
            _ => None,
        }
    }
}

pub struct RoundState {
    pub disc:                 u8,
    pub round_id:             u64,
    pub tickets_root:         [u8; 32],
    pub ticket_count:         u64,
    pub total_null_deposited: u64,
    pub seed_commitment:      [u8; 32],
    pub seed_revealed:        [u8; 32],
    pub drawn_numbers:        [u8; 5],
    pub status:               RoundStatus,
    pub winner_nullifier:     [u8; 32],
    pub no_winner_count:      u8,
}

impl RoundState {
    pub fn pack_into(&self, dst: &mut [u8]) {
        dst[RST_OFF_DISC] = self.disc;
        dst[RST_OFF_ROUND_ID..RST_OFF_ROUND_ID + 8]
            .copy_from_slice(&self.round_id.to_le_bytes());
        dst[RST_OFF_TICKETS_ROOT..RST_OFF_TICKETS_ROOT + 32]
            .copy_from_slice(&self.tickets_root);
        dst[RST_OFF_TICKET_COUNT..RST_OFF_TICKET_COUNT + 8]
            .copy_from_slice(&self.ticket_count.to_le_bytes());
        dst[RST_OFF_TOTAL_NULL..RST_OFF_TOTAL_NULL + 8]
            .copy_from_slice(&self.total_null_deposited.to_le_bytes());
        dst[RST_OFF_SEED_COMMITMENT..RST_OFF_SEED_COMMITMENT + 32]
            .copy_from_slice(&self.seed_commitment);
        dst[RST_OFF_SEED_REVEALED..RST_OFF_SEED_REVEALED + 32]
            .copy_from_slice(&self.seed_revealed);
        dst[RST_OFF_DRAWN_NUMBERS..RST_OFF_DRAWN_NUMBERS + 5]
            .copy_from_slice(&self.drawn_numbers);
        dst[RST_OFF_STATUS] = self.status as u8;
        dst[RST_OFF_WINNER_NULLIFIER..RST_OFF_WINNER_NULLIFIER + 32]
            .copy_from_slice(&self.winner_nullifier);
        dst[RST_OFF_NO_WINNER_COUNT] = self.no_winner_count;
    }

    pub fn unpack_from(src: &[u8]) -> Option<Self> {
        if src.len() < ROUND_STATE_SIZE { return None; }
        if src[RST_OFF_DISC] != ROUND_STATE_DISC { return None; }

        let mut round_id_bytes    = [0u8; 8];
        let mut tickets_root      = [0u8; 32];
        let mut ticket_count_bytes = [0u8; 8];
        let mut total_null_bytes  = [0u8; 8];
        let mut seed_commitment   = [0u8; 32];
        let mut seed_revealed     = [0u8; 32];
        let mut drawn_numbers     = [0u8; 5];
        let mut winner_nullifier  = [0u8; 32];

        round_id_bytes.copy_from_slice(&src[RST_OFF_ROUND_ID..RST_OFF_ROUND_ID + 8]);
        tickets_root.copy_from_slice(&src[RST_OFF_TICKETS_ROOT..RST_OFF_TICKETS_ROOT + 32]);
        ticket_count_bytes.copy_from_slice(&src[RST_OFF_TICKET_COUNT..RST_OFF_TICKET_COUNT + 8]);
        total_null_bytes.copy_from_slice(&src[RST_OFF_TOTAL_NULL..RST_OFF_TOTAL_NULL + 8]);
        seed_commitment.copy_from_slice(&src[RST_OFF_SEED_COMMITMENT..RST_OFF_SEED_COMMITMENT + 32]);
        seed_revealed.copy_from_slice(&src[RST_OFF_SEED_REVEALED..RST_OFF_SEED_REVEALED + 32]);
        drawn_numbers.copy_from_slice(&src[RST_OFF_DRAWN_NUMBERS..RST_OFF_DRAWN_NUMBERS + 5]);
        winner_nullifier.copy_from_slice(&src[RST_OFF_WINNER_NULLIFIER..RST_OFF_WINNER_NULLIFIER + 32]);

        let status = RoundStatus::from_byte(src[RST_OFF_STATUS])?;

        Some(Self {
            disc:                 ROUND_STATE_DISC,
            round_id:             u64::from_le_bytes(round_id_bytes),
            tickets_root,
            ticket_count:         u64::from_le_bytes(ticket_count_bytes),
            total_null_deposited: u64::from_le_bytes(total_null_bytes),
            seed_commitment,
            seed_revealed,
            drawn_numbers,
            status,
            winner_nullifier,
            no_winner_count:      src[RST_OFF_NO_WINNER_COUNT],
        })
    }
}

/// ─── ClaimNullifier ────────────────────────────────────────────────────────
/// PDA seeds: [b"claim", nullifier_hash[32]]
///
/// Layout:
///   disc[1]       = 0xC3
///   used[1]       — 1 = claimed
///   round_id[8]   — u64 LE
///   claimed_at[8] — slot u64 LE
///
/// Total: 18 bytes
pub const CLAIM_NULLIFIER_SIZE: usize = 18;
pub const CLAIM_NULLIFIER_DISC: u8 = 0xC3;

pub const CLM_OFF_DISC:       usize = 0;
pub const CLM_OFF_USED:       usize = 1;
pub const CLM_OFF_ROUND_ID:   usize = 2;
pub const CLM_OFF_CLAIMED_AT: usize = 10;

pub struct ClaimNullifier {
    pub disc:       u8,
    pub used:       bool,
    pub round_id:   u64,
    pub claimed_at: u64,
}

impl ClaimNullifier {
    pub fn pack_into(&self, dst: &mut [u8]) {
        dst[CLM_OFF_DISC] = self.disc;
        dst[CLM_OFF_USED] = if self.used { 1 } else { 0 };
        dst[CLM_OFF_ROUND_ID..CLM_OFF_ROUND_ID + 8]
            .copy_from_slice(&self.round_id.to_le_bytes());
        dst[CLM_OFF_CLAIMED_AT..CLM_OFF_CLAIMED_AT + 8]
            .copy_from_slice(&self.claimed_at.to_le_bytes());
    }

    pub fn unpack_from(src: &[u8]) -> Option<Self> {
        if src.len() < CLAIM_NULLIFIER_SIZE { return None; }
        if src[CLM_OFF_DISC] != CLAIM_NULLIFIER_DISC { return None; }

        let mut round_id_bytes   = [0u8; 8];
        let mut claimed_at_bytes = [0u8; 8];

        round_id_bytes.copy_from_slice(&src[CLM_OFF_ROUND_ID..CLM_OFF_ROUND_ID + 8]);
        claimed_at_bytes.copy_from_slice(&src[CLM_OFF_CLAIMED_AT..CLM_OFF_CLAIMED_AT + 8]);

        Some(Self {
            disc:       CLAIM_NULLIFIER_DISC,
            used:       src[CLM_OFF_USED] != 0,
            round_id:   u64::from_le_bytes(round_id_bytes),
            claimed_at: u64::from_le_bytes(claimed_at_bytes),
        })
    }
}
