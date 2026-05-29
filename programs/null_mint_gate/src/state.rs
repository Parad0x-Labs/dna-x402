/// ─── EmissionConfig ───────────────────────────────────────────────────────
/// PDA seeds: [b"emission-config"]
///
/// Layout:
///   disc[1]                        = 0xD1
///   admin[32]                      — Pubkey (authority)
///   null_mint[32]                  — the NULL SPL mint pubkey
///   max_null_per_claim_atomic[8]   — u64 LE: max NULL tokens per single claim
///   epoch_duration_slots[8]        — u64 LE: slots per epoch (~2 days = 432000)
///   epoch_null_cap_atomic[8]       — u64 LE: max NULL minted per epoch total
///   current_epoch[8]               — u64 LE: current epoch number
///   epoch_null_minted_atomic[8]    — u64 LE: NULL minted in current epoch so far
///   is_active[1]                   — bool
///
/// Total: 1+32+32+8+8+8+8+8+1 = 106 bytes
pub const EMISSION_CONFIG_SIZE: usize = 106;
pub const EMISSION_CONFIG_DISC: u8 = 0xD1;

pub const EC_OFF_DISC:                usize = 0;
pub const EC_OFF_ADMIN:               usize = 1;
pub const EC_OFF_NULL_MINT:           usize = 33;
pub const EC_OFF_MAX_PER_CLAIM:       usize = 65;
pub const EC_OFF_EPOCH_DURATION:      usize = 73;
pub const EC_OFF_EPOCH_NULL_CAP:      usize = 81;
pub const EC_OFF_CURRENT_EPOCH:       usize = 89;
pub const EC_OFF_EPOCH_NULL_MINTED:   usize = 97;
pub const EC_OFF_IS_ACTIVE:           usize = 105;

pub struct EmissionConfig {
    pub disc:                       u8,
    pub admin:                      [u8; 32],
    pub null_mint:                  [u8; 32],
    pub max_null_per_claim_atomic:  u64,
    pub epoch_duration_slots:       u64,
    pub epoch_null_cap_atomic:      u64,
    pub current_epoch:              u64,
    pub epoch_null_minted_atomic:   u64,
    pub is_active:                  bool,
}

impl EmissionConfig {
    pub fn pack_into(&self, dst: &mut [u8]) {
        dst[EC_OFF_DISC] = self.disc;
        dst[EC_OFF_ADMIN..EC_OFF_ADMIN + 32].copy_from_slice(&self.admin);
        dst[EC_OFF_NULL_MINT..EC_OFF_NULL_MINT + 32].copy_from_slice(&self.null_mint);
        dst[EC_OFF_MAX_PER_CLAIM..EC_OFF_MAX_PER_CLAIM + 8]
            .copy_from_slice(&self.max_null_per_claim_atomic.to_le_bytes());
        dst[EC_OFF_EPOCH_DURATION..EC_OFF_EPOCH_DURATION + 8]
            .copy_from_slice(&self.epoch_duration_slots.to_le_bytes());
        dst[EC_OFF_EPOCH_NULL_CAP..EC_OFF_EPOCH_NULL_CAP + 8]
            .copy_from_slice(&self.epoch_null_cap_atomic.to_le_bytes());
        dst[EC_OFF_CURRENT_EPOCH..EC_OFF_CURRENT_EPOCH + 8]
            .copy_from_slice(&self.current_epoch.to_le_bytes());
        dst[EC_OFF_EPOCH_NULL_MINTED..EC_OFF_EPOCH_NULL_MINTED + 8]
            .copy_from_slice(&self.epoch_null_minted_atomic.to_le_bytes());
        dst[EC_OFF_IS_ACTIVE] = if self.is_active { 1 } else { 0 };
    }

    pub fn unpack_from(src: &[u8]) -> Option<Self> {
        if src.len() < EMISSION_CONFIG_SIZE { return None; }
        if src[EC_OFF_DISC] != EMISSION_CONFIG_DISC { return None; }

        let mut admin     = [0u8; 32];
        let mut null_mint = [0u8; 32];
        admin.copy_from_slice(&src[EC_OFF_ADMIN..EC_OFF_ADMIN + 32]);
        null_mint.copy_from_slice(&src[EC_OFF_NULL_MINT..EC_OFF_NULL_MINT + 32]);

        let mut max_bytes    = [0u8; 8];
        let mut dur_bytes    = [0u8; 8];
        let mut cap_bytes    = [0u8; 8];
        let mut epoch_bytes  = [0u8; 8];
        let mut minted_bytes = [0u8; 8];

        max_bytes.copy_from_slice(&src[EC_OFF_MAX_PER_CLAIM..EC_OFF_MAX_PER_CLAIM + 8]);
        dur_bytes.copy_from_slice(&src[EC_OFF_EPOCH_DURATION..EC_OFF_EPOCH_DURATION + 8]);
        cap_bytes.copy_from_slice(&src[EC_OFF_EPOCH_NULL_CAP..EC_OFF_EPOCH_NULL_CAP + 8]);
        epoch_bytes.copy_from_slice(&src[EC_OFF_CURRENT_EPOCH..EC_OFF_CURRENT_EPOCH + 8]);
        minted_bytes.copy_from_slice(&src[EC_OFF_EPOCH_NULL_MINTED..EC_OFF_EPOCH_NULL_MINTED + 8]);

        Some(Self {
            disc:                      EMISSION_CONFIG_DISC,
            admin,
            null_mint,
            max_null_per_claim_atomic: u64::from_le_bytes(max_bytes),
            epoch_duration_slots:      u64::from_le_bytes(dur_bytes),
            epoch_null_cap_atomic:     u64::from_le_bytes(cap_bytes),
            current_epoch:             u64::from_le_bytes(epoch_bytes),
            epoch_null_minted_atomic:  u64::from_le_bytes(minted_bytes),
            is_active:                 src[EC_OFF_IS_ACTIVE] != 0,
        })
    }
}

/// ─── AgentEmissionRecord ──────────────────────────────────────────────────
/// PDA seeds: [b"emission", nullifier_hash[32]]
///
/// Layout:
///   disc[1]                = 0xD2
///   nullifier_hash[32]     — the Semaphore nullifier hash (double-spend key)
///   receipt_commitment[32] — receipt commitment from the anchored receipt
///   null_amount_atomic[8]  — u64 LE: NULL tokens emitted
///   epoch[8]               — u64 LE: which epoch this was claimed in
///   claimed_at_slot[8]     — u64 LE: Solana slot
///   agent_pubkey[32]       — Pubkey of the claiming agent
///
/// Total: 1+32+32+8+8+8+32 = 121 bytes
pub const AGENT_EMISSION_RECORD_SIZE: usize = 121;
pub const AGENT_EMISSION_RECORD_DISC: u8 = 0xD2;

pub const AER_OFF_DISC:               usize = 0;
pub const AER_OFF_NULLIFIER_HASH:     usize = 1;
pub const AER_OFF_RECEIPT_COMMITMENT: usize = 33;
pub const AER_OFF_NULL_AMOUNT:        usize = 65;
pub const AER_OFF_EPOCH:              usize = 73;
pub const AER_OFF_CLAIMED_AT_SLOT:    usize = 81;
pub const AER_OFF_AGENT_PUBKEY:       usize = 89;

pub struct AgentEmissionRecord {
    pub disc:               u8,
    pub nullifier_hash:     [u8; 32],
    pub receipt_commitment: [u8; 32],
    pub null_amount_atomic: u64,
    pub epoch:              u64,
    pub claimed_at_slot:    u64,
    pub agent_pubkey:       [u8; 32],
}

impl AgentEmissionRecord {
    pub fn pack_into(&self, dst: &mut [u8]) {
        dst[AER_OFF_DISC] = self.disc;
        dst[AER_OFF_NULLIFIER_HASH..AER_OFF_NULLIFIER_HASH + 32]
            .copy_from_slice(&self.nullifier_hash);
        dst[AER_OFF_RECEIPT_COMMITMENT..AER_OFF_RECEIPT_COMMITMENT + 32]
            .copy_from_slice(&self.receipt_commitment);
        dst[AER_OFF_NULL_AMOUNT..AER_OFF_NULL_AMOUNT + 8]
            .copy_from_slice(&self.null_amount_atomic.to_le_bytes());
        dst[AER_OFF_EPOCH..AER_OFF_EPOCH + 8]
            .copy_from_slice(&self.epoch.to_le_bytes());
        dst[AER_OFF_CLAIMED_AT_SLOT..AER_OFF_CLAIMED_AT_SLOT + 8]
            .copy_from_slice(&self.claimed_at_slot.to_le_bytes());
        dst[AER_OFF_AGENT_PUBKEY..AER_OFF_AGENT_PUBKEY + 32]
            .copy_from_slice(&self.agent_pubkey);
    }

    pub fn unpack_from(src: &[u8]) -> Option<Self> {
        if src.len() < AGENT_EMISSION_RECORD_SIZE { return None; }
        if src[AER_OFF_DISC] != AGENT_EMISSION_RECORD_DISC { return None; }

        let mut nullifier_hash     = [0u8; 32];
        let mut receipt_commitment = [0u8; 32];
        let mut agent_pubkey       = [0u8; 32];
        nullifier_hash.copy_from_slice(&src[AER_OFF_NULLIFIER_HASH..AER_OFF_NULLIFIER_HASH + 32]);
        receipt_commitment.copy_from_slice(
            &src[AER_OFF_RECEIPT_COMMITMENT..AER_OFF_RECEIPT_COMMITMENT + 32],
        );
        agent_pubkey.copy_from_slice(&src[AER_OFF_AGENT_PUBKEY..AER_OFF_AGENT_PUBKEY + 32]);

        let mut amount_bytes = [0u8; 8];
        let mut epoch_bytes  = [0u8; 8];
        let mut slot_bytes   = [0u8; 8];
        amount_bytes.copy_from_slice(&src[AER_OFF_NULL_AMOUNT..AER_OFF_NULL_AMOUNT + 8]);
        epoch_bytes.copy_from_slice(&src[AER_OFF_EPOCH..AER_OFF_EPOCH + 8]);
        slot_bytes.copy_from_slice(&src[AER_OFF_CLAIMED_AT_SLOT..AER_OFF_CLAIMED_AT_SLOT + 8]);

        Some(Self {
            disc:               AGENT_EMISSION_RECORD_DISC,
            nullifier_hash,
            receipt_commitment,
            null_amount_atomic: u64::from_le_bytes(amount_bytes),
            epoch:              u64::from_le_bytes(epoch_bytes),
            claimed_at_slot:    u64::from_le_bytes(slot_bytes),
            agent_pubkey,
        })
    }
}
