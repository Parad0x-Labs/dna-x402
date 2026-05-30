//! secp256r1 (SIMD-0075) precompile instruction parsing.
//!
//! Solana's secp256r1 precompile verifies P-256 signatures at the transaction
//! level: if the precompile instruction is present and the transaction executed
//! successfully, every (pubkey, message, signature) tuple it describes is
//! cryptographically valid. This module extracts the verified pubkey + message
//! from that instruction's data so the vault can bind them to a vault record.
//!
//! It does NOT re-verify the signature (the runtime already did, and a BPF
//! program cannot run the P-256 pairing cheaply); it strictly parses the
//! precompile's own data layout with full bounds + self-reference checks.
//!
//! Layout (one signature, self-contained), matching the Agave secp256r1
//! precompile builder:
//!   [0]      num_signatures (u8)          — must be 1 in v1
//!   [1]      padding (u8)
//!   [2..16]  Secp256r1SignatureOffsets (7 × u16 LE):
//!              signature_offset, signature_instruction_index,
//!              public_key_offset, public_key_instruction_index,
//!              message_data_offset, message_data_size, message_instruction_index
//!   [..]     referenced bytes: compressed pubkey (33B), signature (64B), message
//!
//! Every `*_instruction_index` must reference THIS instruction (`self_index`) or
//! the `u16::MAX` "current instruction" sentinel. Cross-instruction references
//! are rejected in v1 so the verified tuple cannot be sourced from an unrelated
//! instruction's data.

use solana_program::program_error::ProgramError;

use crate::error::VaultError;

/// Compressed P-256 public key length (1 parity byte + 32-byte X).
pub const PUBKEY_LEN: usize = 33;
/// Raw P-256 signature length (r ‖ s, 32 bytes each).
pub const SIGNATURE_LEN: usize = 64;

const OFFSETS_START: usize = 2;
const OFFSETS_LEN: usize = 14;
const CURRENT_IX_SENTINEL: u16 = u16::MAX;

/// The verified tuple the precompile attests to.
pub struct Secp256r1Verified<'a> {
    pub pubkey_compressed: [u8; PUBKEY_LEN],
    pub message: &'a [u8],
}

#[inline]
fn read_u16_le(b: &[u8], at: usize) -> Result<u16, ProgramError> {
    let hi = b.get(at + 1).ok_or(VaultError::MalformedPrecompile)?;
    let lo = b.get(at).ok_or(VaultError::MalformedPrecompile)?;
    Ok(u16::from_le_bytes([*lo, *hi]))
}

/// Parse a self-contained secp256r1 precompile instruction carrying exactly one
/// signature. Returns the verified compressed pubkey and the signed message.
pub fn parse_single_verified(
    data: &[u8],
    self_index: u16,
) -> Result<Secp256r1Verified<'_>, ProgramError> {
    if data.len() < OFFSETS_START + OFFSETS_LEN {
        return Err(VaultError::MalformedPrecompile.into());
    }
    // v1 binds exactly one signature so the (pubkey, message) tuple is unambiguous.
    if data[0] != 1 {
        return Err(VaultError::MalformedPrecompile.into());
    }

    let o = OFFSETS_START;
    let sig_off  = read_u16_le(data, o)? as usize;
    let sig_ix   = read_u16_le(data, o + 2)?;
    let pk_off   = read_u16_le(data, o + 4)? as usize;
    let pk_ix    = read_u16_le(data, o + 6)?;
    let msg_off  = read_u16_le(data, o + 8)? as usize;
    let msg_size = read_u16_le(data, o + 10)? as usize;
    let msg_ix   = read_u16_le(data, o + 12)?;

    let references_self = |ix: u16| ix == self_index || ix == CURRENT_IX_SENTINEL;
    if !references_self(sig_ix) || !references_self(pk_ix) || !references_self(msg_ix) {
        return Err(VaultError::MalformedPrecompile.into());
    }

    // Bounds-checked extraction. The signature slice is validated for presence
    // (the runtime verified it) but not returned.
    let pk_slice = data
        .get(pk_off..pk_off + PUBKEY_LEN)
        .ok_or(VaultError::MalformedPrecompile)?;
    let _sig = data
        .get(sig_off..sig_off + SIGNATURE_LEN)
        .ok_or(VaultError::MalformedPrecompile)?;
    let message = data
        .get(msg_off..msg_off + msg_size)
        .ok_or(VaultError::MalformedPrecompile)?;

    let mut pubkey_compressed = [0u8; PUBKEY_LEN];
    pubkey_compressed.copy_from_slice(pk_slice);

    Ok(Secp256r1Verified { pubkey_compressed, message })
}

/// Compute the 33-byte compressed P-256 pubkey from big-endian X, Y coordinates.
/// Parity prefix: 0x02 if Y is even, 0x03 if Y is odd.
pub fn compress_xy(x: &[u8; 32], y: &[u8; 32]) -> [u8; PUBKEY_LEN] {
    let mut out = [0u8; PUBKEY_LEN];
    out[0] = if y[31] & 1 == 0 { 0x02 } else { 0x03 };
    out[1..].copy_from_slice(x);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a canonical one-signature secp256r1 precompile data buffer:
    /// [num=1][pad=0][offsets:14][pubkey:33][signature:64][message:N]
    fn build_buf(pubkey: &[u8; 33], sig: &[u8; 64], msg: &[u8], self_ix: u16) -> Vec<u8> {
        let header = 2usize;
        let offsets = 14usize;
        let pk_off = header + offsets; // 16
        let sig_off = pk_off + 33; // 49
        let msg_off = sig_off + 64; // 113

        let mut d = Vec::new();
        d.push(1u8); // num_signatures
        d.push(0u8); // padding
        // offsets (7 × u16 LE)
        d.extend_from_slice(&(sig_off as u16).to_le_bytes());
        d.extend_from_slice(&self_ix.to_le_bytes());
        d.extend_from_slice(&(pk_off as u16).to_le_bytes());
        d.extend_from_slice(&self_ix.to_le_bytes());
        d.extend_from_slice(&(msg_off as u16).to_le_bytes());
        d.extend_from_slice(&(msg.len() as u16).to_le_bytes());
        d.extend_from_slice(&self_ix.to_le_bytes());
        // data section
        d.extend_from_slice(pubkey);
        d.extend_from_slice(sig);
        d.extend_from_slice(msg);
        d
    }

    #[test]
    fn parses_canonical_buffer() {
        let mut pk = [0u8; 33];
        pk[0] = 0x02;
        for i in 1..33 { pk[i] = i as u8; }
        let sig = [0x7u8; 64];
        let msg = [0xABu8; 32];

        let buf = build_buf(&pk, &sig, &msg, 0);
        let v = parse_single_verified(&buf, 0).expect("must parse");
        assert_eq!(v.pubkey_compressed, pk);
        assert_eq!(v.message, &msg);
    }

    #[test]
    fn accepts_current_ix_sentinel() {
        let pk = [0x03u8; 33];
        let sig = [0u8; 64];
        let msg = [0x11u8; 32];
        let buf = build_buf(&pk, &sig, &msg, u16::MAX);
        let v = parse_single_verified(&buf, 0).expect("sentinel must parse");
        assert_eq!(v.pubkey_compressed, pk);
    }

    #[test]
    fn rejects_cross_instruction_reference() {
        let pk = [0x02u8; 33];
        let sig = [0u8; 64];
        let msg = [0x22u8; 8];
        // offsets reference instruction index 5, but we parse as self_index 0
        let buf = build_buf(&pk, &sig, &msg, 5);
        assert!(parse_single_verified(&buf, 0).is_err());
    }

    #[test]
    fn rejects_multi_signature() {
        let pk = [0x02u8; 33];
        let sig = [0u8; 64];
        let msg = [0x33u8; 4];
        let mut buf = build_buf(&pk, &sig, &msg, 0);
        buf[0] = 2; // claim two signatures
        assert!(parse_single_verified(&buf, 0).is_err());
    }

    #[test]
    fn rejects_truncated_buffer() {
        assert!(parse_single_verified(&[1u8, 0u8, 0u8], 0).is_err());
    }

    #[test]
    fn rejects_out_of_bounds_offsets() {
        let pk = [0x02u8; 33];
        let sig = [0u8; 64];
        let msg = [0x44u8; 16];
        let mut buf = build_buf(&pk, &sig, &msg, 0);
        // corrupt the pubkey offset (bytes 6..8) to point past the end
        buf[6] = 0xFF;
        buf[7] = 0xFF;
        assert!(parse_single_verified(&buf, 0).is_err());
    }

    #[test]
    fn compress_xy_parity() {
        let x = [0x09u8; 32];
        let mut y_even = [0u8; 32];
        y_even[31] = 0x04; // even
        let mut y_odd = [0u8; 32];
        y_odd[31] = 0x05; // odd
        assert_eq!(compress_xy(&x, &y_even)[0], 0x02);
        assert_eq!(compress_xy(&x, &y_odd)[0], 0x03);
        assert_eq!(&compress_xy(&x, &y_even)[1..], &x);
    }
}
