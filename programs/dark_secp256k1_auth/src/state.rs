/// EthAgentRecord PDA — seeds: [b"eth-agent", eth_address[20]]
///
/// Stores the binding between an Ethereum address and a Solana agent public key.
/// The ETH address (20 bytes) comes from the client-supplied `pda_seed` field
/// (specifically `pda_seed[12..32]`, the last 20 bytes — matching the Ethereum
/// convention of taking the last 20 bytes of keccak256(pubkey)).
///
/// Layout:
///   disc[1]           = 0xDD
///   eth_address[20]   — 20-byte Ethereum address
///   agent_pubkey[32]  — Solana agent public key bound to this ETH address
///   auth_hash[32]     — commitment = SHA-256(pda_seed + "commitment")
///   domain_hash[32]   — SHA-256(domain_utf8) — domain-scoped binding
///   registered_at[8]  — u64 slot number when the record was created
///   is_active[1]      — 1 = active, 0 = revoked
///
/// Size: 1 + 20 + 32 + 32 + 32 + 8 + 1 = 126 bytes
pub const ETH_AGENT_RECORD_SIZE: usize = 126;
pub const ETH_AGENT_DISC: [u8; 1] = [0xDD];

// Field byte-offsets within the packed buffer.
pub const OFF_DISC:          usize = 0;   // [0..1]
pub const OFF_ETH_ADDRESS:   usize = 1;   // [1..21]
pub const OFF_AGENT_PUBKEY:  usize = 21;  // [21..53]
pub const OFF_AUTH_HASH:     usize = 53;  // [53..85]
pub const OFF_DOMAIN_HASH:   usize = 85;  // [85..117]
pub const OFF_REGISTERED_AT: usize = 117; // [117..125]
pub const OFF_IS_ACTIVE:     usize = 125; // [125..126]

pub struct EthAgentRecord {
    pub disc:          [u8; 1],
    pub eth_address:   [u8; 20],
    pub agent_pubkey:  [u8; 32],
    pub auth_hash:     [u8; 32],
    pub domain_hash:   [u8; 32],
    pub registered_at: u64,
    pub is_active:     bool,
}

impl EthAgentRecord {
    pub fn pack_into(&self, dst: &mut [u8]) {
        dst[OFF_DISC..OFF_DISC + 1].copy_from_slice(&self.disc);
        dst[OFF_ETH_ADDRESS..OFF_ETH_ADDRESS + 20].copy_from_slice(&self.eth_address);
        dst[OFF_AGENT_PUBKEY..OFF_AGENT_PUBKEY + 32].copy_from_slice(&self.agent_pubkey);
        dst[OFF_AUTH_HASH..OFF_AUTH_HASH + 32].copy_from_slice(&self.auth_hash);
        dst[OFF_DOMAIN_HASH..OFF_DOMAIN_HASH + 32].copy_from_slice(&self.domain_hash);
        dst[OFF_REGISTERED_AT..OFF_REGISTERED_AT + 8].copy_from_slice(&self.registered_at.to_le_bytes());
        dst[OFF_IS_ACTIVE] = if self.is_active { 1 } else { 0 };
    }

    pub fn unpack_from(src: &[u8]) -> Option<Self> {
        if src.len() < ETH_AGENT_RECORD_SIZE { return None; }
        if src[OFF_DISC] != ETH_AGENT_DISC[0] { return None; }

        let mut eth_address  = [0u8; 20];
        let mut agent_pubkey = [0u8; 32];
        let mut auth_hash    = [0u8; 32];
        let mut domain_hash  = [0u8; 32];
        let mut slot_bytes   = [0u8; 8];

        eth_address.copy_from_slice(&src[OFF_ETH_ADDRESS..OFF_ETH_ADDRESS + 20]);
        agent_pubkey.copy_from_slice(&src[OFF_AGENT_PUBKEY..OFF_AGENT_PUBKEY + 32]);
        auth_hash.copy_from_slice(&src[OFF_AUTH_HASH..OFF_AUTH_HASH + 32]);
        domain_hash.copy_from_slice(&src[OFF_DOMAIN_HASH..OFF_DOMAIN_HASH + 32]);
        slot_bytes.copy_from_slice(&src[OFF_REGISTERED_AT..OFF_REGISTERED_AT + 8]);

        Some(Self {
            disc:          ETH_AGENT_DISC,
            eth_address,
            agent_pubkey,
            auth_hash,
            domain_hash,
            registered_at: u64::from_le_bytes(slot_bytes),
            is_active:     src[OFF_IS_ACTIVE] != 0,
        })
    }
}
