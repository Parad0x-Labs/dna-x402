use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolStatsV3 {
    pub crate_count: u32,
    pub total_tests: u32,
    pub total_privacy_primitives: u32,
    pub zk_proof_types: u32,
    pub wave_count: u32,
    pub version: String,
    pub stats_hash: [u8; 32],
    pub mainnet_ready: bool,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts { h.update(p); }
    h.finalize().into()
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn compute_stats_hash(crate_count: u32, total_tests: u32, primitives: u32) -> [u8; 32] {
    sha256_multi(&[
        b"stats-v3",
        &crate_count.to_le_bytes(),
        &total_tests.to_le_bytes(),
        &primitives.to_le_bytes(),
    ])
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn current_stats() -> ProtocolStatsV3 {
    let crate_count = 190u32;
    let total_tests = 1140u32;
    let total_privacy_primitives = 100u32;
    let zk_proof_types = 20u32;
    let wave_count = 19u32;
    let version = "0.3.0".to_string();
    let stats_hash = compute_stats_hash(crate_count, total_tests, total_privacy_primitives);
    ProtocolStatsV3 {
        crate_count,
        total_tests,
        total_privacy_primitives,
        zk_proof_types,
        wave_count,
        version,
        stats_hash,
        mainnet_ready: false,
    }
}

pub fn stats_v3_record(stats: &ProtocolStatsV3) -> String {
    serde_json::json!({
        "crate_count": stats.crate_count,
        "total_tests": stats.total_tests,
        "total_privacy_primitives": stats.total_privacy_primitives,
        "zk_proof_types": stats.zk_proof_types,
        "wave_count": stats.wave_count,
        "version": stats.version,
        "stats_hash": hex32(&stats.stats_hash),
        "mainnet_ready": stats.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Test 1: crate_count >= 190
    #[test]
    fn test_crate_count_at_least_190() {
        let stats = current_stats();
        assert!(stats.crate_count >= 190, "crate_count {} < 190", stats.crate_count);
    }

    // Test 2: total_tests >= 1140
    #[test]
    fn test_total_tests_at_least_1140() {
        let stats = current_stats();
        assert!(stats.total_tests >= 1140, "total_tests {} < 1140", stats.total_tests);
    }

    // Test 3: zk_proof_types >= 10
    #[test]
    fn test_zk_proof_types_at_least_10() {
        let stats = current_stats();
        assert!(stats.zk_proof_types >= 10, "zk_proof_types {} < 10", stats.zk_proof_types);
    }

    // Test 4: wave_count = 19
    #[test]
    fn test_wave_count_is_19() {
        let stats = current_stats();
        assert_eq!(stats.wave_count, 19);
    }

    // Test 5: stats_hash is deterministic and non-zero
    #[test]
    fn test_stats_hash_deterministic_and_nonzero() {
        let s1 = current_stats();
        let s2 = current_stats();
        assert_eq!(s1.stats_hash, s2.stats_hash);
        assert_ne!(s1.stats_hash, [0u8; 32]);
        // Verify hex round-trip
        let rec = stats_v3_record(&s1);
        let v: serde_json::Value = serde_json::from_str(&rec).unwrap();
        assert_eq!(v["stats_hash"].as_str().unwrap(), hex32(&s1.stats_hash));
    }

    // Test 6: public record contains version / mainnet_ready=false
    #[test]
    fn test_public_record_version_and_mainnet_ready() {
        let stats = current_stats();
        assert!(!stats.mainnet_ready);
        assert_eq!(stats.version, "0.3.0");
        let rec = stats_v3_record(&stats);
        let v: serde_json::Value = serde_json::from_str(&rec).unwrap();
        assert_eq!(v["version"].as_str().unwrap(), "0.3.0");
        assert_eq!(v["mainnet_ready"], false);
    }
}
