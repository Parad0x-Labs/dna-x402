// NULL_FLYWHEEL_VAULT_V1 — premium-fee conversion → utility inventory → rewards vault
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Fee allocation is 5 bps (0.05%) of premium fee collected.
pub const DEFAULT_ALLOCATION_BPS: u64 = 5;
/// ~$50 at 4000 SOL/USD heuristic (lamports).
pub const MIN_EXECUTION_LAMPORTS: u64 = 137_500_000;
/// ~$250
pub const MAX_SINGLE_LAMPORTS: u64 = 687_500_000;
/// ~$1000
pub const MAX_DAILY_LAMPORTS: u64 = 2_750_000_000;

pub const NULL_MINT: &str = "8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum SourceKind {
    SignalRevealFee,
    RiskCheckFee,
    HintTierFee,
    SniperTaxFee,
    RitualGateFee,
    OtherPremiumFee,
}

impl SourceKind {
    fn as_byte(&self) -> u8 {
        match self {
            SourceKind::SignalRevealFee => 1,
            SourceKind::RiskCheckFee => 2,
            SourceKind::HintTierFee => 3,
            SourceKind::SniperTaxFee => 4,
            SourceKind::RitualGateFee => 5,
            SourceKind::OtherPremiumFee => 6,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum DestinationPolicy {
    /// DEFAULT — accumulate for community rewards warchest.
    RewardsVault,
    /// Off by default; requires explicit opt-in + governance vote.
    BurnVaultDisabledByDefault,
}

impl Default for DestinationPolicy {
    fn default() -> Self {
        DestinationPolicy::RewardsVault
    }
}

#[derive(Debug, Clone)]
pub struct FlywheelConfig {
    /// Default 5 (0.05%).
    pub allocation_bps: u64,
    /// ~$50
    pub min_execution_lamports: u64,
    /// ~$250
    pub max_single_lamports: u64,
    /// ~$1000
    pub max_daily_lamports: u64,
    pub destination: DestinationPolicy,
    pub null_mint: String,
    /// Always false.
    pub mainnet_ready: bool,
    /// Always false.
    pub production_claim: bool,
}

impl Default for FlywheelConfig {
    fn default() -> Self {
        FlywheelConfig {
            allocation_bps: DEFAULT_ALLOCATION_BPS,
            min_execution_lamports: MIN_EXECUTION_LAMPORTS,
            max_single_lamports: MAX_SINGLE_LAMPORTS,
            max_daily_lamports: MAX_DAILY_LAMPORTS,
            destination: DestinationPolicy::RewardsVault,
            null_mint: NULL_MINT.to_string(),
            mainnet_ready: false,
            production_claim: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PremiumFeeEvent {
    pub source: SourceKind,
    pub gross_lamports: u64,
    pub epoch: u64,
    /// SHA256("flywheel-event-v1" || source_byte || gross_lamports.to_le_bytes() || epoch.to_le_bytes())
    pub event_hash: [u8; 32],
}

impl PremiumFeeEvent {
    /// Construct a new event, computing the canonical hash automatically.
    pub fn new(source: SourceKind, gross_lamports: u64, epoch: u64) -> Self {
        let event_hash = compute_event_hash(&source, gross_lamports, epoch);
        PremiumFeeEvent {
            source,
            gross_lamports,
            epoch,
            event_hash,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AllocationResult {
    /// gross * bps / 10_000
    pub allocated_lamports: u64,
    /// gross - allocated
    pub remaining_lamports: u64,
    pub destination: DestinationPolicy,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExecutionPlan {
    pub chunks: Vec<u64>,
    pub total_lamports: u64,
    pub destination: DestinationPolicy,
    pub capped: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FlywheelError {
    BelowMinimum,
    ExceedsDailyCap,
    InvalidAllocationBps,
    BurnVaultDisabled,
    ZeroAmount,
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/// Compute SHA256("flywheel-event-v1" || source_byte || gross_lamports.to_le_bytes() || epoch.to_le_bytes())
pub fn compute_event_hash(source: &SourceKind, gross_lamports: u64, epoch: u64) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"flywheel-event-v1");
    hasher.update([source.as_byte()]);
    hasher.update(gross_lamports.to_le_bytes());
    hasher.update(epoch.to_le_bytes());
    let result = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

/// Multiply `gross_lamports` by `allocation_bps / 10_000`.
pub fn compute_allocation(config: &FlywheelConfig, gross_lamports: u64) -> AllocationResult {
    let allocated = gross_lamports.saturating_mul(config.allocation_bps) / 10_000;
    let remaining = gross_lamports.saturating_sub(allocated);
    AllocationResult {
        allocated_lamports: allocated,
        remaining_lamports: remaining,
        destination: config.destination.clone(),
    }
}

/// Push `event` to `events`, compute its allocation, and return the result.
pub fn add_fee_event(
    events: &mut Vec<PremiumFeeEvent>,
    config: &FlywheelConfig,
    event: PremiumFeeEvent,
) -> AllocationResult {
    let allocation = compute_allocation(config, event.gross_lamports);
    events.push(event);
    allocation
}

/// Sum allocations across all events.
pub fn accumulated_balance(events: &[PremiumFeeEvent], config: &FlywheelConfig) -> u64 {
    events
        .iter()
        .map(|e| e.gross_lamports.saturating_mul(config.allocation_bps) / 10_000)
        .fold(0u64, |acc, x| acc.saturating_add(x))
}

/// Return `true` if `accumulated_balance >= config.min_execution_lamports`.
pub fn threshold_met(events: &[PremiumFeeEvent], config: &FlywheelConfig) -> bool {
    accumulated_balance(events, config) >= config.min_execution_lamports
}

/// `max_daily_lamports` minus the sum of allocations for events in `epoch`.
pub fn daily_cap_remaining(events: &[PremiumFeeEvent], config: &FlywheelConfig, epoch: u64) -> u64 {
    let used: u64 = events
        .iter()
        .filter(|e| e.epoch == epoch)
        .map(|e| e.gross_lamports.saturating_mul(config.allocation_bps) / 10_000)
        .fold(0u64, |acc, x| acc.saturating_add(x));
    config.max_daily_lamports.saturating_sub(used)
}

/// Split `amount` into chunks of at most `max_chunk` lamports each.
pub fn split_into_chunks(amount: u64, max_chunk: u64) -> Vec<u64> {
    if amount == 0 || max_chunk == 0 {
        return vec![];
    }
    let mut remaining = amount;
    let mut chunks = Vec::new();
    while remaining > 0 {
        let chunk = remaining.min(max_chunk);
        chunks.push(chunk);
        remaining -= chunk;
    }
    chunks
}

/// `BurnVaultDisabledByDefault` always returns `Err(FlywheelError::BurnVaultDisabled)`.
pub fn validate_destination_policy(policy: &DestinationPolicy) -> Result<(), FlywheelError> {
    match policy {
        DestinationPolicy::RewardsVault => Ok(()),
        DestinationPolicy::BurnVaultDisabledByDefault => Err(FlywheelError::BurnVaultDisabled),
    }
}

/// Create an `ExecutionPlan`, respecting `max_single_lamports` and the daily cap.
///
/// Returns `Err(FlywheelError::BelowMinimum)` if `amount < min_execution_lamports`.
/// Returns `Err(FlywheelError::BurnVaultDisabled)` if `destination == BurnVaultDisabledByDefault`.
pub fn plan_execution(
    config: &FlywheelConfig,
    amount: u64,
    epoch_used_lamports: u64,
) -> Result<ExecutionPlan, FlywheelError> {
    // Destination check first.
    validate_destination_policy(&config.destination)?;

    if amount == 0 {
        return Err(FlywheelError::ZeroAmount);
    }
    if amount < config.min_execution_lamports {
        return Err(FlywheelError::BelowMinimum);
    }

    let daily_remaining = config
        .max_daily_lamports
        .saturating_sub(epoch_used_lamports);

    let (effective_amount, capped) = if amount > daily_remaining {
        (daily_remaining, true)
    } else {
        (amount, false)
    };

    if effective_amount == 0 {
        return Err(FlywheelError::ExceedsDailyCap);
    }

    let chunks = split_into_chunks(effective_amount, config.max_single_lamports);

    Ok(ExecutionPlan {
        total_lamports: effective_amount,
        chunks,
        destination: config.destination.clone(),
        capped,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // 1. Default config flags
    #[test]
    fn test_default_config_flags() {
        let config = FlywheelConfig::default();
        assert!(!config.mainnet_ready, "mainnet_ready must be false");
        assert!(!config.production_claim, "production_claim must be false");
        assert_eq!(config.destination, DestinationPolicy::RewardsVault);
    }

    // 2. 5 bps of 1_000_000 lamports = 500
    #[test]
    fn test_allocation_bps_correct() {
        let config = FlywheelConfig::default();
        let result = compute_allocation(&config, 1_000_000);
        assert_eq!(result.allocated_lamports, 500);
        assert_eq!(result.remaining_lamports, 999_500);
    }

    // 3. Zero gross → allocated = 0
    #[test]
    fn test_allocation_bps_zero_gross() {
        let config = FlywheelConfig::default();
        let result = compute_allocation(&config, 0);
        assert_eq!(result.allocated_lamports, 0);
        assert_eq!(result.remaining_lamports, 0);
    }

    // 4. 10 events × 1000 lamports × 5 bps = 5 lamports per event = 50 total → below MIN
    #[test]
    fn test_threshold_not_met_below_min() {
        let config = FlywheelConfig::default();
        let events: Vec<PremiumFeeEvent> = (0..10)
            .map(|i| PremiumFeeEvent::new(SourceKind::RiskCheckFee, 1_000, i))
            .collect();
        // 10 * (1000 * 5 / 10_000) = 10 * 0 = 0  (integer division floors)
        // Use a gross that gives non-zero: 1_000_000 lamports per event
        // But spec says "1000 lamports each", let's verify the exact number:
        // 1000 * 5 / 10000 = 0 (integer truncation)
        // Accumulated = 0, which is below MIN_EXECUTION_LAMPORTS.
        assert!(!threshold_met(&events, &config));
    }

    // 5. Enough events to exceed MIN_EXECUTION_LAMPORTS
    #[test]
    fn test_threshold_met_above_min() {
        let config = FlywheelConfig::default();
        // Need accumulated >= 137_500_000 lamports via 5 bps allocation.
        // allocated_per_event = gross * 5 / 10_000
        // To reach 137_500_000: gross_per_event = 137_500_000 * 10_000 / 5 = 275_000_000_000
        // Use one large event.
        let events = vec![PremiumFeeEvent::new(
            SourceKind::SignalRevealFee,
            275_000_000_000,
            1,
        )];
        assert!(threshold_met(&events, &config));
    }

    // 6. Fresh epoch → remaining == MAX_DAILY_LAMPORTS
    #[test]
    fn test_daily_cap_remaining_full_when_no_spend() {
        let config = FlywheelConfig::default();
        let events: Vec<PremiumFeeEvent> = vec![];
        let remaining = daily_cap_remaining(&events, &config, 42);
        assert_eq!(remaining, MAX_DAILY_LAMPORTS);
    }

    // 7. plan_execution with 1000 lamports → BelowMinimum
    #[test]
    fn test_plan_execution_below_minimum_errors() {
        let config = FlywheelConfig::default();
        let result = plan_execution(&config, 1_000, 0);
        assert_eq!(result, Err(FlywheelError::BelowMinimum));
    }

    // 8. amount > MAX_SINGLE_LAMPORTS → multiple chunks
    #[test]
    fn test_plan_execution_splits_chunks() {
        let config = FlywheelConfig::default();
        // Use 2 × MAX_SINGLE_LAMPORTS so we get exactly 2 equal chunks.
        let amount = MAX_SINGLE_LAMPORTS * 2;
        let plan = plan_execution(&config, amount, 0).expect("should succeed");
        assert_eq!(plan.chunks.len(), 2);
        assert_eq!(plan.chunks[0], MAX_SINGLE_LAMPORTS);
        assert_eq!(plan.chunks[1], MAX_SINGLE_LAMPORTS);
        assert_eq!(plan.total_lamports, amount);
        assert!(!plan.capped);
    }

    // 9. validate_destination_policy(BurnVaultDisabledByDefault) → Err(BurnVaultDisabled)
    #[test]
    fn test_burn_vault_disabled_by_default() {
        let result = validate_destination_policy(&DestinationPolicy::BurnVaultDisabledByDefault);
        assert_eq!(result, Err(FlywheelError::BurnVaultDisabled));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_event_hash_nonzero() {
        let hash = compute_event_hash(&SourceKind::RiskCheckFee, 1_000_000, 1);
        assert_ne!(hash, [0u8; 32]);
    }

    #[test]
    fn test_event_hash_source_sensitive() {
        let h1 = compute_event_hash(&SourceKind::RiskCheckFee, 1_000_000, 1);
        let h2 = compute_event_hash(&SourceKind::SignalRevealFee, 1_000_000, 1);
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_split_chunks_exact_fit() {
        let chunks = split_into_chunks(100, 100);
        assert_eq!(chunks, vec![100]);
    }

    #[test]
    fn test_split_chunks_zero_amount() {
        let chunks = split_into_chunks(0, 100);
        assert!(chunks.is_empty());
    }

    #[test]
    fn test_plan_execution_burn_vault_rejected() {
        let mut config = FlywheelConfig::default();
        config.destination = DestinationPolicy::BurnVaultDisabledByDefault;
        let result = plan_execution(&config, MIN_EXECUTION_LAMPORTS, 0);
        assert_eq!(result, Err(FlywheelError::BurnVaultDisabled));
    }

    #[test]
    fn test_daily_cap_remaining_decreases_after_event() {
        let config = FlywheelConfig::default();
        let event = PremiumFeeEvent::new(SourceKind::HintTierFee, 1_000_000_000, 1);
        let events = vec![event];
        let remaining = daily_cap_remaining(&events, &config, 1);
        assert!(remaining < MAX_DAILY_LAMPORTS);
    }

    #[test]
    fn test_null_mint_nonempty() {
        assert!(!NULL_MINT.is_empty());
        // NULL_MINT must be a plausible Solana address (32-44 base58 chars)
        assert!(NULL_MINT.len() >= 32 && NULL_MINT.len() <= 44);
    }
}
