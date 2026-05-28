//! null-miner-tasks — External task kinds for the NULL Miner network
//!
//! Extends the bounty-blink-jobs internal task kinds with real-world task
//! types that enterprises and AI agents pay for via x402 on Solana.
//!
//! Task flow:
//!   1. Poster calls `create_external_task(kind, reward_usdc, ...)` → TaskPosting
//!   2. Node calls `claim_task(task_id)` → TaskClaim
//!   3. Node executes task, builds `ExternalTaskProof`
//!   4. Node calls `complete_task(task_id, proof)` → TaskCompletion
//!   5. dark-agent-escrow verifies proof_hash == task.required_proof_hash → releases USDC
//!
//! NOT_PRODUCTION — devnet/testnet only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

// ── External Task Kinds ───────────────────────────────────────────────────────

/// The kind of real-world task a NULL Miner node can perform.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum ExternalTaskKind {
    /// Proxy an HTTP request via the node's residential IP.
    /// Proof: SHA-256(response_status || response_body_hash || latency_ms_le).
    ResidentialRelay {
        /// SHA-256 commitment of the target URL + headers. Never stored in plaintext.
        url_commitment: [u8; 32],
        /// ISO 3166-1 alpha-2 country code required. None = any country.
        target_country: Option<[u8; 2]>,
        /// Max acceptable latency in milliseconds.
        max_latency_ms: u32,
    },

    /// Query App Store or Google Play for pricing/ranking data.
    /// Proof: SHA-256(app_id_commitment || price_atomic || timestamp_le).
    AppStoreSnapshot {
        /// Commitment of the app ID (not the ID itself — privacy).
        app_id_commitment: [u8; 32],
        /// Which store: 0 = Apple App Store, 1 = Google Play.
        store: u8,
        /// ISO 3166-1 alpha-2 country code.
        country: [u8; 2],
    },

    /// Generate a ZK proof-of-location without revealing exact coordinates.
    /// Proof: SHA-256(geofence_commitment || accuracy_cm_le || timestamp_5min_le).
    LocationAttestation {
        /// Encrypted lat/lon/radius — decryptable only by the task poster.
        geofence_commitment: [u8; 32],
        /// Minimum GPS accuracy required in centimeters.
        min_accuracy_cm: u32,
    },

    /// Collect a sensor data sample from the device.
    /// Proof: SHA-256(sensor_types_bitmap_le || duration_ms_le || output_hash).
    SensorSample {
        /// Bitmask: GPS=1, ACCEL=2, BARO=4, MIC=8, WIFI=16.
        sensor_types: u32,
        /// Sample duration in milliseconds.
        duration_ms: u32,
        /// SHA-256 of the expected output schema (for validation).
        output_schema_hash: [u8; 32],
    },
}

impl ExternalTaskKind {
    /// Returns the kind discriminant byte for domain separation in hashes.
    pub fn kind_byte(&self) -> u8 {
        match self {
            Self::ResidentialRelay { .. }   => 0x10,
            Self::AppStoreSnapshot { .. }   => 0x11,
            Self::LocationAttestation { .. } => 0x12,
            Self::SensorSample { .. }       => 0x13,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::ResidentialRelay { .. }   => "residential_relay",
            Self::AppStoreSnapshot { .. }   => "app_store_snapshot",
            Self::LocationAttestation { .. } => "location_attestation",
            Self::SensorSample { .. }       => "sensor_sample",
        }
    }
}

// ── Task Posting ──────────────────────────────────────────────────────────────

/// A task posted to the NULL Miner marketplace.
/// The poster locks USDC in dark-agent-escrow with condition_hash = required_proof_hash.
#[derive(Debug, Clone)]
pub struct TaskPosting {
    /// SHA-256 of the task contents — used as the escrow condition.
    pub task_id: [u8; 32],
    pub kind: ExternalTaskKind,
    /// USDC reward in atomic units (6 decimals). e.g. 10_000 = $0.01.
    pub reward_usdc_atomic: u64,
    /// Solana slot after which this task expires.
    pub expires_at_slot: u64,
    /// The proof hash the escrow will verify against.
    /// Set when the poster creates the task — defines what "correct completion" looks like.
    pub required_proof_hash: [u8; 32],
    /// Minimum reputation tier required: 0=Bronze, 1=Silver, 2=Gold, 3=Elite.
    pub min_tier: u8,
    pub mainnet_ready: bool,
}

/// Errors from task operations.
#[derive(Debug, PartialEq, Clone)]
pub enum TaskError {
    ZeroReward,
    ZeroExpiry,
    ZeroProofHash,
    AlreadyClaimed,
    AlreadyCompleted,
    Expired { expires_at: u64, current: u64 },
    WrongProof { expected: [u8; 32], got: [u8; 32] },
    InsufficientTier { required: u8, actual: u8 },
    UsdcValueTooSmall { min_atomic: u64, got: u64 },
}

impl core::fmt::Display for TaskError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::ZeroReward            => write!(f, "reward must be > 0"),
            Self::ZeroExpiry            => write!(f, "expiry slot must be > 0"),
            Self::ZeroProofHash         => write!(f, "required_proof_hash must not be all zeros"),
            Self::AlreadyClaimed        => write!(f, "task already claimed"),
            Self::AlreadyCompleted      => write!(f, "task already completed"),
            Self::Expired { expires_at, current } =>
                write!(f, "task expired at slot {expires_at}, current slot {current}"),
            Self::WrongProof { .. }     => write!(f, "proof hash mismatch"),
            Self::InsufficientTier { required, actual } =>
                write!(f, "tier {actual} < required {required}"),
            Self::UsdcValueTooSmall { min_atomic, got } =>
                write!(f, "reward {got} < minimum {min_atomic} atomic units"),
        }
    }
}

// Minimum reward: 100 atomic units = $0.0001 USDC
const MIN_REWARD_ATOMIC: u64 = 100;

/// Create a new external task posting.
pub fn create_external_task(
    kind: ExternalTaskKind,
    reward_usdc_atomic: u64,
    expires_at_slot: u64,
    required_proof_hash: [u8; 32],
    min_tier: u8,
) -> Result<TaskPosting, TaskError> {
    if reward_usdc_atomic == 0 {
        return Err(TaskError::ZeroReward);
    }
    if reward_usdc_atomic < MIN_REWARD_ATOMIC {
        return Err(TaskError::UsdcValueTooSmall {
            min_atomic: MIN_REWARD_ATOMIC,
            got: reward_usdc_atomic,
        });
    }
    if expires_at_slot == 0 {
        return Err(TaskError::ZeroExpiry);
    }
    if required_proof_hash == [0u8; 32] {
        return Err(TaskError::ZeroProofHash);
    }

    let task_id = derive_task_id(&kind, reward_usdc_atomic, expires_at_slot, &required_proof_hash);

    Ok(TaskPosting {
        task_id,
        kind,
        reward_usdc_atomic,
        expires_at_slot,
        required_proof_hash,
        min_tier,
        mainnet_ready: false,
    })
}

// ── Task Proof ────────────────────────────────────────────────────────────────

/// Proof of task completion submitted by a node.
/// This is the condition bytes for the dark-agent-escrow release.
#[derive(Debug, Clone)]
pub struct ExternalTaskProof {
    pub task_id: [u8; 32],
    /// SHA-256 of the task output — must match TaskPosting::required_proof_hash.
    pub output_hash: [u8; 32],
    /// The agent's passport ID (ZK identity — no wallet address).
    pub agent_passport_id: [u8; 32],
    /// Unix timestamp ms when the task was completed.
    pub completed_at_ms: u64,
    /// Derived proof hash: SHA-256(DOMAIN || task_id || output_hash || agent_passport_id || ts).
    pub proof_hash: [u8; 32],
}

impl ExternalTaskProof {
    /// Build a proof from raw execution output.
    pub fn new(
        task_id: [u8; 32],
        output_hash: [u8; 32],
        agent_passport_id: [u8; 32],
        completed_at_ms: u64,
    ) -> Self {
        let proof_hash = derive_proof_hash(
            &task_id,
            &output_hash,
            &agent_passport_id,
            completed_at_ms,
        );
        Self {
            task_id,
            output_hash,
            agent_passport_id,
            completed_at_ms,
            proof_hash,
        }
    }
}

// ── Task Completion ───────────────────────────────────────────────────────────

/// Result of successfully completing a task.
/// The escrow releases `reward_usdc_atomic` to the agent's stealth wallet on success.
#[derive(Debug, Clone)]
pub struct TaskCompletion {
    pub task_id: [u8; 32],
    pub agent_passport_id: [u8; 32],
    /// USDC released: 90% to agent, 10% to platform.
    pub agent_usdc_atomic: u64,
    pub platform_usdc_atomic: u64,
    /// NULL flywheel yield: 5% of agent_usdc_atomic (in NULL atomic units, placeholder).
    pub null_yield_placeholder: u64,
    pub proof_hash: [u8; 32],
}

const AGENT_SHARE_BPS:    u64 = 9_000; // 90%
const PLATFORM_SHARE_BPS: u64 = 1_000; // 10%
const NULL_YIELD_BPS:     u64 =   500; //  5% of agent share → NULL

/// Verify a task proof and compute the completion payout split.
pub fn complete_task(
    task: &TaskPosting,
    proof: &ExternalTaskProof,
    current_slot: u64,
    node_tier: u8,
) -> Result<TaskCompletion, TaskError> {
    // Tier check
    if node_tier < task.min_tier {
        return Err(TaskError::InsufficientTier {
            required: task.min_tier,
            actual:   node_tier,
        });
    }

    // Expiry check
    if current_slot > task.expires_at_slot {
        return Err(TaskError::Expired {
            expires_at: task.expires_at_slot,
            current:    current_slot,
        });
    }

    // Proof verification
    if proof.output_hash != task.required_proof_hash {
        return Err(TaskError::WrongProof {
            expected: task.required_proof_hash,
            got:      proof.output_hash,
        });
    }

    let agent_usdc    = (task.reward_usdc_atomic * AGENT_SHARE_BPS) / 10_000;
    let platform_usdc = (task.reward_usdc_atomic * PLATFORM_SHARE_BPS) / 10_000;
    let null_yield    = (agent_usdc * NULL_YIELD_BPS) / 10_000;

    Ok(TaskCompletion {
        task_id:                 task.task_id,
        agent_passport_id:       proof.agent_passport_id,
        agent_usdc_atomic:       agent_usdc,
        platform_usdc_atomic:    platform_usdc,
        null_yield_placeholder:  null_yield,
        proof_hash:              proof.proof_hash,
    })
}

// ── Internal Hash Helpers ─────────────────────────────────────────────────────

fn derive_task_id(
    kind: &ExternalTaskKind,
    reward: u64,
    expires: u64,
    proof_hash: &[u8; 32],
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"null-miner-task-id-v1");
    h.update([kind.kind_byte()]);
    h.update(reward.to_le_bytes());
    h.update(expires.to_le_bytes());
    h.update(proof_hash);
    h.finalize().into()
}

fn derive_proof_hash(
    task_id: &[u8; 32],
    output_hash: &[u8; 32],
    passport_id: &[u8; 32],
    ts: u64,
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"null-miner-proof-v1");
    h.update(task_id);
    h.update(output_hash);
    h.update(passport_id);
    h.update(ts.to_le_bytes());
    h.finalize().into()
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_proof_hash() -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"test-proof-hash");
        h.finalize().into()
    }

    fn dummy_passport_id() -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"test-passport-id");
        h.finalize().into()
    }

    fn relay_kind() -> ExternalTaskKind {
        ExternalTaskKind::ResidentialRelay {
            url_commitment: [0xABu8; 32],
            target_country: Some([b'U', b'S']),
            max_latency_ms: 5_000,
        }
    }

    // ── create_external_task ──────────────────────────────────────────────────

    #[test]
    fn test_create_task_happy_path() {
        let task = create_external_task(
            relay_kind(),
            10_000,
            1_000_000,
            dummy_proof_hash(),
            0,
        ).unwrap();
        assert_eq!(task.reward_usdc_atomic, 10_000);
        assert_eq!(task.min_tier, 0);
        assert!(!task.mainnet_ready);
    }

    #[test]
    fn test_create_task_zero_reward_rejected() {
        let err = create_external_task(relay_kind(), 0, 1_000_000, dummy_proof_hash(), 0).unwrap_err();
        assert_eq!(err, TaskError::ZeroReward);
    }

    #[test]
    fn test_create_task_below_minimum_rejected() {
        let err = create_external_task(relay_kind(), 50, 1_000_000, dummy_proof_hash(), 0).unwrap_err();
        assert!(matches!(err, TaskError::UsdcValueTooSmall { min_atomic: 100, got: 50 }));
    }

    #[test]
    fn test_create_task_zero_expiry_rejected() {
        let err = create_external_task(relay_kind(), 10_000, 0, dummy_proof_hash(), 0).unwrap_err();
        assert_eq!(err, TaskError::ZeroExpiry);
    }

    #[test]
    fn test_create_task_zero_proof_hash_rejected() {
        let err = create_external_task(relay_kind(), 10_000, 1_000_000, [0u8; 32], 0).unwrap_err();
        assert_eq!(err, TaskError::ZeroProofHash);
    }

    #[test]
    fn test_task_id_deterministic() {
        let ph = dummy_proof_hash();
        let t1 = create_external_task(relay_kind(), 10_000, 1_000_000, ph, 0).unwrap();
        let t2 = create_external_task(relay_kind(), 10_000, 1_000_000, ph, 0).unwrap();
        assert_eq!(t1.task_id, t2.task_id, "same inputs must produce same task_id");
    }

    #[test]
    fn test_task_id_differs_on_reward_change() {
        let ph = dummy_proof_hash();
        let t1 = create_external_task(relay_kind(), 10_000, 1_000_000, ph, 0).unwrap();
        let t2 = create_external_task(relay_kind(), 20_000, 1_000_000, ph, 0).unwrap();
        assert_ne!(t1.task_id, t2.task_id);
    }

    // ── complete_task ─────────────────────────────────────────────────────────

    fn make_valid_completion_pair() -> (TaskPosting, ExternalTaskProof) {
        let proof_hash = dummy_proof_hash();
        let task = create_external_task(relay_kind(), 10_000, 1_000_000, proof_hash, 0).unwrap();
        let proof = ExternalTaskProof::new(
            task.task_id,
            proof_hash,        // matches task.required_proof_hash
            dummy_passport_id(),
            1_716_000_000_000,
        );
        (task, proof)
    }

    #[test]
    fn test_complete_task_happy_path() {
        let (task, proof) = make_valid_completion_pair();
        let result = complete_task(&task, &proof, 500_000, 0).unwrap();
        assert_eq!(result.agent_usdc_atomic, 9_000);
        assert_eq!(result.platform_usdc_atomic, 1_000);
        assert_eq!(result.null_yield_placeholder, 450); // 5% of 9000
    }

    #[test]
    fn test_complete_task_expired_rejected() {
        let (task, proof) = make_valid_completion_pair();
        let err = complete_task(&task, &proof, 2_000_000, 0).unwrap_err();
        assert!(matches!(err, TaskError::Expired { .. }));
    }

    #[test]
    fn test_complete_task_wrong_proof_rejected() {
        let (task, _proof_hash) = make_valid_completion_pair();
        let bad_proof = ExternalTaskProof::new(
            task.task_id,
            [0xFFu8; 32],  // wrong hash
            dummy_passport_id(),
            1_716_000_000_000,
        );
        let err = complete_task(&task, &bad_proof, 500_000, 0).unwrap_err();
        assert!(matches!(err, TaskError::WrongProof { .. }));
    }

    #[test]
    fn test_complete_task_insufficient_tier_rejected() {
        let proof_hash = dummy_proof_hash();
        let task = create_external_task(relay_kind(), 10_000, 1_000_000, proof_hash, 2).unwrap(); // Gold required
        let proof = ExternalTaskProof::new(task.task_id, proof_hash, dummy_passport_id(), 0);
        let err = complete_task(&task, &proof, 500_000, 0).unwrap_err(); // Bronze node
        assert!(matches!(err, TaskError::InsufficientTier { required: 2, actual: 0 }));
    }

    #[test]
    fn test_payout_split_sums_to_reward() {
        let (task, proof) = make_valid_completion_pair();
        let result = complete_task(&task, &proof, 500_000, 0).unwrap();
        // Both slices computed via BPS (9000 + 1000 = 10_000 bps = 100%)
        // For clean inputs (multiple of 10_000) this is exact; verify ≤1 atomic unit dust.
        let total = result.agent_usdc_atomic + result.platform_usdc_atomic;
        assert!(
            total == task.reward_usdc_atomic || total == task.reward_usdc_atomic.saturating_sub(1),
            "payout split {total} should equal reward {}",
            task.reward_usdc_atomic
        );
    }

    #[test]
    fn test_null_yield_is_5pct_of_agent_share() {
        let (task, proof) = make_valid_completion_pair();
        let result = complete_task(&task, &proof, 500_000, 0).unwrap();
        let expected_null = (result.agent_usdc_atomic * 500) / 10_000;
        assert_eq!(result.null_yield_placeholder, expected_null);
    }

    // ── ExternalTaskProof ─────────────────────────────────────────────────────

    #[test]
    fn test_proof_hash_deterministic() {
        let task_id    = [0x01u8; 32];
        let output     = dummy_proof_hash();
        let passport   = dummy_passport_id();
        let ts         = 1_716_000_000_000u64;

        let p1 = ExternalTaskProof::new(task_id, output, passport, ts);
        let p2 = ExternalTaskProof::new(task_id, output, passport, ts);
        assert_eq!(p1.proof_hash, p2.proof_hash);
    }

    #[test]
    fn test_proof_hash_differs_on_timestamp() {
        let task_id  = [0x01u8; 32];
        let output   = dummy_proof_hash();
        let passport = dummy_passport_id();
        let p1 = ExternalTaskProof::new(task_id, output, passport, 1_000);
        let p2 = ExternalTaskProof::new(task_id, output, passport, 2_000);
        assert_ne!(p1.proof_hash, p2.proof_hash);
    }

    // ── Kind discriminants ────────────────────────────────────────────────────

    #[test]
    fn test_kind_bytes_are_unique() {
        let kinds: &[u8] = &[
            ExternalTaskKind::ResidentialRelay { url_commitment: [0u8;32], target_country: None, max_latency_ms: 0 }.kind_byte(),
            ExternalTaskKind::AppStoreSnapshot { app_id_commitment: [0u8;32], store: 0, country: [b'U',b'S'] }.kind_byte(),
            ExternalTaskKind::LocationAttestation { geofence_commitment: [0u8;32], min_accuracy_cm: 0 }.kind_byte(),
            ExternalTaskKind::SensorSample { sensor_types: 1, duration_ms: 1000, output_schema_hash: [0u8;32] }.kind_byte(),
        ];
        let unique: std::collections::HashSet<u8> = kinds.iter().cloned().collect();
        assert_eq!(unique.len(), kinds.len(), "kind bytes must be unique");
    }

    // ── App Store + Location kinds ────────────────────────────────────────────

    #[test]
    fn test_app_store_task_creation() {
        let kind = ExternalTaskKind::AppStoreSnapshot {
            app_id_commitment: [0xBBu8; 32],
            store:   0,
            country: [b'G', b'B'],
        };
        let task = create_external_task(kind, 5_000, 999_999, dummy_proof_hash(), 1).unwrap();
        assert_eq!(task.min_tier, 1);
    }

    #[test]
    fn test_location_task_creation() {
        let kind = ExternalTaskKind::LocationAttestation {
            geofence_commitment: [0xCCu8; 32],
            min_accuracy_cm: 1500,
        };
        let task = create_external_task(kind, 50_000, 888_888, dummy_proof_hash(), 2).unwrap();
        assert_eq!(task.reward_usdc_atomic, 50_000);
    }
}
