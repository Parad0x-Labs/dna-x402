/// VaultRecord PDA — seeds: [b"passkey-vault", wallet_pubkey[32], credential_id_hash[32]]
///
/// Stores the binding between a WebAuthn/passkey credential and a Solana agent pubkey.
/// The PDA seeds include the credential ID hash so one wallet can hold multiple vaults
/// (one per registered passkey device).
///
/// Layout:
///   disc[1]               = 0xCC
///   wallet_pubkey[32]     — the Solana wallet that owns this vault
///   credential_id_hash[32] — SHA-256 of the WebAuthn credential ID
///   agent_pubkey[32]      — the Solana agent key bound to this passkey
///   challenge_hash[32]    — hash of the last accepted challenge (replay prevention)
///   registered_at[8]      — u64 slot number when the vault was created
///   version[1]            — schema version = 1
///
/// Size: 1 + 32 + 32 + 32 + 32 + 8 + 1 = 138 bytes
pub const VAULT_RECORD_SIZE: usize = 138;
pub const VAULT_DISC: [u8; 1] = [0xCC];
pub const VAULT_VERSION: u8 = 1;

// Field byte-offsets within the packed buffer (for clarity).
pub const OFF_DISC:               usize = 0;    // [0..1]
pub const OFF_WALLET_PUBKEY:      usize = 1;    // [1..33]
pub const OFF_CREDENTIAL_ID_HASH: usize = 33;   // [33..65]
pub const OFF_AGENT_PUBKEY:       usize = 65;   // [65..97]
pub const OFF_CHALLENGE_HASH:     usize = 97;   // [97..129]
pub const OFF_REGISTERED_AT:      usize = 129;  // [129..137]
pub const OFF_VERSION:            usize = 137;  // [137..138]

pub struct VaultRecord {
    pub disc:               [u8; 1],
    pub wallet_pubkey:      [u8; 32],
    pub credential_id_hash: [u8; 32],
    pub agent_pubkey:       [u8; 32],
    pub challenge_hash:     [u8; 32],
    pub registered_at:      u64,
    pub version:            u8,
}

impl VaultRecord {
    pub fn pack_into(&self, dst: &mut [u8]) {
        dst[OFF_DISC..OFF_DISC + 1].copy_from_slice(&self.disc);
        dst[OFF_WALLET_PUBKEY..OFF_WALLET_PUBKEY + 32].copy_from_slice(&self.wallet_pubkey);
        dst[OFF_CREDENTIAL_ID_HASH..OFF_CREDENTIAL_ID_HASH + 32].copy_from_slice(&self.credential_id_hash);
        dst[OFF_AGENT_PUBKEY..OFF_AGENT_PUBKEY + 32].copy_from_slice(&self.agent_pubkey);
        dst[OFF_CHALLENGE_HASH..OFF_CHALLENGE_HASH + 32].copy_from_slice(&self.challenge_hash);
        dst[OFF_REGISTERED_AT..OFF_REGISTERED_AT + 8].copy_from_slice(&self.registered_at.to_le_bytes());
        dst[OFF_VERSION] = self.version;
    }

    pub fn unpack_from(src: &[u8]) -> Option<Self> {
        if src.len() < VAULT_RECORD_SIZE { return None; }
        if src[OFF_DISC] != VAULT_DISC[0] { return None; }

        let mut wallet_pubkey      = [0u8; 32];
        let mut credential_id_hash = [0u8; 32];
        let mut agent_pubkey       = [0u8; 32];
        let mut challenge_hash     = [0u8; 32];
        let mut slot_bytes         = [0u8; 8];

        wallet_pubkey.copy_from_slice(&src[OFF_WALLET_PUBKEY..OFF_WALLET_PUBKEY + 32]);
        credential_id_hash.copy_from_slice(&src[OFF_CREDENTIAL_ID_HASH..OFF_CREDENTIAL_ID_HASH + 32]);
        agent_pubkey.copy_from_slice(&src[OFF_AGENT_PUBKEY..OFF_AGENT_PUBKEY + 32]);
        challenge_hash.copy_from_slice(&src[OFF_CHALLENGE_HASH..OFF_CHALLENGE_HASH + 32]);
        slot_bytes.copy_from_slice(&src[OFF_REGISTERED_AT..OFF_REGISTERED_AT + 8]);

        Some(Self {
            disc:               VAULT_DISC,
            wallet_pubkey,
            credential_id_hash,
            agent_pubkey,
            challenge_hash,
            registered_at:      u64::from_le_bytes(slot_bytes),
            version:            src[OFF_VERSION],
        })
    }
}
