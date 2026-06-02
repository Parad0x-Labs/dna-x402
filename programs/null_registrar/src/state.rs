/// ─── NullDomain ──────────────────────────────────────────────────────────────
/// PDA seeds: [b"null-domain", name_bytes[64]]
///
/// Layout:
///   disc[1]            = 0x4E ('N')
///   name[64]           — domain name, null-padded (e.g. "parad0x\0\0...")
///   owner[32]          — current owner Pubkey
///   content_hash[32]   — Arweave tx ID hash (what .null resolves to)
///   registered_at[8]   — i64 LE: unix timestamp
///   expires_at[8]      — i64 LE: unix timestamp (0 = no expiry)
///   null_paid[8]       — u64 LE: NULL tokens paid at registration
///   bump[1]            — PDA bump
///
/// Total: 1+64+32+32+8+8+8+1 = 154 bytes
pub const NULL_DOMAIN_SIZE: usize = 154;
pub const NULL_DOMAIN_DISC: u8    = 0x4E; // 'N'

pub const ND_OFF_DISC:            usize = 0;
pub const ND_OFF_NAME:            usize = 1;
pub const ND_OFF_OWNER:           usize = 65;
pub const ND_OFF_CONTENT_HASH:    usize = 97;
pub const ND_OFF_REGISTERED_AT:   usize = 129;
pub const ND_OFF_EXPIRES_AT:      usize = 137;
pub const ND_OFF_NULL_PAID:       usize = 145;
pub const ND_OFF_BUMP:            usize = 153;

pub struct NullDomain {
    pub disc:            u8,
    pub name:            [u8; 64],
    pub owner:           [u8; 32],
    pub content_hash:    [u8; 32],
    pub registered_at:   i64,
    pub expires_at:      i64,
    pub null_paid:       u64,
    pub bump:            u8,
}

impl NullDomain {
    pub fn pack_into(&self, dst: &mut [u8]) {
        dst[ND_OFF_DISC] = self.disc;
        dst[ND_OFF_NAME..ND_OFF_NAME + 64].copy_from_slice(&self.name);
        dst[ND_OFF_OWNER..ND_OFF_OWNER + 32].copy_from_slice(&self.owner);
        dst[ND_OFF_CONTENT_HASH..ND_OFF_CONTENT_HASH + 32].copy_from_slice(&self.content_hash);
        dst[ND_OFF_REGISTERED_AT..ND_OFF_REGISTERED_AT + 8]
            .copy_from_slice(&self.registered_at.to_le_bytes());
        dst[ND_OFF_EXPIRES_AT..ND_OFF_EXPIRES_AT + 8]
            .copy_from_slice(&self.expires_at.to_le_bytes());
        dst[ND_OFF_NULL_PAID..ND_OFF_NULL_PAID + 8]
            .copy_from_slice(&self.null_paid.to_le_bytes());
        dst[ND_OFF_BUMP] = self.bump;
    }

    pub fn unpack_from(src: &[u8]) -> Option<Self> {
        if src.len() < NULL_DOMAIN_SIZE { return None; }
        if src[ND_OFF_DISC] != NULL_DOMAIN_DISC { return None; }

        let mut name          = [0u8; 64];
        let mut owner         = [0u8; 32];
        let mut content_hash  = [0u8; 32];
        name.copy_from_slice(&src[ND_OFF_NAME..ND_OFF_NAME + 64]);
        owner.copy_from_slice(&src[ND_OFF_OWNER..ND_OFF_OWNER + 32]);
        content_hash.copy_from_slice(&src[ND_OFF_CONTENT_HASH..ND_OFF_CONTENT_HASH + 32]);

        let mut reg_bytes  = [0u8; 8];
        let mut exp_bytes  = [0u8; 8];
        let mut paid_bytes = [0u8; 8];
        reg_bytes.copy_from_slice(&src[ND_OFF_REGISTERED_AT..ND_OFF_REGISTERED_AT + 8]);
        exp_bytes.copy_from_slice(&src[ND_OFF_EXPIRES_AT..ND_OFF_EXPIRES_AT + 8]);
        paid_bytes.copy_from_slice(&src[ND_OFF_NULL_PAID..ND_OFF_NULL_PAID + 8]);

        Some(Self {
            disc:           NULL_DOMAIN_DISC,
            name,
            owner,
            content_hash,
            registered_at:  i64::from_le_bytes(reg_bytes),
            expires_at:     i64::from_le_bytes(exp_bytes),
            null_paid:      u64::from_le_bytes(paid_bytes),
            bump:           src[ND_OFF_BUMP],
        })
    }
}

/// ─── RegistryConfig ──────────────────────────────────────────────────────────
/// PDA seeds: [b"null-registry"]
///
/// Layout:
///   disc[1]                = 0x52 ('R')
///   authority[32]          — Squads multisig Pubkey
///   registration_fee[8]    — u64 LE: NULL tokens required (atomic)
///   null_mint[32]          — NULL token mint Pubkey
///   treasury[32]           — where NULL fees go
///   total_registered[8]    — u64 LE: all-time domain count
///   bump[1]                — PDA bump
///
/// Total: 1+32+8+32+32+8+1 = 114 bytes
pub const REGISTRY_CONFIG_SIZE: usize = 114;
pub const REGISTRY_CONFIG_DISC: u8    = 0x52; // 'R'

pub const RC_OFF_DISC:               usize = 0;
pub const RC_OFF_AUTHORITY:          usize = 1;
pub const RC_OFF_REGISTRATION_FEE:   usize = 33;
pub const RC_OFF_NULL_MINT:          usize = 41;
pub const RC_OFF_TREASURY:           usize = 73;
pub const RC_OFF_TOTAL_REGISTERED:   usize = 105;
pub const RC_OFF_BUMP:               usize = 113;

pub struct RegistryConfig {
    pub disc:               u8,
    pub authority:          [u8; 32],
    pub registration_fee:   u64,
    pub null_mint:          [u8; 32],
    pub treasury:           [u8; 32],
    pub total_registered:   u64,
    pub bump:               u8,
}

impl RegistryConfig {
    pub fn pack_into(&self, dst: &mut [u8]) {
        dst[RC_OFF_DISC] = self.disc;
        dst[RC_OFF_AUTHORITY..RC_OFF_AUTHORITY + 32].copy_from_slice(&self.authority);
        dst[RC_OFF_REGISTRATION_FEE..RC_OFF_REGISTRATION_FEE + 8]
            .copy_from_slice(&self.registration_fee.to_le_bytes());
        dst[RC_OFF_NULL_MINT..RC_OFF_NULL_MINT + 32].copy_from_slice(&self.null_mint);
        dst[RC_OFF_TREASURY..RC_OFF_TREASURY + 32].copy_from_slice(&self.treasury);
        dst[RC_OFF_TOTAL_REGISTERED..RC_OFF_TOTAL_REGISTERED + 8]
            .copy_from_slice(&self.total_registered.to_le_bytes());
        dst[RC_OFF_BUMP] = self.bump;
    }

    pub fn unpack_from(src: &[u8]) -> Option<Self> {
        if src.len() < REGISTRY_CONFIG_SIZE { return None; }
        if src[RC_OFF_DISC] != REGISTRY_CONFIG_DISC { return None; }

        let mut authority  = [0u8; 32];
        let mut null_mint  = [0u8; 32];
        let mut treasury   = [0u8; 32];
        authority.copy_from_slice(&src[RC_OFF_AUTHORITY..RC_OFF_AUTHORITY + 32]);
        null_mint.copy_from_slice(&src[RC_OFF_NULL_MINT..RC_OFF_NULL_MINT + 32]);
        treasury.copy_from_slice(&src[RC_OFF_TREASURY..RC_OFF_TREASURY + 32]);

        let mut fee_bytes   = [0u8; 8];
        let mut total_bytes = [0u8; 8];
        fee_bytes.copy_from_slice(&src[RC_OFF_REGISTRATION_FEE..RC_OFF_REGISTRATION_FEE + 8]);
        total_bytes.copy_from_slice(&src[RC_OFF_TOTAL_REGISTERED..RC_OFF_TOTAL_REGISTERED + 8]);

        Some(Self {
            disc:               REGISTRY_CONFIG_DISC,
            authority,
            registration_fee:   u64::from_le_bytes(fee_bytes),
            null_mint,
            treasury,
            total_registered:   u64::from_le_bytes(total_bytes),
            bump:               src[RC_OFF_BUMP],
        })
    }
}
