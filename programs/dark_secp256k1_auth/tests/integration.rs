#[cfg(test)]
mod tests {
    use dark_secp256k1_auth::{
        instruction::AuthInstruction,
        state::{EthAgentRecord, ETH_AGENT_DISC, ETH_AGENT_RECORD_SIZE},
    };

    // ── Instruction parsing ──────────────────────────────────────────────────

    fn build_register_data() -> Vec<u8> {
        let r           = [0x01u8; 32];
        let s           = [0x02u8; 32];
        let recovery_id = 0u8;
        let msg_hash    = [0x03u8; 32];
        let pda_seed    = [0x04u8; 32];
        let auth_hash   = [0x05u8; 32];
        let domain_hash = [0x06u8; 32];

        let mut data = vec![0x01u8];
        data.extend_from_slice(&r);
        data.extend_from_slice(&s);
        data.push(recovery_id);
        data.extend_from_slice(&msg_hash);
        data.extend_from_slice(&pda_seed);
        data.extend_from_slice(&auth_hash);
        data.extend_from_slice(&domain_hash);
        // total: 1 + 32+32+1+32+32+32+32 = 194 bytes
        assert_eq!(data.len(), 194);
        data
    }

    #[test]
    fn register_eth_agent_parses() {
        let data = build_register_data();
        match AuthInstruction::unpack(&data).unwrap() {
            AuthInstruction::RegisterEthAgent {
                r,
                s,
                recovery_id,
                msg_hash,
                pda_seed,
                auth_hash,
                domain_hash,
            } => {
                assert_eq!(r,           [0x01; 32]);
                assert_eq!(s,           [0x02; 32]);
                assert_eq!(recovery_id, 0);
                assert_eq!(msg_hash,    [0x03; 32]);
                assert_eq!(pda_seed,    [0x04; 32]);
                assert_eq!(auth_hash,   [0x05; 32]);
                assert_eq!(domain_hash, [0x06; 32]);
            }
            _ => panic!("expected RegisterEthAgent"),
        }
    }

    #[test]
    fn revoke_eth_agent_parses() {
        let eth_address = [0xABu8; 20];
        let mut data = vec![0x02u8];
        data.extend_from_slice(&eth_address);
        assert_eq!(data.len(), 21);

        match AuthInstruction::unpack(&data).unwrap() {
            AuthInstruction::RevokeEthAgent { eth_address: ea } =>
                assert_eq!(ea, [0xAB; 20]),
            _ => panic!("expected RevokeEthAgent"),
        }
    }

    #[test]
    fn invalid_instruction_returns_error() {
        assert!(AuthInstruction::unpack(&[0xFF]).is_err());
        assert!(AuthInstruction::unpack(&[]).is_err());
        // Too short for RegisterEthAgent (needs 193 bytes after disc)
        assert!(AuthInstruction::unpack(&[0x01; 10]).is_err());
        // Too short for RevokeEthAgent (needs 20 bytes after disc)
        assert!(AuthInstruction::unpack(&[0x02; 5]).is_err());
    }

    // ── State pack / unpack ──────────────────────────────────────────────────

    #[test]
    fn eth_agent_record_round_trip() {
        let record = EthAgentRecord {
            disc:          ETH_AGENT_DISC,
            eth_address:   [0xABu8; 20],
            agent_pubkey:  [0x11u8; 32],
            auth_hash:     [0x22u8; 32],
            domain_hash:   [0x33u8; 32],
            registered_at: 42_000,
            is_active:     true,
        };

        let mut buf = [0u8; ETH_AGENT_RECORD_SIZE];
        record.pack_into(&mut buf);

        let decoded = EthAgentRecord::unpack_from(&buf).expect("should decode");
        assert_eq!(decoded.disc,          ETH_AGENT_DISC);
        assert_eq!(decoded.eth_address,   [0xAB; 20]);
        assert_eq!(decoded.agent_pubkey,  [0x11; 32]);
        assert_eq!(decoded.auth_hash,     [0x22; 32]);
        assert_eq!(decoded.domain_hash,   [0x33; 32]);
        assert_eq!(decoded.registered_at, 42_000);
        assert!(decoded.is_active);
    }

    #[test]
    fn eth_agent_record_is_active_false() {
        let record = EthAgentRecord {
            disc:          ETH_AGENT_DISC,
            eth_address:   [0x01u8; 20],
            agent_pubkey:  [0x02u8; 32],
            auth_hash:     [0x03u8; 32],
            domain_hash:   [0x04u8; 32],
            registered_at: 1,
            is_active:     false,
        };
        let mut buf = [0u8; ETH_AGENT_RECORD_SIZE];
        record.pack_into(&mut buf);
        let decoded = EthAgentRecord::unpack_from(&buf).unwrap();
        assert!(!decoded.is_active);
    }

    #[test]
    fn eth_agent_record_rejects_wrong_disc() {
        let mut buf = [0u8; ETH_AGENT_RECORD_SIZE];
        buf[0] = 0x00;
        assert!(EthAgentRecord::unpack_from(&buf).is_none());
    }

    #[test]
    fn eth_agent_record_rejects_short_buffer() {
        let buf = [0xDDu8; 10];
        assert!(EthAgentRecord::unpack_from(&buf).is_none());
    }

    // ── Size and discriminant assertions ─────────────────────────────────────

    #[test]
    fn eth_agent_record_size_is_correct() {
        // 1 (disc) + 20 (eth) + 32 (agent) + 32 (auth) + 32 (domain) + 8 (slot) + 1 (active)
        assert_eq!(ETH_AGENT_RECORD_SIZE, 126);
    }

    #[test]
    fn eth_agent_disc_value() {
        assert_eq!(ETH_AGENT_DISC, [0xDD]);
    }

    // ── ETH address extraction from pda_seed ─────────────────────────────────

    #[test]
    fn eth_address_from_pda_seed_last_20_bytes() {
        // Mirrors the processor logic: eth_address = pda_seed[12..32]
        let mut pda_seed = [0u8; 32];
        let expected_eth: [u8; 20] = [
            0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe,
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
            0x09, 0x0a, 0x0b, 0x0c,
        ];
        pda_seed[12..32].copy_from_slice(&expected_eth);

        let mut extracted = [0u8; 20];
        extracted.copy_from_slice(&pda_seed[12..32]);
        assert_eq!(extracted, expected_eth);
    }
}
