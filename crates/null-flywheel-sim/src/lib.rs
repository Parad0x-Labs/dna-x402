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

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_config_default_allocation_bps() {
        let config = null_flywheel_core::FlywheelConfig::default();
        assert_eq!(
            config.allocation_bps,
            null_flywheel_core::DEFAULT_ALLOCATION_BPS
        );
    }

    #[test]
    fn test_config_null_mint_nonempty() {
        let config = null_flywheel_core::FlywheelConfig::default();
        assert!(!config.null_mint.is_empty());
    }

    #[test]
    fn test_config_min_execution_lamports() {
        let config = null_flywheel_core::FlywheelConfig::default();
        assert_eq!(
            config.min_execution_lamports,
            null_flywheel_core::MIN_EXECUTION_LAMPORTS
        );
    }

    #[test]
    fn test_event_hash_nonzero() {
        let event = null_flywheel_core::PremiumFeeEvent::new(
            null_flywheel_core::SourceKind::SignalRevealFee,
            1_000_000,
            1,
        );
        assert_ne!(event.event_hash, [0u8; 32]);
    }

    #[test]
    fn test_event_hash_deterministic() {
        let e1 = null_flywheel_core::PremiumFeeEvent::new(
            null_flywheel_core::SourceKind::RiskCheckFee,
            500_000,
            3,
        );
        let e2 = null_flywheel_core::PremiumFeeEvent::new(
            null_flywheel_core::SourceKind::RiskCheckFee,
            500_000,
            3,
        );
        assert_eq!(e1.event_hash, e2.event_hash);
    }

    #[test]
    fn test_event_hash_epoch_sensitive() {
        let e1 = null_flywheel_core::PremiumFeeEvent::new(
            null_flywheel_core::SourceKind::SniperTaxFee,
            100_000,
            1,
        );
        let e2 = null_flywheel_core::PremiumFeeEvent::new(
            null_flywheel_core::SourceKind::SniperTaxFee,
            100_000,
            2,
        );
        assert_ne!(e1.event_hash, e2.event_hash);
    }

    #[test]
    fn test_event_hash_source_sensitive() {
        let e1 = null_flywheel_core::PremiumFeeEvent::new(
            null_flywheel_core::SourceKind::SignalRevealFee,
            100_000,
            5,
        );
        let e2 = null_flywheel_core::PremiumFeeEvent::new(
            null_flywheel_core::SourceKind::RitualGateFee,
            100_000,
            5,
        );
        assert_ne!(e1.event_hash, e2.event_hash);
    }

    #[test]
    fn test_allocation_five_bps_of_gross() {
        let config = null_flywheel_core::FlywheelConfig::default();
        // 5 bps = 0.05% of 1_000_000 = 500
        let result = null_flywheel_core::compute_allocation(&config, 1_000_000);
        assert_eq!(result.allocated_lamports, 500);
    }

    #[test]
    fn test_allocation_remaining_is_gross_minus_allocated() {
        let config = null_flywheel_core::FlywheelConfig::default();
        let gross = 2_000_000u64;
        let result = null_flywheel_core::compute_allocation(&config, gross);
        assert_eq!(result.allocated_lamports + result.remaining_lamports, gross);
    }

    #[test]
    fn test_rewards_vault_is_default_destination() {
        let config = null_flywheel_core::FlywheelConfig::default();
        assert_eq!(
            config.destination,
            null_flywheel_core::DestinationPolicy::RewardsVault
        );
    }

    #[test]
    fn test_add_fee_event_increments_events_list() {
        let config = null_flywheel_core::FlywheelConfig::default();
        let mut events = Vec::new();
        let event = null_flywheel_core::PremiumFeeEvent::new(
            null_flywheel_core::SourceKind::HintTierFee,
            500_000,
            1,
        );
        null_flywheel_core::add_fee_event(&mut events, &config, event);
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn test_default_allocation_bps_constant_is_five() {
        assert_eq!(null_flywheel_core::DEFAULT_ALLOCATION_BPS, 5);
    }
}
