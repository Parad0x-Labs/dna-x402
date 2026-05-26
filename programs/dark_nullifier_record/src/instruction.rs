/// Instruction discriminator for [`RecordNullifier`].
pub const RECORD_NULLIFIER_DISCRIMINATOR: u8 = 0x00;

/// Total byte length of a `RecordNullifier` instruction payload.
/// 1 (discriminator) + 32 (nullifier) = 33
pub const RECORD_NULLIFIER_IX_LEN: usize = 33;

/// Build the 33-byte instruction data for a `RecordNullifier` call.
///
/// Layout: `[0x00]` ++ `nullifier[0..32]`
pub fn record_nullifier_ix_data(nullifier: [u8; 32]) -> Vec<u8> {
    let mut data = Vec::with_capacity(RECORD_NULLIFIER_IX_LEN);
    data.push(RECORD_NULLIFIER_DISCRIMINATOR);
    data.extend_from_slice(&nullifier);
    data
}

/// Parse a `RecordNullifier` instruction payload.
///
/// Returns the 32-byte nullifier on success, or `None` if:
/// - `data` is not exactly 33 bytes, or
/// - the leading discriminator is not `0x00`.
pub fn parse_record_nullifier(data: &[u8]) -> Option<[u8; 32]> {
    if data.len() != RECORD_NULLIFIER_IX_LEN {
        return None;
    }
    if data[0] != RECORD_NULLIFIER_DISCRIMINATOR {
        return None;
    }
    let mut nullifier = [0u8; 32];
    nullifier.copy_from_slice(&data[1..33]);
    Some(nullifier)
}
