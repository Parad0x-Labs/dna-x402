use crate::error::AuthError;
use solana_program::program_error::ProgramError;

/// Parsed instructions for the dark-secp256k1-auth program.
pub enum AuthInstruction {
    /// Register an ETH agent: bind an Ethereum address to a Solana agent pubkey.
    ///
    /// Data (at fixed offsets):
    ///   [0]       discriminant = 0x01
    ///   [1..33]   r[32]          — ECDSA signature r component
    ///   [33..65]  s[32]          — ECDSA signature s component
    ///   [65]      recovery_id    — 0 or 1
    ///   [66..98]  msg_hash[32]   — keccak256 of the signed message
    ///   [98..130] pda_seed[32]   — last 20 bytes = eth_address
    ///   [130..162] auth_hash[32] — commitment = SHA-256(pda_seed || "commitment")
    ///   [162..194] domain_hash[32] — SHA-256(domain_utf8)
    ///
    /// Total data: 194 bytes  (discriminant + 6 fields)
    ///
    /// Accounts:
    ///   [0] record_pda    (writable)
    ///   [1] agent_signer  (signer + writable) — the Solana agent pubkey being bound
    ///   [2] system_program
    RegisterEthAgent {
        r:           [u8; 32],
        s:           [u8; 32],
        recovery_id: u8,
        msg_hash:    [u8; 32],
        pda_seed:    [u8; 32],
        auth_hash:   [u8; 32],
        domain_hash: [u8; 32],
    },

    /// Revoke an ETH agent binding by setting `is_active = false`.
    ///
    /// Data: [0x02, eth_address[20]] = 21 bytes
    ///
    /// Accounts:
    ///   [0] record_pda    (writable)
    ///   [1] agent_signer  (signer) — must match the stored agent_pubkey
    RevokeEthAgent { eth_address: [u8; 20] },
}

impl AuthInstruction {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        let (&tag, rest) = data.split_first().ok_or(AuthError::InvalidInstruction)?;
        match tag {
            0x01 => {
                // Need 193 bytes after the discriminant.
                if rest.len() < 193 {
                    return Err(AuthError::InvalidInstruction.into());
                }
                let mut r           = [0u8; 32];
                let mut s           = [0u8; 32];
                let mut msg_hash    = [0u8; 32];
                let mut pda_seed    = [0u8; 32];
                let mut auth_hash   = [0u8; 32];
                let mut domain_hash = [0u8; 32];

                r.copy_from_slice(&rest[0..32]);
                s.copy_from_slice(&rest[32..64]);
                let recovery_id = rest[64];
                msg_hash.copy_from_slice(&rest[65..97]);
                pda_seed.copy_from_slice(&rest[97..129]);
                auth_hash.copy_from_slice(&rest[129..161]);
                domain_hash.copy_from_slice(&rest[161..193]);

                Ok(Self::RegisterEthAgent {
                    r,
                    s,
                    recovery_id,
                    msg_hash,
                    pda_seed,
                    auth_hash,
                    domain_hash,
                })
            }
            0x02 => {
                if rest.len() < 20 {
                    return Err(AuthError::InvalidInstruction.into());
                }
                let mut eth_address = [0u8; 20];
                eth_address.copy_from_slice(&rest[0..20]);
                Ok(Self::RevokeEthAgent { eth_address })
            }
            _ => Err(AuthError::InvalidInstruction.into()),
        }
    }
}
