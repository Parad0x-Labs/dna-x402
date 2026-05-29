//! dark-secp256r1-vault — On-chain P-256 passkey assertion verification + agent vault binding
//!
//! Binds a WebAuthn/passkey credential (secp256r1 / P-256) to a Solana agent public key.
//! Each vault is uniquely identified by the wallet pubkey and the SHA-256 of the credential ID.
//!
//! Production flow (IS_MAINNET_READY = true):
//!   1. The transaction includes a secp256r1 precompile instruction (SIMD-0075).
//!   2. The precompile verifies the P-256 signature and writes its result to the
//!      Secp256r1SigVerify sysvar before this instruction runs.
//!   3. This program trusts the tx-level ordering: if the precompile instruction is
//!      present and successful, the P-256 assertion is valid.
//!
//! ⚠️  EXTERNALLY UNAUDITED — test pilot. Not reviewed by any third-party auditor.
//!    Deploy: `cargo build-sbf --features mainnet`
//!
//! Devnet flow (IS_MAINNET_READY = false):
//!   Signature verification is skipped.  The program trusts the client-supplied fields.
//!
//! Instruction layout:
//!   0x01  RegisterPasskeyVault  [agent_pubkey[32], credential_id_hash[32],
//!                                challenge_hash[32], p256_pubkey_x[32], p256_pubkey_y[32]]
//!   0x02  VerifyPasskeySignal   [challenge_hash[32], new_challenge_hash[32]]
//!   0x03  RevokePasskeyVault
//!   0x04  StoreEncryptedKey     [nonce[12], ciphertext[64], tag[16]]

use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    pubkey::Pubkey,
};

pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    processor::process(program_id, accounts, data)
}

#[cfg(test)]
mod tests {
    use crate::{
        instruction::VaultInstruction,
        state::{
            VAULT_DISC, VAULT_RECORD_SIZE, VAULT_VERSION, VaultRecord,
            OFF_DISC, OFF_WALLET_PUBKEY, OFF_CREDENTIAL_ID_HASH, OFF_AGENT_PUBKEY,
            OFF_CHALLENGE_HASH, OFF_REGISTERED_AT, OFF_VERSION,
        },
    };

    // ── state size assertion ──────────────────────────────────────────────────

    #[test]
    fn test_vault_record_size() {
        assert_eq!(VAULT_RECORD_SIZE, 231);
    }

    // ── pack / unpack roundtrip with enc key fields ───────────────────────────

    #[test]
    fn test_store_encrypted_key_pack_unpack() {
        let nonce:      [u8; 12] = [0x11; 12];
        let ciphertext: [u8; 64] = [0x22; 64];
        let tag:        [u8; 16] = [0x33; 16];

        let record = VaultRecord {
            disc:               VAULT_DISC,
            wallet_pubkey:      [0xAA; 32],
            credential_id_hash: [0xBB; 32],
            agent_pubkey:       [0xCC; 32],
            challenge_hash:     [0xDD; 32],
            registered_at:      999_u64,
            version:            VAULT_VERSION,
            enc_key_nonce:      nonce,
            enc_key_ciphertext: ciphertext,
            enc_key_tag:        tag,
            has_enc_key:        1,
        };

        let mut buf = [0u8; VAULT_RECORD_SIZE];
        record.pack_into(&mut buf);

        let unpacked = VaultRecord::unpack_from(&buf).expect("unpack must succeed");

        assert_eq!(unpacked.has_enc_key, 1);
        assert_eq!(unpacked.enc_key_nonce, nonce);
        assert_eq!(unpacked.enc_key_ciphertext, ciphertext);
        assert_eq!(unpacked.enc_key_tag, tag);
        assert_eq!(unpacked.wallet_pubkey, [0xAA; 32]);
        assert_eq!(unpacked.registered_at, 999_u64);
    }

    // ── instruction unpack 0x04 valid ─────────────────────────────────────────

    #[test]
    fn test_instruction_unpack_0x04_valid() {
        let nonce:      [u8; 12] = [0x01; 12];
        let ciphertext: [u8; 64] = [0x02; 64];
        let tag:        [u8; 16] = [0x03; 16];

        let mut data = vec![0x04u8];
        data.extend_from_slice(&nonce);
        data.extend_from_slice(&ciphertext);
        data.extend_from_slice(&tag);
        assert_eq!(data.len(), 93);

        match VaultInstruction::unpack(&data).expect("unpack must succeed") {
            VaultInstruction::StoreEncryptedKey { nonce: n, ciphertext: c, tag: t } => {
                assert_eq!(n, nonce);
                assert_eq!(c, ciphertext);
                assert_eq!(t, tag);
            }
            _ => panic!("expected StoreEncryptedKey"),
        }
    }

    // ── instruction unpack 0x04 too short ────────────────────────────────────

    #[test]
    fn test_instruction_unpack_0x04_too_short() {
        // 91 bytes of payload (need >= 92)
        let data: Vec<u8> = std::iter::once(0x04u8).chain(vec![0u8; 91]).collect();
        assert_eq!(data.len(), 92);
        assert!(VaultInstruction::unpack(&data).is_err());
    }

    // ── legacy compat: 138-byte buffer unpacks cleanly ────────────────────────

    #[test]
    fn test_vault_record_legacy_compat() {
        // Build a valid 138-byte (legacy) buffer manually.
        let mut buf = [0u8; 138];
        buf[OFF_DISC] = VAULT_DISC[0];
        buf[OFF_WALLET_PUBKEY..OFF_WALLET_PUBKEY + 32].copy_from_slice(&[0x01; 32]);
        buf[OFF_CREDENTIAL_ID_HASH..OFF_CREDENTIAL_ID_HASH + 32].copy_from_slice(&[0x02; 32]);
        buf[OFF_AGENT_PUBKEY..OFF_AGENT_PUBKEY + 32].copy_from_slice(&[0x03; 32]);
        buf[OFF_CHALLENGE_HASH..OFF_CHALLENGE_HASH + 32].copy_from_slice(&[0x04; 32]);
        buf[OFF_REGISTERED_AT..OFF_REGISTERED_AT + 8].copy_from_slice(&42_u64.to_le_bytes());
        buf[OFF_VERSION] = VAULT_VERSION;

        let record = VaultRecord::unpack_from(&buf).expect("legacy unpack must succeed");

        assert_eq!(record.has_enc_key, 0);
        assert_eq!(record.enc_key_nonce, [0u8; 12]);
        assert_eq!(record.enc_key_ciphertext, [0u8; 64]);
        assert_eq!(record.enc_key_tag, [0u8; 16]);
        assert_eq!(record.wallet_pubkey, [0x01; 32]);
        assert_eq!(record.registered_at, 42);
    }
}
