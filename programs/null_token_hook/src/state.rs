/// AllowlistEntry PDA — seeds: [b"allowlist", owner_pubkey]
///
/// Marks a wallet as approved to transfer NULL tokens without limit.
///
/// Layout:
///   disc[1]     = 0xAA
///   pubkey[32]  — the approved wallet / agent
///   flags[8]    — bit 0 = agent_passport_verified, bit 1 = guild_member
///
/// Size: 1 + 32 + 8 = 41 bytes
pub const ALLOWLIST_ENTRY_SIZE: usize = 41;
pub const ALLOWLIST_DISC: [u8; 1] = [0xAA];

/// HookConfig PDA — seeds: [b"hook-config", admin_pubkey]
///
/// Global configuration set by the hook admin.
///
/// Layout:
///   disc[1]                  = 0xBB
///   admin[32]                — admin pubkey
///   hook_enabled[1]          — 1 if the hook is active, 0 = pass-through
///   dark_pool_limit_atomic[8] — max transfer for unapproved wallets (0 = no limit)
///
/// Size: 1 + 32 + 1 + 8 = 42 bytes
pub const HOOK_CONFIG_SIZE: usize = 42;
pub const CONFIG_DISC: [u8; 1] = [0xBB];

/// Bit flag: the owner holds a verified agent passport.
pub const FLAG_AGENT_PASSPORT_VERIFIED: u64 = 1 << 0;
/// Bit flag: the owner is a NULL guild member.
pub const FLAG_GUILD_MEMBER: u64 = 1 << 1;

// ── AllowlistEntry ────────────────────────────────────────────────────────────

pub struct AllowlistEntry {
    pub disc:   [u8; 1],
    pub pubkey: [u8; 32],
    pub flags:  u64,
}

impl AllowlistEntry {
    pub fn pack_into(&self, dst: &mut [u8]) {
        dst[0..1].copy_from_slice(&self.disc);
        dst[1..33].copy_from_slice(&self.pubkey);
        dst[33..41].copy_from_slice(&self.flags.to_le_bytes());
    }

    pub fn unpack_from(src: &[u8]) -> Option<Self> {
        if src.len() < ALLOWLIST_ENTRY_SIZE { return None; }
        if src[0] != ALLOWLIST_DISC[0] { return None; }
        let mut pubkey = [0u8; 32];
        pubkey.copy_from_slice(&src[1..33]);
        let mut flag_bytes = [0u8; 8];
        flag_bytes.copy_from_slice(&src[33..41]);
        Some(Self {
            disc:   ALLOWLIST_DISC,
            pubkey,
            flags:  u64::from_le_bytes(flag_bytes),
        })
    }

    /// Returns true when the agent-passport-verified bit is set.
    pub fn passport_verified(&self) -> bool {
        self.flags & FLAG_AGENT_PASSPORT_VERIFIED != 0
    }
}

// ── HookConfig ────────────────────────────────────────────────────────────────

pub struct HookConfig {
    pub disc:                    [u8; 1],
    pub admin:                   [u8; 32],
    pub hook_enabled:            bool,
    pub dark_pool_limit_atomic:  u64,
}

impl HookConfig {
    pub fn pack_into(&self, dst: &mut [u8]) {
        dst[0..1].copy_from_slice(&self.disc);
        dst[1..33].copy_from_slice(&self.admin);
        dst[33] = if self.hook_enabled { 1 } else { 0 };
        dst[34..42].copy_from_slice(&self.dark_pool_limit_atomic.to_le_bytes());
    }

    pub fn unpack_from(src: &[u8]) -> Option<Self> {
        if src.len() < HOOK_CONFIG_SIZE { return None; }
        if src[0] != CONFIG_DISC[0] { return None; }
        let mut admin = [0u8; 32];
        admin.copy_from_slice(&src[1..33]);
        let hook_enabled = src[33] != 0;
        let mut limit_bytes = [0u8; 8];
        limit_bytes.copy_from_slice(&src[34..42]);
        Some(Self {
            disc:                   CONFIG_DISC,
            admin,
            hook_enabled,
            dark_pool_limit_atomic: u64::from_le_bytes(limit_bytes),
        })
    }
}
