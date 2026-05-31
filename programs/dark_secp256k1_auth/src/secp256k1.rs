//! Secp256k1 precompile instruction parsing.
//!
//! Solana's secp256k1 precompile verifies ETH signatures at the transaction
//! level and recovers the signer's ETH address. If the precompile instruction
//! is present and the transaction executed successfully, every
//! (eth_address, message, signature) tuple it describes is valid.
//!
//! This module extracts the verified ETH address from the precompile's
//! instruction data so the auth program can bind it to a Solana wallet.
//!
//! Layout (one signature, self-contained):
//!   [0]      num_signatures (u8)       — must be 1
//!   [1..3]   signature_offset (u16 LE)
//!   [3]      sig_instruction_index (u8) — must = self or 0xFF
//!   [4..6]   eth_address_offset (u16 LE)
//!   [6]      addr_instruction_index (u8)
//!   [7..9]   message_data_offset (u16 LE)
//!   [9..11]  message_data_size (u16 LE)
//!   [11]     msg_instruction_index (u8)
//!   [..]     data section: signature(65B r||s||recov) | eth_address(20B) | message(variable)

use solana_program::program_error::ProgramError;
use crate::error::AuthError;

/// Length of ETH address (Keccak256(pubkey)[12..]).
pub const ETH_ADDRESS_LEN: usize = 20;
/// Length of secp256k1 signature in the precompile: r(32)||s(32)||recovery_id(1) = 65 bytes.
pub const SIG_LEN: usize = 65;

const OFFSETS_START: usize = 1;
/// secp256k1 offsets struct = [sig_off:u16][sig_ix:u8][addr_off:u16][addr_ix:u8]
///                             [msg_off:u16][msg_sz:u16][msg_ix:u8] = 11 bytes
const OFFSETS_LEN: usize = 11;
const CURRENT_IX_SENTINEL: u8 = u8::MAX;

fn read_u16_le(data: &[u8], at: usize) -> Result<u16, ProgramError> {
    let lo = data.get(at).ok_or(AuthError::MalformedPrecompile)?;
    let hi = data.get(at + 1).ok_or(AuthError::MalformedPrecompile)?;
    Ok(u16::from_le_bytes([*lo, *hi]))
}

/// The verified ETH address extracted from the precompile instruction.
pub struct Secp256k1Verified {
    pub eth_address: [u8; ETH_ADDRESS_LEN],
}

/// Parse a self-contained secp256k1 precompile instruction with exactly one
/// signature. Returns the verified ETH address (the one the precompile proved
/// signed the message).
pub fn parse_single_verified(
    data: &[u8],
    self_index: u16,
) -> Result<Secp256k1Verified, ProgramError> {
    if data.len() < OFFSETS_START + OFFSETS_LEN {
        return Err(AuthError::MalformedPrecompile.into());
    }

    // Must be exactly 1 signature for an unambiguous binding
    if data[0] != 1 {
        return Err(AuthError::MalformedPrecompile.into());
    }

    // Parse 11-byte offsets struct: u16/u8/u16/u8/u16/u16/u8
    let o = OFFSETS_START;
    let sig_off  = read_u16_le(data, o)? as usize;
    let sig_ix   = *data.get(o + 2).ok_or(AuthError::MalformedPrecompile)?;
    let addr_off = read_u16_le(data, o + 3)? as usize;
    let addr_ix  = *data.get(o + 5).ok_or(AuthError::MalformedPrecompile)?;
    let _msg_off = read_u16_le(data, o + 6)?;
    let _msg_sz  = read_u16_le(data, o + 8)?;
    let msg_ix   = *data.get(o + 10).ok_or(AuthError::MalformedPrecompile)?;

    let self_ix_u8 = self_index as u8;
    let references_self = |ix: u8| ix == self_ix_u8 || ix == CURRENT_IX_SENTINEL;
    if !references_self(sig_ix) || !references_self(addr_ix) || !references_self(msg_ix) {
        return Err(AuthError::MalformedPrecompile.into());
    }

    // Validate signature is present (not returned — precompile already verified it)
    data.get(sig_off..sig_off + SIG_LEN)
        .ok_or(AuthError::MalformedPrecompile)?;

    // Extract the ETH address (20 bytes)
    let addr_slice = data.get(addr_off..addr_off + ETH_ADDRESS_LEN)
        .ok_or(AuthError::MalformedPrecompile)?;

    let mut eth_address = [0u8; ETH_ADDRESS_LEN];
    eth_address.copy_from_slice(addr_slice);

    Ok(Secp256k1Verified { eth_address })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_buf(eth_addr: &[u8; 20], sig: &[u8; 65], msg: &[u8], ix: u8) -> Vec<u8> {
        // secp256k1 offsets: [sig_off:u16][sig_ix:u8][addr_off:u16][addr_ix:u8][msg_off:u16][msg_sz:u16][msg_ix:u8]
        let sig_off  = 12usize; // 1 + 11
        let addr_off = sig_off + 65;
        let msg_off  = addr_off + 20;

        let mut d = Vec::new();
        d.push(1u8); // num_signatures
        d.extend_from_slice(&(sig_off as u16).to_le_bytes()); // sig_off u16
        d.push(ix);                                            // sig_ix u8
        d.extend_from_slice(&(addr_off as u16).to_le_bytes()); // addr_off u16
        d.push(ix);                                            // addr_ix u8
        d.extend_from_slice(&(msg_off as u16).to_le_bytes()); // msg_off u16
        d.extend_from_slice(&(msg.len() as u16).to_le_bytes()); // msg_sz u16
        d.push(ix);                                            // msg_ix u8
        // data section
        d.extend_from_slice(sig);
        d.extend_from_slice(eth_addr);
        d.extend_from_slice(msg);
        d
    }

    #[test]
    fn parses_eth_address_correctly() {
        let addr = [0xABu8; 20];
        let sig  = [0x11u8; 65];
        let msg  = [0x22u8; 32];
        let buf  = build_buf(&addr, &sig, &msg, 0);
        let v = parse_single_verified(&buf, 0).expect("must parse");
        assert_eq!(v.eth_address, addr);
    }

    #[test]
    fn accepts_sentinel_ix_index() {
        let addr = [0x01u8; 20];
        let buf  = build_buf(&addr, &[0u8; 65], &[0u8; 4], u8::MAX);
        let v = parse_single_verified(&buf, 0).expect("sentinel must parse");
        assert_eq!(v.eth_address, addr);
    }

    #[test]
    fn rejects_cross_instruction_reference() {
        let buf = build_buf(&[0u8; 20], &[0u8; 65], &[0u8; 4], 5);
        assert!(parse_single_verified(&buf, 0).is_err());
    }

    #[test]
    fn rejects_multi_signature() {
        let mut buf = build_buf(&[0u8; 20], &[0u8; 65], &[0u8; 4], 0);
        buf[0] = 2;
        assert!(parse_single_verified(&buf, 0).is_err());
    }

    #[test]
    fn rejects_truncated_buffer() {
        assert!(parse_single_verified(&[1u8, 0u8, 0u8], 0).is_err());
    }
}
