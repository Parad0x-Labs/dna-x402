#[derive(Debug, Clone, PartialEq)]
pub enum ConfidentialTransferStatus {
    NotAvailable,
    AvailableWithRestrictions,
    FullyAvailable,
}

#[derive(Debug, Clone)]
pub struct ExtensionReadiness {
    pub extension_name: String,
    pub status: ConfidentialTransferStatus,
    pub notes: String,
    pub compatible_with: Vec<String>,
    pub incompatible_with: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CompatibilityMatrix {
    pub entries: Vec<ExtensionReadiness>,
}

#[derive(Debug, Clone)]
pub struct NotLiveClaimGuard {
    pub claim: String,
    pub blocked: bool,
    pub reason: String,
}

pub fn check_confidential_transfer_readiness() -> ExtensionReadiness {
    ExtensionReadiness {
        extension_name: "ConfidentialTransfer".to_string(),
        status: ConfidentialTransferStatus::AvailableWithRestrictions,
        notes: "Confidential Transfer is a Token-2022 extension. Amount hiding is available but requires ElGamal keypair and ZK proof generation. Audit status and runtime compatibility should be verified before mainnet use.".to_string(),
        compatible_with: vec![
            "Metadata".to_string(),
            "MemoTransfer".to_string(),
        ],
        incompatible_with: vec![
            "TransferHook".to_string(),
            "TransferFee".to_string(),
        ],
    }
}

pub fn build_compatibility_matrix() -> CompatibilityMatrix {
    let confidential = check_confidential_transfer_readiness();

    let transfer_hook = ExtensionReadiness {
        extension_name: "TransferHook".to_string(),
        status: ConfidentialTransferStatus::FullyAvailable,
        notes: "TransferHook is fully available on Token-2022. Incompatible with ConfidentialTransfer due to known interaction issues with ZK proofs.".to_string(),
        compatible_with: vec![
            "TransferFee".to_string(),
            "MemoTransfer".to_string(),
            "CpiGuard".to_string(),
        ],
        incompatible_with: vec![
            "ConfidentialTransfer".to_string(),
        ],
    };

    let transfer_fee = ExtensionReadiness {
        extension_name: "TransferFee".to_string(),
        status: ConfidentialTransferStatus::FullyAvailable,
        notes: "TransferFee is fully available on Token-2022. Cannot be combined with NonTransferable tokens.".to_string(),
        compatible_with: vec![
            "TransferHook".to_string(),
            "Metadata".to_string(),
        ],
        incompatible_with: vec![
            "NonTransferable".to_string(),
            "ConfidentialTransfer".to_string(),
        ],
    };

    CompatibilityMatrix {
        entries: vec![confidential, transfer_hook, transfer_fee],
    }
}

pub fn guard_live_claim(claim: &str) -> NotLiveClaimGuard {
    let lower = claim.to_lowercase();
    let blocked = lower.contains("live") || lower.contains("production");
    let reason = if blocked {
        "Claims about 'live' or 'production' status for Confidential Transfer require verified audit and runtime confirmation. This guard blocks unverified claims.".to_string()
    } else {
        String::new()
    };
    NotLiveClaimGuard {
        claim: claim.to_string(),
        blocked,
        reason,
    }
}

pub fn confidential_compatible_with_hook() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_readiness_is_available_with_restrictions() {
        let r = check_confidential_transfer_readiness();
        assert_eq!(
            r.status,
            ConfidentialTransferStatus::AvailableWithRestrictions
        );
    }

    #[test]
    fn test_live_claim_blocked() {
        let guard = guard_live_claim("ConfidentialTransfer is live on mainnet");
        assert!(guard.blocked, "claim containing 'live' should be blocked");
        assert!(!guard.reason.is_empty());
    }

    #[test]
    fn test_production_claim_blocked() {
        let guard = guard_live_claim("Ready for production use");
        assert!(
            guard.blocked,
            "claim containing 'production' should be blocked"
        );
    }

    #[test]
    fn test_devnet_claim_not_blocked() {
        let guard = guard_live_claim("Testing ConfidentialTransfer on devnet");
        assert!(!guard.blocked, "devnet claim should not be blocked");
    }

    #[test]
    fn test_confidential_incompatible_with_hook() {
        assert!(!confidential_compatible_with_hook());
    }

    #[test]
    fn test_matrix_has_entries() {
        let matrix = build_compatibility_matrix();
        assert!(
            !matrix.entries.is_empty(),
            "matrix should have at least one entry"
        );
        assert!(
            matrix.entries.len() >= 3,
            "matrix should have at least 3 entries"
        );
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_extension_name_is_correct() {
        let r = check_confidential_transfer_readiness();
        assert_eq!(r.extension_name, "ConfidentialTransfer");
    }

    #[test]
    fn test_compatible_with_metadata() {
        let r = check_confidential_transfer_readiness();
        assert!(r.compatible_with.contains(&"Metadata".to_string()));
    }

    #[test]
    fn test_incompatible_with_transfer_hook() {
        let r = check_confidential_transfer_readiness();
        assert!(r.incompatible_with.contains(&"TransferHook".to_string()));
    }

    #[test]
    fn test_incompatible_with_transfer_fee() {
        let r = check_confidential_transfer_readiness();
        assert!(r.incompatible_with.contains(&"TransferFee".to_string()));
    }

    #[test]
    fn test_transfer_hook_fully_available() {
        let matrix = build_compatibility_matrix();
        let hook = matrix
            .entries
            .iter()
            .find(|e| e.extension_name == "TransferHook")
            .expect("TransferHook should be in matrix");
        assert_eq!(hook.status, ConfidentialTransferStatus::FullyAvailable);
    }

    #[test]
    fn test_empty_claim_not_blocked() {
        let guard = guard_live_claim("");
        assert!(!guard.blocked);
    }

    #[test]
    fn test_case_insensitive_live_check() {
        let guard = guard_live_claim("LIVE on mainnet");
        assert!(guard.blocked, "uppercase 'LIVE' should also be blocked");
    }

    #[test]
    fn test_matrix_entries_all_named() {
        let matrix = build_compatibility_matrix();
        for entry in &matrix.entries {
            assert!(!entry.extension_name.is_empty());
        }
    }

    #[test]
    fn test_guard_reason_empty_when_not_blocked() {
        let guard = guard_live_claim("Testing on devnet today");
        assert!(!guard.blocked);
        assert!(guard.reason.is_empty());
    }

    #[test]
    fn test_guard_stores_claim_verbatim() {
        let claim = "Using ConfidentialTransfer on staging";
        let guard = guard_live_claim(claim);
        assert_eq!(guard.claim, claim);
    }
}
