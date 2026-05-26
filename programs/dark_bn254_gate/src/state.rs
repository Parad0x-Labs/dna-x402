/// On-chain verification record stored in the gate PDA.
///
/// Layout (81 bytes):
///   [0..32]  merkle_root
///   [32..64] nullifier
///   [64..72] amount         (u64 le)
///   [72..80] verified_at_slot (u64 le)
///   [80]     is_verified    (u8 bool)
#[derive(Debug, Clone)]
pub struct VerificationRecord {
    pub merkle_root: [u8; 32],
    pub nullifier: [u8; 32],
    pub amount: u64,
    pub verified_at_slot: u64,
    pub is_verified: bool,
}

pub const GATE_RECORD_SIZE: usize = 32 + 32 + 8 + 8 + 1; // 81 bytes
