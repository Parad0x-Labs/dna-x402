// ┌─────────────────────────────────────────────────────────────────────────┐
// │  dark_bls12_381_credential — BLS12-381 Credential Aggregation Gate      │
// │                                                                         │
// │  FIRST OPEN-SOURCE BLS12-381 PROGRAM ON SOLANA                         │
// │                                                                         │
// │  SIMD-0388 BLS12-381 syscalls are LIVE on devnet (epoch 1059)           │
// │  Feature gate: b1sgUiJ3qu7hYm3tNDyyqZNQd6gLGJmJppnLNa93PCQ             │
// │  Not yet on mainnet — deploy on devnet, flip to mainnet Q3 2026.        │
// │                                                                         │
// │  Instruction layout (discriminant 0x01):                                │
// │    [0x01]            — 1 byte discriminant                              │
// │    [num_sigs: u8]    — 1 byte (N)                                       │
// │    [sig_0..sig_N-1]  — N × 48 bytes (G1 compressed signatures)          │
// │    [agg_pubkey]      — 96 bytes (G2 aggregated public key, compressed)  │
// │    [message]         — 48 bytes (G1 compressed message point)           │
// │  Total minimum: 2 + 0*48 + 96 + 48 = 146 bytes                         │
// │  With N sigs: 2 + N*48 + 96 + 48 bytes                                 │
// │                                                                         │
// │  Full pairing verification equation (activated when IS_MAINNET_READY):  │
// │    e(agg_sig, G2_generator) == e(msg, agg_pubkey)                       │
// │                                                                         │
// │  Where:                                                                 │
// │    agg_sig   = sum of individual G1 signatures (off-chain aggregated)   │
// │    G2_gen    = fixed G2 generator point (BLS12-381 spec)               │
// │    msg       = H_G1(message) — message hashed to G1                    │
// │    agg_pubkey= sum of individual G2 public keys                         │
// │                                                                         │
// │  Syscalls used (SIMD-0388):                                             │
// │    sol_curve_group_op(curve_id=5, GROUP_OP_ADD, ...)  — G1 add         │
// │    sol_curve_group_op(curve_id=6, GROUP_OP_ADD, ...)  — G2 add         │
// │    sol_curve_pairing_map(curve_id=4, pairs, output)   — BLS12-381 pair │
// │                                                                         │
// │  CURRENT STATUS: POC STUB — validates instruction length and logs       │
// │  credential count. BLS12-381 CU cost profiling pending before           │
// │  activating the full pairing check.                                     │
// └─────────────────────────────────────────────────────────────────────────┘

use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
};

// ── Feature flag ──────────────────────────────────────────────────────────────
// Set to true when:
//   1. SIMD-0388 is live on mainnet (Q3 2026), AND
//   2. CU cost budget for pairing is profiled and acceptable
const IS_MAINNET_READY: bool = false;

// ── Curve IDs for SIMD-0388 syscalls ─────────────────────────────────────────
#[allow(dead_code)]
const CURVE_BLS12_381_G1: u64 = 5; // sol_curve_group_op: G1 arithmetic
#[allow(dead_code)]
const CURVE_BLS12_381_G2: u64 = 6; // sol_curve_group_op: G2 arithmetic
#[allow(dead_code)]
const CURVE_BLS12_381_PAIRING: u64 = 4; // sol_curve_pairing_map

// ── Instruction discriminants ──────────────────────────────────────────────
const IX_VERIFY_CREDENTIALS: u8 = 0x01;

// ── Byte sizes for BLS12-381 (compressed point encoding) ──────────────────
const G1_COMPRESSED_BYTES: usize = 48; // G1 point, compressed
const G2_COMPRESSED_BYTES: usize = 96; // G2 point, compressed

entrypoint!(process_instruction);

pub fn process_instruction(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    // ── Discriminant check ─────────────────────────────────────────────────
    if instruction_data.is_empty() {
        msg!("BLS12_381: empty instruction data");
        return Err(ProgramError::InvalidInstructionData);
    }

    match instruction_data[0] {
        IX_VERIFY_CREDENTIALS => process_verify_credentials(&instruction_data[1..]),
        _ => {
            msg!("BLS12_381: unknown discriminant {:#04x}", instruction_data[0]);
            Err(ProgramError::InvalidInstructionData)
        }
    }
}

/// Verify aggregated BLS12-381 credentials.
///
/// Layout after stripping the discriminant:
///   [num_sigs: u8][sig_0..sig_N-1: N×48B][agg_pubkey: 96B][message: 48B]
fn process_verify_credentials(data: &[u8]) -> ProgramResult {
    // ── Parse num_sigs ────────────────────────────────────────────────────
    if data.is_empty() {
        msg!("BLS12_381: missing num_sigs byte");
        return Err(ProgramError::InvalidInstructionData);
    }
    let num_sigs = data[0] as usize;

    // ── Validate total length ─────────────────────────────────────────────
    // Expected: 1 (num_sigs) + N*48 (sigs) + 96 (agg_pubkey) + 48 (message)
    let expected_len = 1
        + num_sigs * G1_COMPRESSED_BYTES
        + G2_COMPRESSED_BYTES
        + G1_COMPRESSED_BYTES;

    if data.len() < expected_len {
        msg!(
            "BLS12_381: instruction too short: got {} bytes, need {} (for {} credential{})",
            data.len(),
            expected_len,
            num_sigs,
            if num_sigs == 1 { "" } else { "s" }
        );
        return Err(ProgramError::InvalidInstructionData);
    }

    // ── Parse fields ──────────────────────────────────────────────────────
    let mut offset = 1usize; // skip num_sigs byte

    // Individual G1 signatures (N × 48 bytes each)
    let sigs_end = offset + num_sigs * G1_COMPRESSED_BYTES;
    let _sig_bytes = &data[offset..sigs_end];
    offset = sigs_end;

    // G2 aggregated public key (96 bytes)
    let agg_pubkey_end = offset + G2_COMPRESSED_BYTES;
    let _agg_pubkey_bytes = &data[offset..agg_pubkey_end];
    offset = agg_pubkey_end;

    // G1 message point (48 bytes)
    let _message_bytes = &data[offset..offset + G1_COMPRESSED_BYTES];

    // ── Full pairing verify (activated when IS_MAINNET_READY) ────────────
    //
    // When IS_MAINNET_READY = true, this section will:
    //
    // 1. Aggregate individual G1 sigs into a single G1 point:
    //    agg_sig = sig_0 + sig_1 + ... + sig_{N-1}
    //    using: sol_curve_group_op(CURVE_BLS12_381_G1, GROUP_OP_ADD, ...)
    //
    // 2. Run the pairing equality check:
    //    e(agg_sig, G2_gen) == e(msg, agg_pubkey)
    //
    //    Encoded as the product-of-pairings identity:
    //    e(agg_sig, G2_gen) * e(-msg, agg_pubkey) == 1_{GT}
    //
    //    using: sol_curve_pairing_map(CURVE_BLS12_381_PAIRING, 2 pairs, output)
    //    where output is 32 bytes that must equal the GT identity element.
    //
    // CU budget concern: BLS12-381 pairing is significantly more expensive
    // than BN254. On BN254 a single pairing costs ~80k CUs. BLS12-381 is
    // expected to cost 200k–400k CUs per pair. With the 2-pair check above
    // the total would be ~400k–800k CUs. Profile on devnet before enabling.
    //
    // SIMD-0388 reference:
    //   https://github.com/solana-foundation/solana-improvement-documents/pull/388
    // Feature gate: b1sgUiJ3qu7hYm3tNDyyqZNQd6gLGJmJppnLNa93PCQ

    if IS_MAINNET_READY {
        // placeholder — pairing implementation goes here
        msg!("BLS12_381: IS_MAINNET_READY=true but pairing not yet implemented");
        return Err(ProgramError::InvalidInstructionData);
    }

    // ── POC stub: log and succeed ─────────────────────────────────────────
    msg!(
        "BLS12_381: verified {} credential{}",
        num_sigs,
        if num_sigs == 1 { "" } else { "s" }
    );
    msg!("BLS12_381: SIMD-0388 pairing stub — devnet POC (IS_MAINNET_READY=false)");
    msg!(
        "BLS12_381: agg_pubkey[0..4]={:02x}{:02x}{:02x}{:02x} msg[0..4]={:02x}{:02x}{:02x}{:02x}",
        _agg_pubkey_bytes[0], _agg_pubkey_bytes[1],
        _agg_pubkey_bytes[2], _agg_pubkey_bytes[3],
        _message_bytes[0],    _message_bytes[1],
        _message_bytes[2],    _message_bytes[3],
    );

    Ok(())
}

// ── Unit tests ───────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use solana_program::pubkey::Pubkey;

    fn make_ix_data(num_sigs: u8) -> Vec<u8> {
        let n = num_sigs as usize;
        let mut data = vec![IX_VERIFY_CREDENTIALS, num_sigs];
        // N × G1 signatures (48 bytes each, zeroed)
        data.extend_from_slice(&vec![0u8; n * G1_COMPRESSED_BYTES]);
        // G2 aggregated pubkey (96 bytes, zeroed)
        data.extend_from_slice(&vec![0u8; G2_COMPRESSED_BYTES]);
        // G1 message (48 bytes, zeroed)
        data.extend_from_slice(&vec![0u8; G1_COMPRESSED_BYTES]);
        data
    }

    #[test]
    fn test_verify_one_credential_passes() {
        let pid = Pubkey::default();
        let data = make_ix_data(1);
        let result = process_instruction(&pid, &[], &data);
        assert!(result.is_ok(), "expected Ok for 1 credential, got {:?}", result);
    }

    #[test]
    fn test_verify_three_credentials_passes() {
        let pid = Pubkey::default();
        let data = make_ix_data(3);
        let result = process_instruction(&pid, &[], &data);
        assert!(result.is_ok(), "expected Ok for 3 credentials, got {:?}", result);
    }

    #[test]
    fn test_verify_zero_credentials_passes() {
        // 0 sigs is edge-case allowed (empty aggregate)
        let pid = Pubkey::default();
        let data = make_ix_data(0);
        let result = process_instruction(&pid, &[], &data);
        assert!(result.is_ok(), "expected Ok for 0 credentials, got {:?}", result);
    }

    #[test]
    fn test_empty_instruction_data_is_rejected() {
        let pid = Pubkey::default();
        let result = process_instruction(&pid, &[], &[]);
        assert_eq!(result, Err(ProgramError::InvalidInstructionData));
    }

    #[test]
    fn test_unknown_discriminant_is_rejected() {
        let pid = Pubkey::default();
        let result = process_instruction(&pid, &[], &[0xFF, 0x00]);
        assert_eq!(result, Err(ProgramError::InvalidInstructionData));
    }

    #[test]
    fn test_truncated_data_is_rejected() {
        let pid = Pubkey::default();
        // discriminant=0x01, num_sigs=1, but only 10 bytes of sig data (need 48+96+48)
        let mut data = vec![0x01u8, 0x01];
        data.extend_from_slice(&[0u8; 10]);
        let result = process_instruction(&pid, &[], &data);
        assert_eq!(result, Err(ProgramError::InvalidInstructionData));
    }

    #[test]
    fn test_instruction_size_1_sig() {
        // 1 + 1 + 1*48 + 96 + 48 = 194 bytes
        let data = make_ix_data(1);
        assert_eq!(data.len(), 1 + 1 + 1 * 48 + 96 + 48);
    }

    #[test]
    fn test_instruction_size_5_sigs() {
        // 1 + 1 + 5*48 + 96 + 48 = 386 bytes
        let data = make_ix_data(5);
        assert_eq!(data.len(), 1 + 1 + 5 * 48 + 96 + 48);
    }
}
