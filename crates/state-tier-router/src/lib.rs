//! State Tier Router — before writing any code, pass your object
//! through this router. Most objects fail to justify a PDA.
//!
//! Tiers (cheapest → most expensive):
//!   OffChainOnly       — never touches the chain
//!   EventOnly          — emitted as program log, no account
//!   CompressedLeaf     — ZK-compressed state, indexer serves retrieval
//!   TinyPdaHeader      — ≤64 bytes PDA, hashes only
//!   TokenAccount       — SPL token / Token-2022 account
//!   FullAccount        — large mutable on-chain account (forbidden unless justified)

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageTier {
    OffChainOnly,
    EventOnly,
    CompressedLeaf,
    TinyPdaHeader,
    TokenAccount,
    FullAccount,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifetime {
    Ephemeral,
    Session,
    Epoch,
    Permanent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadFrequency {
    Never,
    RareAudit,
    FrequentRead,
    RealTime,
}

pub struct ObjectDescriptor {
    /// Must the Solana runtime itself enforce correctness at instruction time?
    pub must_enforce_on_chain: bool,
    /// Will this object be mutated after creation?
    pub mutable: bool,
    /// How long does this object need to live?
    pub lifetime: Lifetime,
    /// Is this object visible / searchable by arbitrary parties?
    pub public_visibility: bool,
    /// Raw size of the object in bytes.
    pub size_bytes: usize,
    /// How often does the on-chain program need to read it?
    pub read_frequency: ReadFrequency,
    /// Does it hold or represent a transferable value (tokens)?
    pub holds_value: bool,
}

/// Route an object to its cheapest safe storage tier.
/// Returns (tier, human-readable rationale).
pub fn route(obj: &ObjectDescriptor) -> (StorageTier, &'static str) {
    if !obj.must_enforce_on_chain && !obj.mutable && !obj.holds_value {
        if obj.lifetime == Lifetime::Ephemeral || obj.lifetime == Lifetime::Session {
            return (
                StorageTier::OffChainOnly,
                "ephemeral non-mutable: off-chain only",
            );
        }
        if obj.read_frequency == ReadFrequency::Never
            || obj.read_frequency == ReadFrequency::RareAudit
        {
            return (
                StorageTier::EventOnly,
                "audit trail only: emit as event log",
            );
        }
        return (
            StorageTier::CompressedLeaf,
            "historical, non-enforced: compressed leaf",
        );
    }
    if obj.holds_value {
        return (
            StorageTier::TokenAccount,
            "value-bearing: use token account",
        );
    }
    if obj.must_enforce_on_chain && obj.size_bytes <= 64 {
        return (
            StorageTier::TinyPdaHeader,
            "enforcement required, small: tiny PDA header",
        );
    }
    if obj.must_enforce_on_chain && obj.size_bytes > 64 {
        return (
            StorageTier::FullAccount,
            "enforcement required, large: justify or split",
        );
    }
    (StorageTier::CompressedLeaf, "default: compressed leaf")
}

/// Estimated SOL rent cost at each tier for reference (order of magnitude).
pub fn tier_cost_commentary(tier: StorageTier) -> &'static str {
    match tier {
        StorageTier::OffChainOnly => "0 SOL on-chain",
        StorageTier::EventOnly => "~0.000005 SOL tx fee only",
        StorageTier::CompressedLeaf => "~0.00001 SOL (state tree overhead amortised)",
        StorageTier::TinyPdaHeader => "~0.001–0.003 SOL rent-exempt",
        StorageTier::TokenAccount => "~0.002 SOL rent-exempt",
        StorageTier::FullAccount => ">0.01 SOL — REVIEW REQUIRED",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ephemeral_non_enforced_goes_offchain() {
        let obj = ObjectDescriptor {
            must_enforce_on_chain: false,
            mutable: false,
            lifetime: Lifetime::Ephemeral,
            public_visibility: false,
            size_bytes: 32,
            read_frequency: ReadFrequency::RealTime,
            holds_value: false,
        };
        let (tier, _rationale) = route(&obj);
        assert_eq!(tier, StorageTier::OffChainOnly);
    }

    #[test]
    fn test_enforced_tiny_goes_pda() {
        let obj = ObjectDescriptor {
            must_enforce_on_chain: true,
            mutable: true,
            lifetime: Lifetime::Permanent,
            public_visibility: true,
            size_bytes: 64,
            read_frequency: ReadFrequency::FrequentRead,
            holds_value: false,
        };
        let (tier, _rationale) = route(&obj);
        assert_eq!(tier, StorageTier::TinyPdaHeader);
    }

    #[test]
    fn test_value_bearing_goes_token() {
        let obj = ObjectDescriptor {
            must_enforce_on_chain: true,
            mutable: true,
            lifetime: Lifetime::Permanent,
            public_visibility: true,
            size_bytes: 165,
            read_frequency: ReadFrequency::RealTime,
            holds_value: true,
        };
        let (tier, _rationale) = route(&obj);
        assert_eq!(tier, StorageTier::TokenAccount);
    }

    #[test]
    fn test_historical_goes_compressed() {
        // Permanent, not enforced, not mutable, not value-bearing, FrequentRead
        let obj = ObjectDescriptor {
            must_enforce_on_chain: false,
            mutable: false,
            lifetime: Lifetime::Permanent,
            public_visibility: true,
            size_bytes: 128,
            read_frequency: ReadFrequency::FrequentRead,
            holds_value: false,
        };
        let (tier, _rationale) = route(&obj);
        // FrequentRead is not Never/RareAudit, so falls through to CompressedLeaf
        assert_eq!(tier, StorageTier::CompressedLeaf);
    }

    #[test]
    fn test_historical_rare_audit_goes_event() {
        // Epoch lifetime, not enforced, not mutable, RareAudit -> EventOnly
        let obj = ObjectDescriptor {
            must_enforce_on_chain: false,
            mutable: false,
            lifetime: Lifetime::Epoch,
            public_visibility: false,
            size_bytes: 64,
            read_frequency: ReadFrequency::RareAudit,
            holds_value: false,
        };
        let (tier, _rationale) = route(&obj);
        assert!(tier == StorageTier::EventOnly || tier == StorageTier::CompressedLeaf);
    }

    #[test]
    fn test_large_enforced_goes_full() {
        let obj = ObjectDescriptor {
            must_enforce_on_chain: true,
            mutable: true,
            lifetime: Lifetime::Permanent,
            public_visibility: true,
            size_bytes: 1024,
            read_frequency: ReadFrequency::RealTime,
            holds_value: false,
        };
        let (tier, _rationale) = route(&obj);
        assert_eq!(tier, StorageTier::FullAccount);
    }

    #[test]
    fn test_tier_cost_commentary_never_empty() {
        let tiers = [
            StorageTier::OffChainOnly,
            StorageTier::EventOnly,
            StorageTier::CompressedLeaf,
            StorageTier::TinyPdaHeader,
            StorageTier::TokenAccount,
            StorageTier::FullAccount,
        ];
        for tier in tiers {
            let commentary = tier_cost_commentary(tier);
            assert!(
                !commentary.is_empty(),
                "commentary for {:?} was empty",
                tier
            );
        }
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_session_lifetime_goes_offchain() {
        let obj = ObjectDescriptor {
            must_enforce_on_chain: false,
            mutable: false,
            lifetime: Lifetime::Session,
            public_visibility: false,
            size_bytes: 32,
            read_frequency: ReadFrequency::Never,
            holds_value: false,
        };
        let (tier, _) = route(&obj);
        assert_eq!(tier, StorageTier::OffChainOnly);
    }

    #[test]
    fn test_enforced_size_64_tiny_pda() {
        // size == 64 (exactly at boundary) → TinyPdaHeader
        let obj = ObjectDescriptor {
            must_enforce_on_chain: true,
            mutable: true,
            lifetime: Lifetime::Permanent,
            public_visibility: false,
            size_bytes: 64,
            read_frequency: ReadFrequency::RealTime,
            holds_value: false,
        };
        let (tier, _) = route(&obj);
        assert_eq!(tier, StorageTier::TinyPdaHeader);
    }

    #[test]
    fn test_enforced_size_65_full_account() {
        // size == 65 (just above boundary) → FullAccount
        let obj = ObjectDescriptor {
            must_enforce_on_chain: true,
            mutable: true,
            lifetime: Lifetime::Permanent,
            public_visibility: false,
            size_bytes: 65,
            read_frequency: ReadFrequency::RealTime,
            holds_value: false,
        };
        let (tier, _) = route(&obj);
        assert_eq!(tier, StorageTier::FullAccount);
    }

    #[test]
    fn test_never_read_epoch_lifetime_event_only() {
        let obj = ObjectDescriptor {
            must_enforce_on_chain: false,
            mutable: false,
            lifetime: Lifetime::Epoch,
            public_visibility: false,
            size_bytes: 32,
            read_frequency: ReadFrequency::Never,
            holds_value: false,
        };
        let (tier, _) = route(&obj);
        assert_eq!(tier, StorageTier::EventOnly);
    }

    #[test]
    fn test_tier_cost_offchain_zero_sol() {
        let commentary = tier_cost_commentary(StorageTier::OffChainOnly);
        assert!(commentary.contains("0 SOL"));
    }

    #[test]
    fn test_tier_cost_full_account_review() {
        let commentary = tier_cost_commentary(StorageTier::FullAccount);
        assert!(commentary.contains("REVIEW"));
    }

    #[test]
    fn test_rationale_not_empty_offchain_path() {
        let obj = ObjectDescriptor {
            must_enforce_on_chain: false,
            mutable: false,
            lifetime: Lifetime::Ephemeral,
            public_visibility: false,
            size_bytes: 32,
            read_frequency: ReadFrequency::RealTime,
            holds_value: false,
        };
        let (_, rationale) = route(&obj);
        assert!(!rationale.is_empty());
    }

    #[test]
    fn test_value_bearing_ignores_enforcement_flag() {
        // holds_value=true → TokenAccount even if not must_enforce_on_chain
        let obj = ObjectDescriptor {
            must_enforce_on_chain: false,
            mutable: false,
            lifetime: Lifetime::Permanent,
            public_visibility: true,
            size_bytes: 165,
            read_frequency: ReadFrequency::FrequentRead,
            holds_value: true,
        };
        let (tier, _) = route(&obj);
        assert_eq!(tier, StorageTier::TokenAccount);
    }

    #[test]
    fn test_rationale_not_empty_enforced_large() {
        let obj = ObjectDescriptor {
            must_enforce_on_chain: true,
            mutable: true,
            lifetime: Lifetime::Permanent,
            public_visibility: true,
            size_bytes: 512,
            read_frequency: ReadFrequency::RealTime,
            holds_value: false,
        };
        let (_, rationale) = route(&obj);
        assert!(!rationale.is_empty());
    }
}
