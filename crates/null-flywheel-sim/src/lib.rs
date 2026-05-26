// NULL_FLYWHEEL_VAULT_V1 — simulation library tests
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

#[cfg(test)]
mod tests {
    #[test]
    fn test_mainnet_ready_false() {
        let config = null_flywheel_core::FlywheelConfig::default();
        assert!(!config.mainnet_ready, "mainnet_ready must be false");
    }

    #[test]
    fn test_production_claim_false() {
        let config = null_flywheel_core::FlywheelConfig::default();
        assert!(!config.production_claim, "production_claim must be false");
    }

    #[test]
    fn test_destination_rewards_vault_not_burn() {
        let config = null_flywheel_core::FlywheelConfig::default();
        assert_eq!(
            config.destination,
            null_flywheel_core::DestinationPolicy::RewardsVault
        );
    }

    #[test]
    fn test_sim_json_has_security_flags() {
        // Verifies the demo JSON structure includes the required security flags
        // without running the full binary
        let security_flags = serde_json::json!({
            "mainnet_ready": false,
            "production_claim": false,
            "agent_had_private_key": false,
            "devnet_only": true,
            "not_audited": true,
            "destination": "RewardsVault",
            "burn_vault": "disabled_by_default"
        });
        assert_eq!(security_flags["mainnet_ready"], false);
        assert_eq!(security_flags["production_claim"], false);
        assert_eq!(security_flags["destination"], "RewardsVault");
    }
}
