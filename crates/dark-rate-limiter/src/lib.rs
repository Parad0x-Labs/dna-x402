use serde::Serialize;
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

pub struct RateLimitConfig {
    pub max_per_epoch: u32,
    pub epoch: u64,
    pub domain: [u8; 8],
}

pub struct SpendTicket {
    pub nullifier: [u8; 32],
    pub epoch: u64,
    pub domain: [u8; 8],
    /// How many spends remain after this one (computed by client).
    pub remaining_after: u32,
}

pub struct EpochLedger {
    pub config: RateLimitConfig,
    pub spent_nullifiers: Vec<[u8; 32]>,
    pub spend_count: u32,
    /// Always `false` — mainnet hardening not yet complete.
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum RateLimitError {
    QuotaExceeded { limit: u32, attempted: u32 },
    DuplicateNullifier,
    WrongEpoch { expected: u64, got: u64 },
    WrongDomain,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a fresh ledger for `config`. `mainnet_ready` is always `false`.
pub fn new_ledger(config: RateLimitConfig) -> EpochLedger {
    EpochLedger {
        config,
        spent_nullifiers: Vec::new(),
        spend_count: 0,
        mainnet_ready: false,
    }
}

/// Derive a spend nullifier.
///
/// Preimage: `"rate-null-v1"` || `user_secret` || `epoch` (LE u64) ||
///           `counter` (LE u32) || `domain`
pub fn generate_spend_nullifier(
    user_secret: &[u8; 32],
    epoch: u64,
    counter: u32,
    domain: &[u8; 8],
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"rate-null-v1");
    h.update(user_secret);
    h.update(epoch.to_le_bytes());
    h.update(counter.to_le_bytes());
    h.update(domain);
    h.finalize().into()
}

/// Record a spend ticket against the ledger.
///
/// Errors (checked in order):
/// 1. `WrongEpoch`  — ticket epoch != ledger epoch
/// 2. `WrongDomain` — ticket domain != ledger domain
/// 3. `DuplicateNullifier` — nullifier already seen
/// 4. `QuotaExceeded` — spend_count would exceed max_per_epoch
pub fn record_spend(ledger: &mut EpochLedger, ticket: SpendTicket) -> Result<(), RateLimitError> {
    if ticket.epoch != ledger.config.epoch {
        return Err(RateLimitError::WrongEpoch {
            expected: ledger.config.epoch,
            got: ticket.epoch,
        });
    }

    if ticket.domain != ledger.config.domain {
        return Err(RateLimitError::WrongDomain);
    }

    if ledger.spent_nullifiers.contains(&ticket.nullifier) {
        return Err(RateLimitError::DuplicateNullifier);
    }

    if ledger.spend_count >= ledger.config.max_per_epoch {
        return Err(RateLimitError::QuotaExceeded {
            limit: ledger.config.max_per_epoch,
            attempted: ledger.spend_count + 1,
        });
    }

    ledger.spent_nullifiers.push(ticket.nullifier);
    ledger.spend_count += 1;
    Ok(())
}

/// Returns `true` when the ledger has not exceeded its quota.
pub fn verify_under_quota(ledger: &EpochLedger) -> bool {
    ledger.spend_count <= ledger.config.max_per_epoch
}

/// Serialise ledger statistics to JSON.
///
/// Privacy guarantee: nullifier values and user secrets are **never** included.
pub fn ledger_stats_json(ledger: &EpochLedger) -> String {
    #[derive(Serialize)]
    struct Stats<'a> {
        epoch: u64,
        domain: &'a str,
        spend_count: u32,
        max_per_epoch: u32,
        mainnet_ready: bool,
    }

    let domain_hex = hex_encode(&ledger.config.domain);
    let stats = Stats {
        epoch: ledger.config.epoch,
        domain: &domain_hex,
        spend_count: ledger.spend_count,
        max_per_epoch: ledger.config.max_per_epoch,
        mainnet_ready: ledger.mainnet_ready,
    };

    serde_json::to_string(&stats).expect("stats serialization is infallible")
}

/// Advance to a new epoch: clears all spend state.
pub fn reset_epoch(ledger: &mut EpochLedger, new_epoch: u64) {
    ledger.spent_nullifiers.clear();
    ledger.spend_count = 0;
    ledger.config.epoch = new_epoch;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_config(max: u32, epoch: u64) -> RateLimitConfig {
        RateLimitConfig {
            max_per_epoch: max,
            epoch,
            domain: *b"testdmn1",
        }
    }

    fn ticket_for(secret: &[u8; 32], epoch: u64, counter: u32, domain: &[u8; 8]) -> SpendTicket {
        SpendTicket {
            nullifier: generate_spend_nullifier(secret, epoch, counter, domain),
            epoch,
            domain: *domain,
            remaining_after: 0,
        }
    }

    // 1 -----------------------------------------------------------------------
    #[test]
    fn test_record_spend_happy_path() {
        let config = make_config(10, 1);
        let domain = config.domain;
        let epoch = config.epoch;
        let mut ledger = new_ledger(config);
        let secret = [0xABu8; 32];

        for counter in 0..3 {
            let t = ticket_for(&secret, epoch, counter, &domain);
            record_spend(&mut ledger, t).expect("spend should succeed");
        }

        assert_eq!(ledger.spend_count, 3);
    }

    // 2 -----------------------------------------------------------------------
    #[test]
    fn test_quota_exceeded_rejected() {
        let config = make_config(2, 1);
        let domain = config.domain;
        let epoch = config.epoch;
        let mut ledger = new_ledger(config);
        let secret = [0x01u8; 32];

        // Fill to the limit
        for counter in 0..2 {
            let t = ticket_for(&secret, epoch, counter, &domain);
            record_spend(&mut ledger, t).expect("should succeed");
        }

        // Third attempt must fail
        let t = ticket_for(&secret, epoch, 2, &domain);
        let err = record_spend(&mut ledger, t).unwrap_err();
        assert!(
            matches!(
                err,
                RateLimitError::QuotaExceeded {
                    limit: 2,
                    attempted: 3
                }
            ),
            "expected QuotaExceeded, got {:?}",
            err
        );
    }

    // 3 -----------------------------------------------------------------------
    #[test]
    fn test_duplicate_nullifier_rejected() {
        let config = make_config(10, 1);
        let domain = config.domain;
        let epoch = config.epoch;
        let mut ledger = new_ledger(config);
        let secret = [0x02u8; 32];

        let t1 = ticket_for(&secret, epoch, 0, &domain);
        let t2 = ticket_for(&secret, epoch, 0, &domain); // identical nullifier
        record_spend(&mut ledger, t1).expect("first spend must succeed");
        let err = record_spend(&mut ledger, t2).unwrap_err();
        assert_eq!(err, RateLimitError::DuplicateNullifier);
    }

    // 4 -----------------------------------------------------------------------
    #[test]
    fn test_wrong_epoch_rejected() {
        let config = make_config(10, 5);
        let domain = config.domain;
        let mut ledger = new_ledger(config);
        let secret = [0x03u8; 32];

        // Ticket claims epoch 6 but ledger is epoch 5
        let t = ticket_for(&secret, 6, 0, &domain);
        let err = record_spend(&mut ledger, t).unwrap_err();
        assert!(
            matches!(
                err,
                RateLimitError::WrongEpoch {
                    expected: 5,
                    got: 6
                }
            ),
            "expected WrongEpoch, got {:?}",
            err
        );
    }

    // 5 -----------------------------------------------------------------------
    #[test]
    fn test_epoch_reset_clears_state() {
        let config = make_config(2, 1);
        let domain = config.domain;
        let mut ledger = new_ledger(config);
        let secret = [0x04u8; 32];

        // Fill epoch 1
        for counter in 0..2 {
            let t = ticket_for(&secret, 1, counter, &domain);
            record_spend(&mut ledger, t).expect("should succeed");
        }
        assert_eq!(ledger.spend_count, 2);

        // Reset to epoch 2
        reset_epoch(&mut ledger, 2);
        assert_eq!(ledger.spend_count, 0);
        assert!(ledger.spent_nullifiers.is_empty());

        // Epoch-2 spends use the same counter values — nullifiers differ because epoch changed
        for counter in 0..2 {
            let t = ticket_for(&secret, 2, counter, &domain);
            record_spend(&mut ledger, t).expect("should succeed after reset");
        }
        assert_eq!(ledger.spend_count, 2);
    }

    // 6 -----------------------------------------------------------------------
    #[test]
    fn test_stats_json_hides_nullifiers() {
        let config = make_config(5, 1);
        let domain = config.domain;
        let epoch = config.epoch;
        let mut ledger = new_ledger(config);
        let secret = [0xFFu8; 32];

        let t = ticket_for(&secret, epoch, 0, &domain);
        let nullifier_hex = hex_encode(&t.nullifier);
        record_spend(&mut ledger, t).expect("spend succeeds");

        let json = ledger_stats_json(&ledger);
        assert!(
            !json.contains(&nullifier_hex),
            "stats JSON must not contain nullifier hex: {}",
            nullifier_hex
        );
        // Sanity: JSON does contain expected fields
        assert!(json.contains("\"spend_count\":1"));
        assert!(json.contains("\"mainnet_ready\":false"));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_false() {
        let ledger = new_ledger(make_config(5, 1));
        assert!(!ledger.mainnet_ready);
    }

    #[test]
    fn test_nullifier_nonzero() {
        let secret = [0xABu8; 32];
        let domain = *b"testdmn1";
        let n = generate_spend_nullifier(&secret, 1, 0, &domain);
        assert_ne!(n, [0u8; 32]);
    }

    #[test]
    fn test_nullifier_epoch_sensitive() {
        let secret = [0x01u8; 32];
        let domain = *b"testdmn1";
        let n1 = generate_spend_nullifier(&secret, 1, 0, &domain);
        let n2 = generate_spend_nullifier(&secret, 2, 0, &domain);
        assert_ne!(n1, n2, "different epoch must produce different nullifier");
    }

    #[test]
    fn test_nullifier_counter_sensitive() {
        let secret = [0x02u8; 32];
        let domain = *b"testdmn1";
        let n1 = generate_spend_nullifier(&secret, 1, 0, &domain);
        let n2 = generate_spend_nullifier(&secret, 1, 1, &domain);
        assert_ne!(n1, n2, "different counter must produce different nullifier");
    }

    #[test]
    fn test_nullifier_domain_sensitive() {
        let secret = [0x03u8; 32];
        let n1 = generate_spend_nullifier(&secret, 1, 0, b"domain_a");
        let n2 = generate_spend_nullifier(&secret, 1, 0, b"domain_b");
        assert_ne!(n1, n2, "different domain must produce different nullifier");
    }

    #[test]
    fn test_verify_under_quota_initial() {
        let ledger = new_ledger(make_config(5, 1));
        assert!(
            verify_under_quota(&ledger),
            "empty ledger must be under quota"
        );
    }

    #[test]
    fn test_verify_under_quota_at_max() {
        let config = make_config(3, 1);
        let domain = config.domain;
        let epoch = config.epoch;
        let mut ledger = new_ledger(config);
        let secret = [0x10u8; 32];
        for counter in 0..3 {
            let t = ticket_for(&secret, epoch, counter, &domain);
            record_spend(&mut ledger, t).unwrap();
        }
        assert_eq!(ledger.spend_count, 3);
        // spend_count (3) <= max_per_epoch (3) → true
        assert!(verify_under_quota(&ledger));
    }

    #[test]
    fn test_wrong_domain_rejected() {
        let config = make_config(10, 1);
        let epoch = config.epoch;
        let mut ledger = new_ledger(config);
        let secret = [0x20u8; 32];
        let wrong_domain = *b"wrongdmn";
        let t = SpendTicket {
            nullifier: generate_spend_nullifier(&secret, epoch, 0, &wrong_domain),
            epoch,
            domain: wrong_domain,
            remaining_after: 0,
        };
        assert_eq!(
            record_spend(&mut ledger, t).unwrap_err(),
            RateLimitError::WrongDomain
        );
    }

    #[test]
    fn test_stats_json_has_expected_fields() {
        let config = make_config(5, 42);
        let domain = config.domain;
        let epoch = config.epoch;
        let mut ledger = new_ledger(config);
        let secret = [0x30u8; 32];
        let t = ticket_for(&secret, epoch, 0, &domain);
        record_spend(&mut ledger, t).unwrap();
        let json = ledger_stats_json(&ledger);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["spend_count"], 1u64);
        assert_eq!(v["epoch"], 42u64);
        assert_eq!(v["mainnet_ready"], false);
        assert_eq!(v["max_per_epoch"], 5u64);
    }

    #[test]
    fn test_epoch_reset_updates_epoch() {
        let config = make_config(5, 10);
        let mut ledger = new_ledger(config);
        reset_epoch(&mut ledger, 20);
        assert_eq!(ledger.config.epoch, 20);
        assert_eq!(ledger.spend_count, 0);
    }
}
