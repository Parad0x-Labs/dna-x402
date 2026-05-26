/// On-chain nullifier record stored in the PDA.
///
/// Layout (41 bytes):
///   [0]       bump            (u8)
///   [1..33]   nullifier       ([u8; 32])
///   [33..41]  recorded_at_slot (u64 le)
#[derive(Debug, Clone)]
pub struct NullifierRecord {
    pub bump: u8,
    pub nullifier: [u8; 32],
    pub recorded_at_slot: u64,
}

/// Total byte length of a serialised [`NullifierRecord`].
/// 1 (bump) + 32 (nullifier) + 8 (recorded_at_slot) = 41
pub const NULLIFIER_RECORD_SIZE: usize = 41;

impl NullifierRecord {
    /// Deserialise a [`NullifierRecord`] from a raw byte slice.
    /// Returns `None` if `data` is shorter than [`NULLIFIER_RECORD_SIZE`].
    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        if data.len() < NULLIFIER_RECORD_SIZE {
            return None;
        }
        let bump = data[0];
        let mut nullifier = [0u8; 32];
        nullifier.copy_from_slice(&data[1..33]);
        let recorded_at_slot = u64::from_le_bytes(data[33..41].try_into().ok()?);
        Some(Self {
            bump,
            nullifier,
            recorded_at_slot,
        })
    }

    /// Serialise into a fixed-size byte array.
    pub fn to_bytes(&self) -> [u8; NULLIFIER_RECORD_SIZE] {
        let mut out = [0u8; NULLIFIER_RECORD_SIZE];
        out[0] = self.bump;
        out[1..33].copy_from_slice(&self.nullifier);
        out[33..41].copy_from_slice(&self.recorded_at_slot.to_le_bytes());
        out
    }

    /// Returns `true` when `data` is exactly [`NULLIFIER_RECORD_SIZE`] bytes
    /// and at least one byte is non-zero — i.e. a live record is present.
    pub fn is_recorded(data: &[u8]) -> bool {
        if data.len() != NULLIFIER_RECORD_SIZE {
            return false;
        }
        data.iter().any(|&b| b != 0)
    }
}
