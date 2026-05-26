use sha2::{Digest, Sha256};
use std::collections::HashSet;

// ─── Domain ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum LeafDomain {
    Receipt = 0x20,
    RedeemedMarker = 0x21,
    AgentPersona = 0x22,
    GiftNote = 0x23,
    ApiMeter = 0x24,
    PredictionReceipt = 0x25,
}

// ─── Core types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CompressedLeaf {
    pub domain: LeafDomain,
    pub owner_hash: [u8; 32],
    pub leaf_hash: [u8; 32],
    pub asset_or_scope_hash: [u8; 32],
    pub nullifier_hash: [u8; 32],
    pub epoch: u64,
}

impl CompressedLeaf {
    pub fn canonical_hash(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"dark_null_v1_compressed_leaf");
        h.update([self.domain.clone() as u8]);
        h.update(self.owner_hash);
        h.update(self.leaf_hash);
        h.update(self.asset_or_scope_hash);
        h.update(self.nullifier_hash);
        h.update(self.epoch.to_le_bytes());
        h.finalize().into()
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CompressedTreeUpdate {
    pub old_root: [u8; 32],
    pub new_root: [u8; 32],
    pub leaf_hash: [u8; 32],
    pub path_hash: [u8; 32],
    /// Always [0u8;32] in LocalMerkleSimulator — NOT a real ZK proof.
    pub validity_proof_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompressionBackend {
    LocalMerkleSimulator,
    LightProtocolAdapter,
    NoopRejectBackend,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompressionError {
    BackendUnavailable(String),
    DuplicateLeaf,
    LeafNotFound,
    RootMismatch,
    NullifierAlreadyRedeemed,
}

// ─── Trait ────────────────────────────────────────────────────────────────────

pub trait CompressionBackendTrait {
    fn insert_leaf(
        &mut self,
        leaf: &CompressedLeaf,
    ) -> Result<CompressedTreeUpdate, CompressionError>;
    fn prove_inclusion(
        &self,
        leaf_hash: &[u8; 32],
    ) -> Result<CompressedTreeUpdate, CompressionError>;
    fn prove_non_inclusion(&self, nullifier_hash: &[u8; 32]) -> Result<bool, CompressionError>;
    fn update_root(&mut self, update: &CompressedTreeUpdate) -> Result<[u8; 32], CompressionError>;
    fn current_root(&self) -> [u8; 32];
}

// ─── Merkle helper ────────────────────────────────────────────────────────────

pub fn merkle_root_sha256(leaves: &[[u8; 32]]) -> [u8; 32] {
    if leaves.is_empty() {
        return [0u8; 32];
    }
    if leaves.len() == 1 {
        return leaves[0];
    }
    let mut layer = leaves.to_vec();
    while layer.len() > 1 {
        let mut next = Vec::new();
        let mut i = 0;
        while i < layer.len() {
            let left = layer[i];
            let right = if i + 1 < layer.len() {
                layer[i + 1]
            } else {
                layer[i]
            };
            let mut h = Sha256::new();
            h.update(b"dark_null_v1_compressed_node");
            h.update(left);
            h.update(right);
            next.push(h.finalize().into());
            i += 2;
        }
        layer = next;
    }
    layer[0]
}

// ─── LocalMerkleSimulator ─────────────────────────────────────────────────────

/// In-memory Merkle simulator.
///
/// IMPORTANT: This is NOT real ZK Compression. There is no on-chain compressed
/// account, no Light Protocol program call, and no real validity proof.
/// `validity_proof_hash` is always `[0u8;32]`.
pub struct LocalMerkleSimulator {
    pub leaves: Vec<CompressedLeaf>,
    pub redeemed_nullifiers: HashSet<[u8; 32]>,
    pub current_root: [u8; 32],
}

impl LocalMerkleSimulator {
    pub fn new() -> Self {
        Self {
            leaves: Vec::new(),
            redeemed_nullifiers: HashSet::new(),
            current_root: [0u8; 32],
        }
    }

    fn compute_root(&self) -> [u8; 32] {
        if self.leaves.is_empty() {
            return [0u8; 32];
        }
        let hashes: Vec<[u8; 32]> = self.leaves.iter().map(|l| l.canonical_hash()).collect();
        merkle_root_sha256(&hashes)
    }

    pub fn mark_redeemed(&mut self, nullifier_hash: [u8; 32]) -> Result<(), CompressionError> {
        if self.redeemed_nullifiers.contains(&nullifier_hash) {
            return Err(CompressionError::NullifierAlreadyRedeemed);
        }
        self.redeemed_nullifiers.insert(nullifier_hash);
        Ok(())
    }
}

impl Default for LocalMerkleSimulator {
    fn default() -> Self {
        Self::new()
    }
}

impl CompressionBackendTrait for LocalMerkleSimulator {
    fn insert_leaf(
        &mut self,
        leaf: &CompressedLeaf,
    ) -> Result<CompressedTreeUpdate, CompressionError> {
        let leaf_hash = leaf.canonical_hash();
        if self.leaves.iter().any(|l| l.canonical_hash() == leaf_hash) {
            return Err(CompressionError::DuplicateLeaf);
        }
        let old_root = self.current_root;
        self.leaves.push(leaf.clone());
        self.current_root = self.compute_root();
        let mut ph = Sha256::new();
        ph.update(b"dark_null_v1_compressed_path");
        ph.update(leaf_hash);
        ph.update(old_root);
        let path_hash: [u8; 32] = ph.finalize().into();
        Ok(CompressedTreeUpdate {
            old_root,
            new_root: self.current_root,
            leaf_hash,
            path_hash,
            validity_proof_hash: [0u8; 32], // NOT a real ZK proof
        })
    }

    fn prove_inclusion(
        &self,
        leaf_hash: &[u8; 32],
    ) -> Result<CompressedTreeUpdate, CompressionError> {
        if !self.leaves.iter().any(|l| &l.canonical_hash() == leaf_hash) {
            return Err(CompressionError::LeafNotFound);
        }
        let mut ph = Sha256::new();
        ph.update(b"dark_null_v1_compressed_inclusion");
        ph.update(leaf_hash);
        ph.update(self.current_root);
        let path_hash: [u8; 32] = ph.finalize().into();
        Ok(CompressedTreeUpdate {
            old_root: self.current_root,
            new_root: self.current_root,
            leaf_hash: *leaf_hash,
            path_hash,
            validity_proof_hash: [0u8; 32], // NOT a real ZK proof
        })
    }

    fn prove_non_inclusion(&self, nullifier_hash: &[u8; 32]) -> Result<bool, CompressionError> {
        let exists = self
            .leaves
            .iter()
            .any(|l| &l.nullifier_hash == nullifier_hash);
        Ok(!exists)
    }

    fn update_root(&mut self, update: &CompressedTreeUpdate) -> Result<[u8; 32], CompressionError> {
        if update.old_root != self.current_root {
            return Err(CompressionError::RootMismatch);
        }
        self.current_root = update.new_root;
        Ok(self.current_root)
    }

    fn current_root(&self) -> [u8; 32] {
        self.current_root
    }
}

// ─── LightProtocolAdapter (BLOCKED) ───────────────────────────────────────────

pub const BLOCKER_LIGHT_PROTOCOL: &str =
    "BLOCKED_EXTERNAL_DEPENDENCY: Light Protocol SDK not installed. See https://www.zkcompression.com/";

/// Stub adapter for Light Protocol / real ZK Compression.
///
/// Every method returns `BackendUnavailable` until the Light Protocol SDK is
/// installed and this adapter is wired to it.
pub struct LightProtocolAdapter;

impl CompressionBackendTrait for LightProtocolAdapter {
    fn insert_leaf(
        &mut self,
        _leaf: &CompressedLeaf,
    ) -> Result<CompressedTreeUpdate, CompressionError> {
        Err(CompressionError::BackendUnavailable(
            BLOCKER_LIGHT_PROTOCOL.into(),
        ))
    }

    fn prove_inclusion(
        &self,
        _leaf_hash: &[u8; 32],
    ) -> Result<CompressedTreeUpdate, CompressionError> {
        Err(CompressionError::BackendUnavailable(
            BLOCKER_LIGHT_PROTOCOL.into(),
        ))
    }

    fn prove_non_inclusion(&self, _nullifier_hash: &[u8; 32]) -> Result<bool, CompressionError> {
        Err(CompressionError::BackendUnavailable(
            BLOCKER_LIGHT_PROTOCOL.into(),
        ))
    }

    fn update_root(
        &mut self,
        _update: &CompressedTreeUpdate,
    ) -> Result<[u8; 32], CompressionError> {
        Err(CompressionError::BackendUnavailable(
            BLOCKER_LIGHT_PROTOCOL.into(),
        ))
    }

    fn current_root(&self) -> [u8; 32] {
        [0u8; 32]
    }
}

// ─── NoopRejectBackend ────────────────────────────────────────────────────────

/// Fail-closed backend used when no backend is configured.
pub struct NoopRejectBackend;

impl CompressionBackendTrait for NoopRejectBackend {
    fn insert_leaf(
        &mut self,
        _leaf: &CompressedLeaf,
    ) -> Result<CompressedTreeUpdate, CompressionError> {
        Err(CompressionError::BackendUnavailable(
            "NoopRejectBackend: no backend configured".into(),
        ))
    }

    fn prove_inclusion(
        &self,
        _leaf_hash: &[u8; 32],
    ) -> Result<CompressedTreeUpdate, CompressionError> {
        Err(CompressionError::BackendUnavailable(
            "NoopRejectBackend".into(),
        ))
    }

    fn prove_non_inclusion(&self, _nullifier_hash: &[u8; 32]) -> Result<bool, CompressionError> {
        Err(CompressionError::BackendUnavailable(
            "NoopRejectBackend".into(),
        ))
    }

    fn update_root(
        &mut self,
        _update: &CompressedTreeUpdate,
    ) -> Result<[u8; 32], CompressionError> {
        Err(CompressionError::BackendUnavailable(
            "NoopRejectBackend".into(),
        ))
    }

    fn current_root(&self) -> [u8; 32] {
        [0u8; 32]
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_leaf(domain: LeafDomain, seed: u8, epoch: u64) -> CompressedLeaf {
        CompressedLeaf {
            domain,
            owner_hash: [seed; 32],
            leaf_hash: [seed + 1; 32],
            asset_or_scope_hash: [seed + 2; 32],
            nullifier_hash: [seed + 3; 32],
            epoch,
        }
    }

    #[test]
    fn test_simulator_empty_root_is_zeros() {
        let sim = LocalMerkleSimulator::new();
        assert_eq!(sim.current_root(), [0u8; 32]);
    }

    #[test]
    fn test_simulator_insert_changes_root() {
        let mut sim = LocalMerkleSimulator::new();
        let leaf = make_leaf(LeafDomain::Receipt, 1, 0);
        let update = sim.insert_leaf(&leaf).unwrap();
        assert_ne!(update.new_root, [0u8; 32]);
        assert_eq!(update.old_root, [0u8; 32]);
        assert_eq!(sim.current_root(), update.new_root);
    }

    #[test]
    fn test_simulator_double_insert_rejected() {
        let mut sim = LocalMerkleSimulator::new();
        let leaf = make_leaf(LeafDomain::Receipt, 2, 0);
        sim.insert_leaf(&leaf).unwrap();
        let result = sim.insert_leaf(&leaf);
        assert!(matches!(result, Err(CompressionError::DuplicateLeaf)));
    }

    #[test]
    fn test_simulator_inclusion_proof_verifies() {
        let mut sim = LocalMerkleSimulator::new();
        let leaf = make_leaf(LeafDomain::AgentPersona, 3, 1);
        let update = sim.insert_leaf(&leaf).unwrap();
        let proof = sim.prove_inclusion(&update.leaf_hash).unwrap();
        assert_eq!(proof.leaf_hash, update.leaf_hash);
        assert_eq!(proof.old_root, sim.current_root());
    }

    #[test]
    fn test_simulator_non_inclusion_verifies() {
        let mut sim = LocalMerkleSimulator::new();
        let nullifier = [0xABu8; 32];
        // not inserted yet → non-inclusion should be true
        assert_eq!(sim.prove_non_inclusion(&nullifier).unwrap(), true);
        // insert a leaf with that nullifier
        let leaf = CompressedLeaf {
            domain: LeafDomain::Receipt,
            owner_hash: [1u8; 32],
            leaf_hash: [2u8; 32],
            asset_or_scope_hash: [3u8; 32],
            nullifier_hash: nullifier,
            epoch: 0,
        };
        sim.insert_leaf(&leaf).unwrap();
        assert_eq!(sim.prove_non_inclusion(&nullifier).unwrap(), false);
    }

    #[test]
    fn test_simulator_redeemed_nullifier_rejected() {
        let mut sim = LocalMerkleSimulator::new();
        let nullifier = [0x55u8; 32];
        sim.mark_redeemed(nullifier).unwrap();
        let result = sim.mark_redeemed(nullifier);
        assert_eq!(result, Err(CompressionError::NullifierAlreadyRedeemed));
    }

    #[test]
    fn test_light_adapter_is_blocked() {
        let mut adapter = LightProtocolAdapter;
        let leaf = make_leaf(LeafDomain::Receipt, 10, 0);
        let err = adapter.insert_leaf(&leaf).unwrap_err();
        match err {
            CompressionError::BackendUnavailable(msg) => {
                assert!(msg.contains("BLOCKED_EXTERNAL_DEPENDENCY"));
            }
            other => panic!("unexpected error: {:?}", other),
        }
    }

    #[test]
    fn test_noop_backend_is_blocked() {
        let mut noop = NoopRejectBackend;
        let leaf = make_leaf(LeafDomain::ApiMeter, 11, 0);
        let err = noop.insert_leaf(&leaf).unwrap_err();
        match err {
            CompressionError::BackendUnavailable(msg) => {
                assert!(msg.contains("NoopRejectBackend"));
            }
            other => panic!("unexpected error: {:?}", other),
        }
    }

    #[test]
    fn test_merkle_root_single_leaf_equals_leaf() {
        let leaf = [0xDEu8; 32];
        assert_eq!(merkle_root_sha256(&[leaf]), leaf);
    }

    #[test]
    fn test_leaf_canonical_hash_deterministic() {
        let leaf = make_leaf(LeafDomain::GiftNote, 7, 42);
        let h1 = leaf.canonical_hash();
        let h2 = leaf.canonical_hash();
        assert_eq!(h1, h2);
        assert_ne!(h1, [0u8; 32]);
    }

    #[test]
    fn test_simulator_inclusion_proof_missing_leaf_errors() {
        let sim = LocalMerkleSimulator::new();
        let fake_hash = [0xFFu8; 32];
        let result = sim.prove_inclusion(&fake_hash);
        assert!(matches!(result, Err(CompressionError::LeafNotFound)));
    }
}
