use sha2::{Digest, Sha256};

// Domain prefixes
const DOMAIN_COMMIT: u8 = 0x50;
const DOMAIN_REVEAL: u8 = 0x51;
const DOMAIN_PAUSE: u8 = 0x52;

#[derive(Clone, Debug)]
pub struct FeatureCommit {
    pub commit_id: [u8; 32],
    pub module_hash: [u8; 32],
    pub activation_slot: u64,
    pub policy_hash: [u8; 32],
    pub committed_at_slot: u64,
}

/// SHA256(0x50 || commit_id || module_hash || activation_slot || policy_hash || committed_at_slot)
pub fn commit_hash(f: &FeatureCommit) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_COMMIT]);
    h.update(f.commit_id);
    h.update(f.module_hash);
    h.update(f.activation_slot.to_le_bytes());
    h.update(f.policy_hash);
    h.update(f.committed_at_slot.to_le_bytes());
    h.finalize().into()
}

#[derive(Clone, Debug)]
pub struct FeatureReveal {
    pub module_hash: [u8; 32],
    pub source_hash: [u8; 32],
    pub policy_hash: [u8; 32],
    pub description_hash: [u8; 32],
}

/// SHA256(0x51 || module_hash || source_hash || policy_hash || description_hash)
pub fn reveal_hash(r: &FeatureReveal) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_REVEAL]);
    h.update(r.module_hash);
    h.update(r.source_hash);
    h.update(r.policy_hash);
    h.update(r.description_hash);
    h.finalize().into()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FeatureError {
    WrongReveal,
    TooEarly,
    Paused,
}

/// Activate a feature: verify reveal matches commit's module_hash and policy_hash,
/// and that current_slot >= activation_slot.
/// Returns the activation receipt hash on success.
pub fn activate(
    commit: &FeatureCommit,
    reveal: &FeatureReveal,
    current_slot: u64,
) -> Result<[u8; 32], FeatureError> {
    // Check slot first
    if current_slot < commit.activation_slot {
        return Err(FeatureError::TooEarly);
    }
    // The reveal must match both module_hash and policy_hash from the commit
    if reveal.module_hash != commit.module_hash || reveal.policy_hash != commit.policy_hash {
        return Err(FeatureError::WrongReveal);
    }
    // Return activation receipt = SHA256(commit_hash || reveal_hash)
    let mut h = Sha256::new();
    h.update(commit_hash(commit));
    h.update(reveal_hash(reveal));
    Ok(h.finalize().into())
}

/// Marker type — a paused feature cannot activate.
#[derive(Clone, Debug)]
pub struct PausedFeature {
    pub commit_id: [u8; 32],
    _pause_hash: [u8; 32],
}

/// Pause a feature: returns a PausedFeature that carries a pause receipt.
pub fn pause(commit: &FeatureCommit) -> PausedFeature {
    let mut h = Sha256::new();
    h.update([DOMAIN_PAUSE]);
    h.update(commit.commit_id);
    h.update(commit_hash(commit));
    PausedFeature {
        commit_id: commit.commit_id,
        _pause_hash: h.finalize().into(),
    }
}

impl PausedFeature {
    /// Always returns Err(FeatureError::Paused) — paused features can never activate.
    pub fn try_activate(
        &self,
        _reveal: &FeatureReveal,
        _current_slot: u64,
    ) -> Result<[u8; 32], FeatureError> {
        Err(FeatureError::Paused)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_commit() -> FeatureCommit {
        FeatureCommit {
            commit_id: [0x01u8; 32],
            module_hash: [0x02u8; 32],
            activation_slot: 1000,
            policy_hash: [0x03u8; 32],
            committed_at_slot: 500,
        }
    }

    fn make_reveal(c: &FeatureCommit) -> FeatureReveal {
        FeatureReveal {
            module_hash: c.module_hash,
            source_hash: [0xAAu8; 32],
            policy_hash: c.policy_hash,
            description_hash: [0xBBu8; 32],
        }
    }

    #[test]
    fn test_commit_reveal_ok() {
        let c = make_commit();
        let r = make_reveal(&c);
        let receipt = activate(&c, &r, 1000).unwrap();
        assert_ne!(receipt, [0u8; 32]);
    }

    #[test]
    fn test_wrong_reveal_rejected() {
        let c = make_commit();
        let mut r = make_reveal(&c);
        r.module_hash = [0xFFu8; 32]; // wrong module
        let err = activate(&c, &r, 1000).unwrap_err();
        assert_eq!(err, FeatureError::WrongReveal);
    }

    #[test]
    fn test_too_early_rejected() {
        let c = make_commit();
        let r = make_reveal(&c);
        let err = activate(&c, &r, 999).unwrap_err(); // slot 999 < activation 1000
        assert_eq!(err, FeatureError::TooEarly);
    }

    #[test]
    fn test_activation_hash_deterministic() {
        let c = make_commit();
        let r = make_reveal(&c);
        let h1 = activate(&c, &r, 1000).unwrap();
        let h2 = activate(&c, &r, 1000).unwrap();
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_paused_cannot_activate() {
        let c = make_commit();
        let r = make_reveal(&c);
        let paused = pause(&c);
        let err = paused.try_activate(&r, 1000).unwrap_err();
        assert_eq!(err, FeatureError::Paused);
    }

    #[test]
    fn test_commit_hash_changes_with_policy() {
        let c = make_commit();
        let mut c2 = c.clone();
        c2.policy_hash = [0xFFu8; 32];
        assert_ne!(commit_hash(&c), commit_hash(&c2));
    }
}
