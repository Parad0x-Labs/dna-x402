use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolStatsV2 {
    pub crate_count: u32,
    pub total_tests: u32,
    pub ts_test_files: u32,
    pub wave_count: u8,
    pub zk_proof_types: u32,
    pub version: &'static str,
    pub stats_hash: [u8; 32],
    pub mainnet_ready: bool,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

/// Compute stats_hash:
/// SHA256("stats-v2" || crate_count_le || total_tests_le || ts_test_files_le || wave_count_as_u32_le)
fn compute_stats_hash(
    crate_count: u32,
    total_tests: u32,
    ts_test_files: u32,
    wave_count: u8,
) -> [u8; 32] {
    let wave_u32 = wave_count as u32;
    sha256_multi(&[
        b"stats-v2",
        &crate_count.to_le_bytes(),
        &total_tests.to_le_bytes(),
        &ts_test_files.to_le_bytes(),
        &wave_u32.to_le_bytes(),
    ])
}

// ── API ────────────────────────────────────────────────────────────────────

/// Returns the current protocol statistics for Wave 16.
pub fn current_stats_v2() -> ProtocolStatsV2 {
    let crate_count = 160u32;
    let total_tests = 960u32;
    let ts_test_files = 80u32;
    let wave_count = 16u8;
    let zk_proof_types = 20u32;
    let version = "0.2.0";

    let stats_hash = compute_stats_hash(crate_count, total_tests, ts_test_files, wave_count);

    ProtocolStatsV2 {
        crate_count,
        total_tests,
        ts_test_files,
        wave_count,
        zk_proof_types,
        version,
        stats_hash,
        mainnet_ready: false,
    }
}

/// Returns a JSON record with all fields (stats_hash as hex).
pub fn stats_v2_record(stats: &ProtocolStatsV2) -> String {
    serde_json::json!({
        "crate_count": stats.crate_count,
        "total_tests": stats.total_tests,
        "ts_test_files": stats.ts_test_files,
        "wave_count": stats.wave_count,
        "zk_proof_types": stats.zk_proof_types,
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

    #[test]
    fn test_crate_count_at_least_160() {
        let stats = current_stats_v2();
        assert!(
            stats.crate_count >= 160,
            "crate_count {} < 160",
            stats.crate_count
        );
    }

    #[test]
    fn test_total_tests_at_least_960() {
        let stats = current_stats_v2();
        assert!(
            stats.total_tests >= 960,
            "total_tests {} < 960",
            stats.total_tests
        );
    }

    #[test]
    fn test_wave_count_is_16() {
        let stats = current_stats_v2();
        assert_eq!(stats.wave_count, 16);
    }

    #[test]
    fn test_stats_hash_deterministic() {
        let s1 = current_stats_v2();
        let s2 = current_stats_v2();
        assert_eq!(s1.stats_hash, s2.stats_hash);

        // Verify hash is non-zero
        assert_ne!(s1.stats_hash, [0u8; 32]);

        // Verify round-trip through record
        let rec = stats_v2_record(&s1);
        let v: serde_json::Value = serde_json::from_str(&rec).unwrap();
        let expected_hex = hex32(&s1.stats_hash);
        assert_eq!(v["stats_hash"].as_str().unwrap(), expected_hex);
    }

    #[test]
    fn test_version_is_0_2_0() {
        let stats = current_stats_v2();
        assert_eq!(stats.version, "0.2.0");
    }

    #[test]
    fn test_mainnet_ready_is_false() {
        let stats = current_stats_v2();
        assert!(!stats.mainnet_ready);
        let rec = stats_v2_record(&stats);
        let v: serde_json::Value = serde_json::from_str(&rec).unwrap();
        assert_eq!(v["mainnet_ready"], false);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_zk_proof_types_at_least_10() {
        let stats = current_stats_v2();
        assert!(stats.zk_proof_types >= 10);
    }

    #[test]
    fn test_ts_test_files_nonzero() {
        let stats = current_stats_v2();
        assert!(stats.ts_test_files > 0);
    }

    #[test]
    fn test_stats_hash_nonzero() {
        let stats = current_stats_v2();
        assert_ne!(stats.stats_hash, [0u8; 32]);
    }

    #[test]
    fn test_record_has_stats_hash_key() {
        let stats = current_stats_v2();
        let rec = stats_v2_record(&stats);
        let v: serde_json::Value = serde_json::from_str(&rec).unwrap();
        assert!(v["stats_hash"].is_string());
    }

    #[test]
    fn test_record_crate_count_matches() {
        let stats = current_stats_v2();
        let v: serde_json::Value = serde_json::from_str(&stats_v2_record(&stats)).unwrap();
        assert_eq!(v["crate_count"].as_u64().unwrap(), stats.crate_count as u64);
    }

    #[test]
    fn test_record_total_tests_matches() {
        let stats = current_stats_v2();
        let v: serde_json::Value = serde_json::from_str(&stats_v2_record(&stats)).unwrap();
        assert_eq!(v["total_tests"].as_u64().unwrap(), stats.total_tests as u64);
    }

    #[test]
    fn test_record_wave_count_matches() {
        let stats = current_stats_v2();
        let v: serde_json::Value = serde_json::from_str(&stats_v2_record(&stats)).unwrap();
        assert_eq!(v["wave_count"].as_u64().unwrap(), stats.wave_count as u64);
    }

    #[test]
    fn test_record_zk_proof_types_matches() {
        let stats = current_stats_v2();
        let v: serde_json::Value = serde_json::from_str(&stats_v2_record(&stats)).unwrap();
        assert_eq!(
            v["zk_proof_types"].as_u64().unwrap(),
            stats.zk_proof_types as u64
        );
    }

    #[test]
    fn test_record_ts_test_files_matches() {
        let stats = current_stats_v2();
        let v: serde_json::Value = serde_json::from_str(&stats_v2_record(&stats)).unwrap();
        assert_eq!(
            v["ts_test_files"].as_u64().unwrap(),
            stats.ts_test_files as u64
        );
    }

    #[test]
    fn test_stats_hash_is_64_hex_chars() {
        let stats = current_stats_v2();
        let v: serde_json::Value = serde_json::from_str(&stats_v2_record(&stats)).unwrap();
        assert_eq!(v["stats_hash"].as_str().unwrap().len(), 64);
    }
}
