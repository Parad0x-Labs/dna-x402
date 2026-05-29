#[cfg(test)]
mod tests {
    use dark_secp256r1_vault::{
        instruction::VaultInstruction,
        state::{VaultRecord, VAULT_DISC, VAULT_RECORD_SIZE, VAULT_VERSION},
    };

    // ── Instruction parsing ──────────────────────────────────────────────────

    #[test]
    fn register_passkey_vault_parses() {
        let agent_pubkey       = [0x01u8; 32];
        let credential_id_hash = [0x02u8; 32];
        let challenge_hash     = [0x03u8; 32];
        let p256_x             = [0x04u8; 32];
        let p256_y             = [0x05u8; 32];

        let mut data = vec![0x01u8];
        data.extend_from_slice(&agent_pubkey);
        data.extend_from_slice(&credential_id_hash);
        data.extend_from_slice(&challenge_hash);
        data.extend_from_slice(&p256_x);
        data.extend_from_slice(&p256_y);
        assert_eq!(data.len(), 161);

        match VaultInstruction::unpack(&data).unwrap() {
            VaultInstruction::RegisterPasskeyVault {
                agent_pubkey:       ap,
                credential_id_hash: cih,
                challenge_hash:     ch,
                p256_pubkey_x:      px,
                p256_pubkey_y:      py,
            } => {
                assert_eq!(ap,  agent_pubkey);
                assert_eq!(cih, credential_id_hash);
                assert_eq!(ch,  challenge_hash);
                assert_eq!(px,  p256_x);
                assert_eq!(py,  p256_y);
            }
            _ => panic!("expected RegisterPasskeyVault"),
        }
    }

    #[test]
    fn verify_passkey_signal_parses() {
        let challenge_hash     = [0xAAu8; 32];
        let new_challenge_hash = [0xBBu8; 32];

        let mut data = vec![0x02u8];
        data.extend_from_slice(&challenge_hash);
        data.extend_from_slice(&new_challenge_hash);
        assert_eq!(data.len(), 65);

        match VaultInstruction::unpack(&data).unwrap() {
            VaultInstruction::VerifyPasskeySignal {
                challenge_hash:     ch,
                new_challenge_hash: nch,
            } => {
                assert_eq!(ch,  challenge_hash);
                assert_eq!(nch, new_challenge_hash);
            }
            _ => panic!("expected VerifyPasskeySignal"),
        }
    }

    #[test]
    fn revoke_passkey_vault_parses() {
        let data = [0x03u8];
        match VaultInstruction::unpack(&data).unwrap() {
            VaultInstruction::RevokePasskeyVault => {}
            _ => panic!("expected RevokePasskeyVault"),
        }
    }

    #[test]
    fn invalid_instruction_returns_error() {
        assert!(VaultInstruction::unpack(&[0xFF]).is_err());
        assert!(VaultInstruction::unpack(&[]).is_err());
        // Too short for RegisterPasskeyVault (needs 160 payload bytes after disc)
        assert!(VaultInstruction::unpack(&[0x01, 0x00]).is_err());
    }

    // ── State pack / unpack ──────────────────────────────────────────────────

    #[test]
    fn vault_record_round_trip() {
        let record = VaultRecord {
            disc:               VAULT_DISC,
            wallet_pubkey:      [0x10u8; 32],
            credential_id_hash: [0x20u8; 32],
            agent_pubkey:       [0x30u8; 32],
            challenge_hash:     [0x40u8; 32],
            registered_at:      1_000_000,
            version:            VAULT_VERSION,
            enc_key_nonce:      [0u8; 12],
            enc_key_ciphertext: [0u8; 64],
            enc_key_tag:        [0u8; 16],
            has_enc_key:        0,
        };

        let mut buf = [0u8; VAULT_RECORD_SIZE];
        record.pack_into(&mut buf);

        let decoded = VaultRecord::unpack_from(&buf).expect("should decode");
        assert_eq!(decoded.disc,               VAULT_DISC);
        assert_eq!(decoded.wallet_pubkey,      [0x10; 32]);
        assert_eq!(decoded.credential_id_hash, [0x20; 32]);
        assert_eq!(decoded.agent_pubkey,       [0x30; 32]);
        assert_eq!(decoded.challenge_hash,     [0x40; 32]);
        assert_eq!(decoded.registered_at,      1_000_000);
        assert_eq!(decoded.version,            VAULT_VERSION);
    }

    #[test]
    fn vault_record_rejects_wrong_disc() {
        let mut buf = [0u8; VAULT_RECORD_SIZE];
        buf[0] = 0x00; // wrong discriminant
        assert!(VaultRecord::unpack_from(&buf).is_none());
    }

    #[test]
    fn vault_record_rejects_short_buffer() {
        let buf = [0xCCu8; 10];
        assert!(VaultRecord::unpack_from(&buf).is_none());
    }

    // ── Size constants ───────────────────────────────────────────────────────

    #[test]
    fn vault_record_size_is_correct() {
        // 1+32+32+32+32+8+1 (legacy 138) + 12 (nonce) + 64 (ciphertext) + 16 (tag) + 1 (has_enc_key)
        assert_eq!(VAULT_RECORD_SIZE, 231);
    }

    #[test]
    fn vault_disc_value() {
        assert_eq!(VAULT_DISC, [0xCC]);
    }
}
