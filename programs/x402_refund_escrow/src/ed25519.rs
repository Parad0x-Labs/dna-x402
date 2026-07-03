//! Parse the native ed25519 precompile instruction and recover the
//! `(pubkey, message)` it cryptographically verified.
//!
//! The precompile guarantees the private-key owner signed the message; this
//! module only reads the result back. It is deliberately pure (`&[u8]` in,
//! result out) so the offset math is unit-testable without a runtime.
//!
//! Layout (solana ed25519 program): `[count:u8][pad:u8]` then `count`
//! `Ed25519SignatureOffsets` records of 14 bytes:
//!   signature_offset u16, signature_instruction_index u16,
//!   public_key_offset u16, public_key_instruction_index u16,
//!   message_data_offset u16, message_data_size u16, message_instruction_index u16

use crate::error::EscrowError;

const OFFSETS_START: usize = 2;
const OFFSETS_LEN: usize = 14;

/// Recover `(pubkey, message)` for signature `sig_index` in an ed25519
/// precompile instruction's data.
///
/// Rejects any record whose bytes reference a *different* instruction
/// (`instruction_index != u16::MAX`). Without this, a caller could point the
/// precompile at some other instruction's key while leaving the seller's key
/// as inert bytes here — we would read a key the precompile never verified.
/// Requiring the self-contained form pins "verified" to exactly what we read.
pub fn extract_pubkey_and_message(
    data: &[u8],
    sig_index: usize,
) -> Result<([u8; 32], Vec<u8>), EscrowError> {
    let err = EscrowError::InvalidReceiptSignature;
    if data.len() < OFFSETS_START {
        return Err(err);
    }
    let num_sigs = data[0] as usize;
    if sig_index >= num_sigs {
        return Err(err);
    }
    let base = OFFSETS_START + sig_index * OFFSETS_LEN;
    if data.len() < base + OFFSETS_LEN {
        return Err(err);
    }
    let rd = |o: usize| u16::from_le_bytes([data[o], data[o + 1]]);
    let sig_ii = rd(base + 2);
    let pk_off = rd(base + 4) as usize;
    let pk_ii = rd(base + 6);
    let msg_off = rd(base + 8) as usize;
    let msg_sz = rd(base + 10) as usize;
    let msg_ii = rd(base + 12);

    if sig_ii != u16::MAX || pk_ii != u16::MAX || msg_ii != u16::MAX {
        return Err(err);
    }
    if pk_off.saturating_add(32) > data.len() {
        return Err(err);
    }
    if msg_off.saturating_add(msg_sz) > data.len() {
        return Err(err);
    }

    let mut pubkey = [0u8; 32];
    pubkey.copy_from_slice(&data[pk_off..pk_off + 32]);
    let message = data[msg_off..msg_off + msg_sz].to_vec();
    Ok((pubkey, message))
}
