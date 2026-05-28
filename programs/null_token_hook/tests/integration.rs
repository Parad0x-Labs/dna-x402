#[cfg(test)]
mod tests {
    use null_token_hook::{
        instruction::{HookInstruction, EXECUTE_DISC},
        state::{
            AllowlistEntry, HookConfig, ALLOWLIST_DISC, ALLOWLIST_ENTRY_SIZE, CONFIG_DISC,
            HOOK_CONFIG_SIZE, FLAG_AGENT_PASSPORT_VERIFIED, FLAG_GUILD_MEMBER,
        },
    };

    // ── Instruction parsing ──────────────────────────────────────────────────

    #[test]
    fn execute_discriminant_parses() {
        let mut data = [0u8; 16];
        data[0..8].copy_from_slice(&EXECUTE_DISC);
        let amount: u64 = 1_000_000;
        data[8..16].copy_from_slice(&amount.to_le_bytes());

        match HookInstruction::unpack(&data).unwrap() {
            HookInstruction::Execute { amount: a } => assert_eq!(a, 1_000_000),
            _ => panic!("expected Execute"),
        }
    }

    #[test]
    fn init_config_parses() {
        let limit: u64 = 5_000;
        let mut data = [0u8; 9];
        data[0] = 0x02;
        data[1..9].copy_from_slice(&limit.to_le_bytes());

        match HookInstruction::unpack(&data).unwrap() {
            HookInstruction::InitConfig { dark_pool_limit_atomic } =>
                assert_eq!(dark_pool_limit_atomic, 5_000),
            _ => panic!("expected InitConfig"),
        }
    }

    #[test]
    fn add_to_allowlist_parses() {
        let flags = FLAG_AGENT_PASSPORT_VERIFIED | FLAG_GUILD_MEMBER;
        let mut data = [0u8; 9];
        data[0] = 0x03;
        data[1..9].copy_from_slice(&flags.to_le_bytes());

        match HookInstruction::unpack(&data).unwrap() {
            HookInstruction::AddToAllowlist { flags: f } => assert_eq!(f, flags),
            _ => panic!("expected AddToAllowlist"),
        }
    }

    #[test]
    fn remove_from_allowlist_parses() {
        let data = [0x04u8];
        match HookInstruction::unpack(&data).unwrap() {
            HookInstruction::RemoveFromAllowlist => {}
            _ => panic!("expected RemoveFromAllowlist"),
        }
    }

    #[test]
    fn invalid_instruction_returns_error() {
        assert!(HookInstruction::unpack(&[0xFF]).is_err());
        assert!(HookInstruction::unpack(&[]).is_err());
    }

    // ── State pack / unpack ──────────────────────────────────────────────────

    #[test]
    fn allowlist_entry_round_trip() {
        let pubkey = [0xABu8; 32];
        let flags  = FLAG_AGENT_PASSPORT_VERIFIED;
        let entry  = AllowlistEntry { disc: ALLOWLIST_DISC, pubkey, flags };

        let mut buf = [0u8; ALLOWLIST_ENTRY_SIZE];
        entry.pack_into(&mut buf);

        let decoded = AllowlistEntry::unpack_from(&buf).expect("should decode");
        assert_eq!(decoded.pubkey, pubkey);
        assert_eq!(decoded.flags, flags);
        assert!(decoded.passport_verified());
        assert_eq!(buf[0], ALLOWLIST_DISC[0]);
    }

    #[test]
    fn allowlist_entry_rejects_wrong_disc() {
        let mut buf = [0u8; ALLOWLIST_ENTRY_SIZE];
        buf[0] = 0x00; // wrong discriminant
        assert!(AllowlistEntry::unpack_from(&buf).is_none());
    }

    #[test]
    fn hook_config_round_trip() {
        let admin: [u8; 32] = [0x11; 32];
        let config = HookConfig {
            disc:                   CONFIG_DISC,
            admin,
            hook_enabled:           true,
            dark_pool_limit_atomic: 999_999,
        };

        let mut buf = [0u8; HOOK_CONFIG_SIZE];
        config.pack_into(&mut buf);

        let decoded = HookConfig::unpack_from(&buf).expect("should decode");
        assert_eq!(decoded.admin, admin);
        assert!(decoded.hook_enabled);
        assert_eq!(decoded.dark_pool_limit_atomic, 999_999);
        assert_eq!(buf[0], CONFIG_DISC[0]);
    }

    #[test]
    fn hook_config_rejects_wrong_disc() {
        let mut buf = [0u8; HOOK_CONFIG_SIZE];
        buf[0] = 0x00;
        assert!(HookConfig::unpack_from(&buf).is_none());
    }

    // ── Discriminant value assertions ────────────────────────────────────────

    #[test]
    fn execute_disc_value() {
        // sha256("spl-transfer-hook-interface:execute")[..8]
        assert_eq!(EXECUTE_DISC, [0x9e, 0x22, 0x2c, 0x78, 0x0a, 0x62, 0x3d, 0xab]);
    }

    #[test]
    fn allowlist_disc_value() {
        assert_eq!(ALLOWLIST_DISC, [0xAA]);
    }

    #[test]
    fn config_disc_value() {
        assert_eq!(CONFIG_DISC, [0xBB]);
    }

    #[test]
    fn flag_bits_do_not_overlap() {
        assert_eq!(FLAG_AGENT_PASSPORT_VERIFIED & FLAG_GUILD_MEMBER, 0);
    }
}
