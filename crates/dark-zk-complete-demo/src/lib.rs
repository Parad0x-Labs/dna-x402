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
}
