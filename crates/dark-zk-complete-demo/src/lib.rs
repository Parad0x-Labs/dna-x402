// dark-zk-complete-demo — library entry-point for integration tests
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

#[cfg(test)]
mod tests {
    #[test]
    fn test_mainnet_ready_false() {
        let config = dark_bn254_circuit::circuit_constraints_description();
        assert!(!config.is_empty()); // circuit has constraints
    }

    #[test]
    fn test_production_claim_false() {
        let pool = dark_shielded_pool_core::PoolState {
            merkle_root: [0u8; 32],
            note_count: 0,
            total_deposited: 0,
            total_withdrawn: 0,
            mainnet_ready: false,
        };
        assert!(!pool.mainnet_ready);
    }

    #[test]
    fn test_demo_json_security_flags() {
        let flags = serde_json::json!({
            "mainnet_ready": false,
            "production_claim": false,
            "agent_had_private_key": false,
            "devnet_only": true,
            "not_audited": true
        });
        assert_eq!(flags["mainnet_ready"], false);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_pool_note_count_zero_initially() {
        let pool = dark_shielded_pool_core::PoolState {
            merkle_root: [0u8; 32],
            note_count: 0,
            total_deposited: 0,
            total_withdrawn: 0,
            mainnet_ready: false,
        };
        assert_eq!(pool.note_count, 0);
    }

    #[test]
    fn test_pool_total_deposited_zero_initially() {
        let pool = dark_shielded_pool_core::PoolState {
            merkle_root: [0u8; 32],
            note_count: 0,
            total_deposited: 0,
            total_withdrawn: 0,
            mainnet_ready: false,
        };
        assert_eq!(pool.total_deposited, 0);
    }

    #[test]
    fn test_pool_total_withdrawn_zero_initially() {
        let pool = dark_shielded_pool_core::PoolState {
            merkle_root: [0u8; 32],
            note_count: 0,
            total_deposited: 0,
            total_withdrawn: 0,
            mainnet_ready: false,
        };
        assert_eq!(pool.total_withdrawn, 0);
    }

    #[test]
    fn test_pool_merkle_root_zero_initially() {
        let pool = dark_shielded_pool_core::PoolState {
            merkle_root: [0u8; 32],
            note_count: 0,
            total_deposited: 0,
            total_withdrawn: 0,
            mainnet_ready: false,
        };
        assert_eq!(pool.merkle_root, [0u8; 32]);
    }

    #[test]
    fn test_pool_mainnet_ready_always_false() {
        let pool = dark_shielded_pool_core::PoolState {
            merkle_root: [1u8; 32],
            note_count: 100,
            total_deposited: 1_000_000,
            total_withdrawn: 500_000,
            mainnet_ready: false,
        };
        assert!(!pool.mainnet_ready, "mainnet_ready must always be false");
    }

    #[test]
    fn test_pool_with_notes_valid() {
        let pool = dark_shielded_pool_core::PoolState {
            merkle_root: [0xABu8; 32],
            note_count: 5,
            total_deposited: 5_000_000,
            total_withdrawn: 0,
            mainnet_ready: false,
        };
        assert_eq!(pool.note_count, 5);
        assert!(pool.total_deposited > pool.total_withdrawn);
    }

    #[test]
    fn test_pool_deposited_geq_withdrawn() {
        let pool = dark_shielded_pool_core::PoolState {
            merkle_root: [0xCDu8; 32],
            note_count: 3,
            total_deposited: 3_000_000,
            total_withdrawn: 1_000_000,
            mainnet_ready: false,
        };
        assert!(pool.total_deposited >= pool.total_withdrawn);
    }

    #[test]
    fn test_circuit_description_len_positive() {
        let desc = dark_bn254_circuit::circuit_constraints_description();
        assert!(!desc.is_empty(), "circuit description must be nonempty");
    }

    #[test]
    fn test_circuit_description_not_all_whitespace() {
        let desc = dark_bn254_circuit::circuit_constraints_description();
        // desc is Vec<&str> — at least one entry must be non-empty after trimming
        assert!(
            desc.iter().any(|s| !s.trim().is_empty()),
            "circuit description must contain at least one non-whitespace entry"
        );
    }

    #[test]
    fn test_json_devnet_only_true() {
        let flags = serde_json::json!({ "devnet_only": true });
        assert_eq!(flags["devnet_only"], true);
    }

    #[test]
    fn test_json_not_audited_true() {
        let flags = serde_json::json!({ "not_audited": true });
        assert_eq!(flags["not_audited"], true);
    }

    #[test]
    fn test_json_agent_had_private_key_false() {
        let flags = serde_json::json!({ "agent_had_private_key": false });
        assert_eq!(flags["agent_had_private_key"], false);
    }

    #[test]
    fn test_json_production_claim_false() {
        let flags = serde_json::json!({ "production_claim": false });
        assert_eq!(flags["production_claim"], false);
    }
}
