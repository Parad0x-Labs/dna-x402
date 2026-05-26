use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

fn sha256_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for input in inputs {
        h.update(input);
    }
    h.finalize().into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShapeObservation {
    pub shape_hash: [u8; 32],
    pub timestamp_slot: u64,
    pub observer_id_hash: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShapeMarket {
    pub observations: Vec<ShapeObservation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ShapeRiskLevel {
    Safe,         // k >= 5
    LowAnonymity, // 2 <= k < 5
    Doxxed,       // k == 1 (unique) or k == 0 (never seen)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KShapeReport {
    pub shape_hash: [u8; 32],
    pub k_shape: usize,
    pub risk_level: ShapeRiskLevel,
}

// ── ShapeMarket impl ──────────────────────────────────────────────────────────

impl ShapeMarket {
    pub fn new() -> Self {
        ShapeMarket {
            observations: Vec::new(),
        }
    }

    pub fn observe(&mut self, obs: ShapeObservation) {
        self.observations.push(obs);
    }

    pub fn k_shape(&self, shape_hash: &[u8; 32]) -> usize {
        self.observations
            .iter()
            .filter(|o| &o.shape_hash == shape_hash)
            .count()
    }

    pub fn is_unique(&self, shape_hash: &[u8; 32]) -> bool {
        self.k_shape(shape_hash) == 1
    }

    pub fn report(&self, shape_hash: &[u8; 32]) -> KShapeReport {
        let k = self.k_shape(shape_hash);
        let risk_level = if k >= 5 {
            ShapeRiskLevel::Safe
        } else if k >= 2 {
            ShapeRiskLevel::LowAnonymity
        } else {
            // k == 0 or k == 1
            ShapeRiskLevel::Doxxed
        };
        KShapeReport {
            shape_hash: *shape_hash,
            k_shape: k,
            risk_level,
        }
    }

    pub fn can_join_class(&self, candidate_hash: &[u8; 32], target_shape: &[u8; 32]) -> bool {
        candidate_hash == target_shape
    }
}

impl Default for ShapeMarket {
    fn default() -> Self {
        Self::new()
    }
}

// ── Free functions ────────────────────────────────────────────────────────────

/// Compute a shape_hash from ritual type label + ordered step names.
/// SHA256("dark_null_v1_shape_class" || ritual_type_bytes || step0 || step1 || ...)
pub fn compute_class_hash(ritual_type_label: &str, step_names: &[&str]) -> [u8; 32] {
    let mut inputs: Vec<&[u8]> = Vec::with_capacity(1 + step_names.len());
    inputs.push(ritual_type_label.as_bytes());
    for name in step_names {
        inputs.push(name.as_bytes());
    }
    sha256_domain(b"dark_null_v1_shape_class", &inputs)
}

// ── Suppress unused-import warnings for HashMap if not used elsewhere ─────────
#[allow(dead_code)]
fn _use_hashmap() -> HashMap<[u8; 32], usize> {
    HashMap::new()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn obs(shape_hash: [u8; 32]) -> ShapeObservation {
        ShapeObservation {
            shape_hash,
            timestamp_slot: 0,
            observer_id_hash: [0u8; 32],
        }
    }

    #[test]
    fn test_identical_observations_increment_k() {
        let mut market = ShapeMarket::new();
        let hash = [0x01u8; 32];
        market.observe(obs(hash));
        market.observe(obs(hash));
        market.observe(obs(hash));
        assert_eq!(market.k_shape(&hash), 3);
    }

    #[test]
    fn test_unique_shape_marked_doxxed() {
        let mut market = ShapeMarket::new();
        let hash = [0x02u8; 32];
        market.observe(obs(hash));
        assert!(market.is_unique(&hash));
        assert_eq!(market.report(&hash).risk_level, ShapeRiskLevel::Doxxed);
    }

    #[test]
    fn test_chaff_can_join_shape_class() {
        let mut market = ShapeMarket::new();
        let hash = [0x03u8; 32];
        for _ in 0..4 {
            market.observe(obs(hash));
        }
        // Chaff tx with same shape hash joins the class
        let chaff_hash = hash;
        assert!(market.can_join_class(&chaff_hash, &hash));
        market.observe(obs(chaff_hash));
        assert_eq!(market.k_shape(&hash), 5);
        assert_eq!(market.report(&hash).risk_level, ShapeRiskLevel::Safe);
    }

    #[test]
    fn test_k_shape_report_correct() {
        let mut market = ShapeMarket::new();
        let hash_a = [0xAAu8; 32];
        let hash_b = [0xBBu8; 32];
        let hash_c = [0xCCu8; 32];

        for _ in 0..6 {
            market.observe(obs(hash_a));
        }
        for _ in 0..3 {
            market.observe(obs(hash_b));
        }
        market.observe(obs(hash_c));

        assert_eq!(market.report(&hash_a).risk_level, ShapeRiskLevel::Safe);
        assert_eq!(
            market.report(&hash_b).risk_level,
            ShapeRiskLevel::LowAnonymity
        );
        assert_eq!(market.report(&hash_c).risk_level, ShapeRiskLevel::Doxxed);
    }
}
